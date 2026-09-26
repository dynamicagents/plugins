# `@dynamicagents/plugins/computer`

A Linux container whose filesystem outlives it.

```ts
import { computer, computerWorkspace } from "@dynamicagents/plugins/computer";

const config = {
  binding: env.WORKSPACE,
  workspaceName: () => `${callerKey()}|${owner}/${repo}`,
  shell: "bash"
};

class Coder extends A2AAgent<Env> {
  override workspace = computerWorkspace(config, () =>
    this.pluginContext().runtime()
  );
  override getPlugins() {
    return [computer(config)];
  }
}
```

Tools: `bash`, `grep`, `edit` — under Think's own names, so they replace Think's
built-ins. Think's `read`, `write`, `delete`, `find` and `list` stay Think's, and
reach the container's tree through the agent's workspace.

The filesystem **is** a Durable Object's SQLite, mounted into the container over
FUSE. Commands see a normal `/workspace`, the Worker reads the same tree over RPC,
and when the container is replaced the tree is pushed into the new one — so the
checkout outlives the container that held it.

## The agent's workspace is the container's

Think's `read`, `write`, `edit` and `delete` work on whatever the agent's
`this.workspace` is. An agent that installed this plugin but kept Think's own
workspace would run `bash` in the container and `write` in its own SQLite, and
nothing would say so. So the agent sets `workspace = computerWorkspace(config, …)`,
and the plugin **refuses to start** on any other — a `PluginSetupError` naming what
to set. Its tools then reach the container through that workspace rather than
through their own config, so `bash` and Think's `write` always resolve the same one.

`computerWorkspace` reads the workspace object's filesystem directly, without
starting a container. Every call resolves the workspace the running turn names, so a
sub-agent's reaches the checkout its parent prepared. It holds this plugin's rules:
`.git` and `node_modules` are refused for reads and writes alike, a write is refused
while the workspace cannot keep it, walks prune the skipped directories, and a read
is never truncated — Think's `edit` writes back what it read. It offers no byte
writes, so Think's evicted media and projected skills never land in a checkout.

`edit` is this plugin's rather than Think's because Think's is two calls — a read,
then a write — and a lock inside the workspace cannot span them. The AI SDK runs one
step's tool calls concurrently, so two edits to one file would lose one. This `edit`
holds the file's lock across both, and a `write` through the workspace takes the
same lock.

## `node_modules` is on the container's disk

The one thing to internalise. When `npm`, `npx`, `pnpm`, `yarn`, `corepack`, `bun`
or `bunx` runs under the workspace, the `node_modules` of the package root it runs in
— or is pointed at with `--prefix`, `--cwd`, `--dir` or `-C` — becomes a bind mount
of the container's own disk. So an install never syncs: it runs at disk speed, and
the tree never crosses into the Durable Object, or back into every fresh container
before its first command runs. Workspace members are not mounted; an install at the
root puts the bulk of the tree there.

A mount point cannot be removed, so `rm -rf node_modules` empties it and then fails.
`npm ci` clears it itself.

The cost is that a new container reinstalls. Container directory snapshots are
the intended fix: restored at start, they would bring the tree back without a
reinstall.

The file tools read the workspace, so they refuse `node_modules` paths and route to
`bash`. Walks skip it with `.git`: the workspace's `glob`, which Think's `find` walks
with, passes both to the store as exclusions, so the store never walks them, and
`grep`, whose store search takes no exclusion, filters its results.

## `.git` is off limits

Present in the workspace, refused by the file tools anyway, and skipped by walks.
Reading it tells the model less than [`/repo`](../repo/) does, and writing it
corrupts the checkout. Repository work goes through the repo tools.

## Searching

`grep`, `find` and `list` read the durable workspace rather than the container, so
they keep answering while it restarts or while an install runs — which is exactly
when an agent would otherwise be blocked. `grep` is this plugin's: it searches inside
the workspace object in one call, bounds its matches at the source and reports the
`offset` that continues a cut result, where Think's own `grep` reads every file under
the root through the workspace, one call per file. `find` and `list` are Think's.

The store's search takes no exclusion, so `grep` from a checkout's root reads `.git`
too before filtering it out. Give it a `path` below the root, or an `include`.

## The container is the trust boundary

Two things run in it that nobody reviewed: the commands the model writes, and the
repository it was asked to clone. `npm ci` executes that repository's lifecycle
scripts, so "we only ran the install" is still running a stranger's code. Treat
anything inside the container as reachable by both.

Two consequences worth stating outright:

- **No secret belongs in `ComputerConfig.env`.** It is merged into every command
  these tools run, and `bash`'s command is model-authored — `bash("printenv")` prints the lot,
  and so does a `postinstall`. Use it for a registry host or a `CI` flag, not a key.
  When an agent needs to _act_ with a credential, keep the credential on the Worker
  and give the agent one tool that makes the call:
  [`/repo`](../repo/)'s `repo_open_pr` is the worked example, and its token never
  enters the container at all.
- **Egress is unrestricted.** `@cloudflare/computer`'s `WorkspaceEgressPolicy` is
  `mode: "direct"` here, so anything in the container can reach anything on the
  network. That is deliberate for now — a build needs a registry, and a coding
  agent needs the web — but it means the two paragraphs above are the whole of the
  containment. Narrowing it to an allowed-host list, with a small classifier for
  the requests that fall outside, is possible future work rather than something
  this plugin does today.
- **`grep`'s `regex` compiles a model-authored pattern** and runs it over every
  file under `path`, inside the Durable Object. A catastrophic-backtracking pattern
  therefore spends that object's CPU budget rather than the container's. The
  runtime's own limits bound it, and it costs the agent its own turn, but it is the
  one value a model supplies here that reaches a compiler.

## The host's Durable Object

**You probably do not write this.** `WorkspaceObjectBase` ships from this same
subpath — the container backend, the alarm, the dependency install, the credentialed
git — and a host subclasses it and answers a short config. [The host](#the-host) below
has that. What follows is the interface this plugin _requires_, which is what a host
bringing its own object must satisfy instead.

`binding` points at a class that owns the workspace and exposes:

- `__getWorkspaceStub()` — what `withWorkspace` from `@cloudflare/computer` installs.
  The command tools take it, so a host serves it with the container started and the
  egress CA installed.
- `__getWorkspaceFsStub()` — the same workspace for the file tools, served **without
  starting a container**. The filesystem is the object's own SQLite, while the first
  command in a _fresh_ container waits for the whole tree to be pushed across.
  Serving both the same way puts that wait in front of every `read`. A host with nothing to distinguish returns
  `__getWorkspaceStub()`; required for the reason `advisories` gives below.
- `advisories(): Promise<readonly WorkspaceAdvisory[]>` — everything currently true
  about the workspace that a caller must not assume away, or `[]`. Required rather
  than optional: a host that forgets to expose it would otherwise get a `bash`
  running against a half-built `node_modules`, or an `edit` reporting success for an
  edit the workspace threw away.

  Build it with `deriveAdvisories({ install, storage, dependencyTreePresent })` rather
  than by hand — implementing this is gathering what the host already has, not
  writing policy. Which advisories reach which commands, whether one may hold a
  command back, and how each is worded are decided here, in one place each. A host
  that renders its own wording is re-deriving severity from an error string, which
  is what this replaced.

  `dependencyTreePresent` is whether the running container holds a finished tree. It
  is reported to the reader rather than acted on: it qualifies a failure, and never
  cancels one.

  `bash` and every write consult this. `bash` waits out anything transient and warns
  about the rest; `edit` and the workspace's writes **refuse** when an advisory says
  writes do not survive, since a write has no successful outcome available there and
  reporting one is worse than refusing.

One workspace is one container is one repository, so `workspaceName` should derive
from the verified caller and the repository — never from model input, or a model
naming another caller's workspace would get that caller's files.

Sub-agents reach the parent's checkout through `WORKSPACE_RUNTIME_KEY`: the checkout
is one the parent chose, so a sub-agent cannot compute the name itself. The spec's
`prepare` puts it in `runtime()`, and the tools and the workspace read it back.

`computerExec` exports the shell alone, for [`/repo`](../repo/) — so that plugin gets
git on a real container without either importing the other. What runs through it is
`/repo`'s **unauthenticated** half: `status`, `diff`, `add`, `commit`, `checkout`. The
three operations that authenticate — clone, fetch, push — never reach the container,
so no command here carries a forge token.

It does **not** merge `env` into what it runs, deliberately: those commands are
another plugin's, and it pins the git environment they need. A host environment
underneath would let through the keys it does not pin — `GIT_CONFIG_GLOBAL`,
`GIT_EXEC_PATH` — which change what git reads and which binaries it runs. A host
that wants one anyway composes it at the call site, where the merge is visible —
see the export's own comment.

## The host

```ts
import {
  DEFAULT_INSTALL_PLAN,
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@dynamicagents/plugins/computer";

// This deployment's install commands. `DEFAULT_INSTALL_PLAN` resolves npm, pnpm
// or yarn from what the checkout contains; `overrides` is keyed `owner/repo`.
const INSTALL_PLAN = { ...DEFAULT_INSTALL_PLAN, overrides: {} };

export class Workspace extends WorkspaceObjectBase {
  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "WORKSPACE",
      label: "workspace",
      installPlan: INSTALL_PLAN,
      egress: { mode: "direct" },
      git: {
        tokenBinding: "GITHUB_TOKEN",
        author: { name: this.env.GITHUB_NAME, email: this.env.GITHUB_EMAIL }
      }
    };
  }
}
```

One subpath, deliberately: the tools and the object they address are one capability,
and a consumer who had to remember a second import is a consumer who can forget it.
The bundle cost is nothing — `sideEffects` is false, so an agent that only calls
`bash` carries no container backend and no isomorphic-git.

`git.author` answers for commits this object makes with its own git client, and it is
written into the container's system git config, so a repository the container made for
itself — a submodule, a `git init` — is attributed rather than nameless.

**`@dynamicagents/plugins/repo` takes its identity separately**, as `RepoConfig.author`,
and falls back to a generic one when a consumer leaves it unset. Nothing here can reach
that config and nothing checks the two agree, so a deployment answers both from one
place: one exported helper that reads the binding, called by the workspace object and
by the repo plugin's config alike.

`workspaceConfig()` is short because it is the complete answer to "what is different
about this agent's workspace". Everything else is inherited, and the alternative is a
second copy of a thousand-line object drifting in whichever direction the one nobody
redeployed recently went.

Three fields have no safe default:

- **`binding`** is not cosmetic and not derivable — `computerd` dials _back_ through
  it, so a wrong name produces a container that starts, mounts nothing, and fails at
  the first command without mentioning a binding.
- **`egress`** omitted means `{ mode: "none" }`: the workspace mounts, commands run,
  and the install dies on a registry it cannot reach with nothing naming egress as the
  cause. `http-gateway` puts your Worker on the container's outbound path — see
  [`/claude-code`](../claude-code/), which uses it to swap in a credential the
  container must never hold.
- **`git.tokenBinding`** names the binding rather than carrying the token, because
  `workspaceConfig()` is an ordinary method and on a Durable Object `protected` is a
  typechecker's opinion, not a runtime boundary. A config carrying the credential
  would hand it to anything holding the namespace.

### What the object owns in storage

Part of the contract, not an implementation detail: these persist on a deployed
object, so renaming one is a storage migration rather than a refactor.

| key                                                      | what it holds                                                |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `install`                                                | the install record — the state the gate above reads          |
| `install:armed`, `install:last-armed`, `install:context` | the `JobLifecycle` bookkeeping, derived from the id above    |
| `install:tree`                                           | the tree the running container holds, by directory and lock  |
| `deps:purged`                                            | synced `node_modules` trees have been deleted from storage   |
| `checkout`                                               | where the work is, and whether it is a clone or a scratchpad |
| `lastUsedAt`                                             | what the idle clock measures                                 |
| `idle-reclaim-id`, `container-idle-id`, `sync-drain-id`  | the schedule row each deadline currently stands as           |

The scheduler owns its own tables beneath these. A subclass may store whatever it
likes alongside, and one does: a credential pool's state, per workspace.

### `running` is the state that blocks work

The one install state that holds a command back. So a `running` record must never
outlive the command it describes, and the ways it can are not reachable from one
place: a spawn can fail before a drain is attached, a drain can be cut short by an
eviction, an exec can be handed back for a container that never answers, and two
installs can displace each other. `host/install-job.ts` closes each and names which.

## wrangler.jsonc

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "Workspace" }]
  },
  // `new_sqlite_classes`, not `new_classes`: the filesystem is the DO's SQLite.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Workspace"] }],
  "containers": [
    {
      "class_name": "Workspace",
      "image": "./Dockerfile",
      "instance_type": "standard-2"
    }
  ],
  // Without this the observer degrades to a no-op and nothing measures a sync.
  "observability": { "enabled": true, "traces": { "enabled": true } }
}
```

One class per agent, because a Durable Object namespace is keyed by class name: agents
sharing one class share one namespace, and one caller's checkout answers for all of
them.

Your Worker entry must also re-export `WorkspaceProxy`:

```ts
export { WorkspaceProxy } from "@cloudflare/computer";
```

Nothing imports it and no binding names it — the container's egress loopback is built
from `ctx.exports.WorkspaceProxy`, so dropping it compiles cleanly and breaks every
container at runtime.

## Requirements

The Workers **Paid** plan (containers), plus `@cloudflare/computer` and
`@platformatic/vfs` — both optional peers, so an agent that never runs code carries
neither. `@platformatic/vfs` is what the git client's filesystem adapter loads;
without it, clone, fetch and push throw a named error.

```bash
npm install @cloudflare/computer @platformatic/vfs
```

The image is `@cloudflare/computer`'s contract rather than this one's — it runs
`computerd`, and the shell named in `ComputerConfig` has to exist in it. This plugin
also needs `mount`, `mountpoint` and `sha256sum` in the image, `/usr/local/sbin`
ahead of the package managers on `PATH`, and a container allowed to bind-mount,
which Cloudflare Containers are.
