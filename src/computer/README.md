# `@dynamicagents/plugins/computer`

A Linux container whose filesystem outlives it.

```ts
import { computer } from "@dynamicagents/plugins/computer";

computer({
  binding: env.WORKSPACE,
  workspaceName: () => `${callerKey()}|${owner}/${repo}`,
  shell: "bash"
});
```

Tools: `sb_exec`, `sb_read`, `sb_write`, `sb_edit`, `sb_ls`, `sb_grep`, `sb_exists`.

The filesystem **is** a Durable Object's SQLite, mounted into the container over
FUSE. Commands see a normal `/workspace`, the Worker reads the same tree over RPC,
and when the container is replaced the tree is pushed into the new one — so the
checkout outlives the container that held it.

Install exactly one filesystem plugin. An agent holding this and
[`/workspace`](../workspace/) gives the model no way to know which one a path refers
to.

## `node_modules` is in the workspace too

The one thing to internalise. `computerd` syncs the dependency tree along with
everything else, so an install outlives its container: a replacement is handed the
tree back rather than rebuilding it, and the file tools read inside it like anywhere
else.

What it costs is attention, not correctness. A real tree is 22,470 files and sorts
before `src`, so `sb_grep` and recursive `sb_ls` leave those results out. Pointing
`path` at `node_modules` searches it, which is what keeps that a default rather than
a wall; `.git` has no such opt-in, because the guard below refuses it as a path at
all.

`sb_ls` passes both as `find` exclusions, so the store never walks them. `grep` takes
no exclusion, so `sb_grep` filters its results: it still pays to traverse what it
drops, and a page landing wholly inside one says so rather than reporting nothing.

## `.git` is off limits

Present in the workspace, refused by the file tools anyway, and skipped by walks like
the dependency tree above. Reading it tells the model less than [`/repo`](../repo/) does,
and writing it corrupts the checkout. Repository work goes through the repo tools.

## Searching

`sb_grep` and `sb_ls` read the durable workspace rather than the container, so they
keep answering while it restarts or while an install runs — which is exactly when a
subagent would otherwise be blocked. Both bound their results at the source and
report the `offset` that continues a cut one; `sb_read` takes a byte range for the
same reason, so nothing needs a shell to be reached.

## The container is the trust boundary

Two things run in it that nobody reviewed: the commands the model writes, and the
repository it was asked to clone. `npm ci` executes that repository's lifecycle
scripts, so "we only ran the install" is still running a stranger's code. Treat
anything inside the container as reachable by both.

Two consequences worth stating outright:

- **No secret belongs in `ComputerConfig.env`.** It is merged into every command
  these tools run, and `sb_exec`'s command is model-authored — `sb_exec("printenv")` prints the lot,
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
- **`sb_grep`'s `regex` compiles a model-authored pattern** and runs it over every
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
  command in a _fresh_ container waits for the whole tree to be pushed across —
  minutes, on a checkout carrying `node_modules`. Serving both the same way puts that
  wait in front of `sb_read`. A host with nothing to distinguish returns
  `__getWorkspaceStub()`; required for the reason `advisories` gives below.
- `advisories(): Promise<readonly WorkspaceAdvisory[]>` — everything currently true
  about the workspace that a caller must not assume away, or `[]`. Required rather
  than optional: a host that forgets to expose it would otherwise get an `sb_exec`
  running against a half-built `node_modules`, or an `sb_edit` reporting a character
  count for an edit the workspace threw away.

  Build it with `deriveAdvisories({ install, storage, dependencyTreePresent })` rather
  than by hand — implementing this is gathering what the host already has, not
  writing policy. Which advisories reach which commands, whether one may hold a
  command back, and how each is worded are decided here, in one place each. A host
  that renders its own wording is re-deriving severity from an error string, which
  is what this replaced.

  `dependencyTreePresent` is existence only — is there a `node_modules` directory in
  the workspace — and is reported to the reader rather than acted on, because an
  `npm ci` that died partway leaves the directory behind. It qualifies a failure; it
  never cancels one.

  `sb_exec` and the write tools consult this. `sb_exec` waits out anything transient and warns about the
  rest; `sb_write` and `sb_edit` **refuse** when an advisory says writes do not
  survive, since a write has no successful outcome available there and reporting one
  is worse than refusing.

One workspace is one container is one repository, so `workspaceName` should derive
from the verified caller and the repository — never from model input, or a model
naming another caller's workspace would get that caller's files.

Subagents reach the parent's checkout through `WORKSPACE_RUNTIME_KEY`: a subagent
execution has no caller identity and cannot compute the name itself, so the parent's
`resolveRuntime` puts it on the runtime state and every tool family reads it back.

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
`sb_exec` carries no container backend and no isomorphic-git.

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
| `install:armed`, `install:last-armed`, `install:context` | core's `JobLifecycle` bookkeeping, derived from the id above |
| `install:syncing`                                        | an install whose tree has not finished crossing              |
| `install:completed`                                      | the fingerprint of a tree that landed in full                |
| `checkout`                                               | where the work is, and whether it is a clone or a scratchpad |
| `lastUsedAt`                                             | what the idle clock measures                                 |
| `idle-reclaim-id`, `container-idle-id`, `sync-drain-id`  | the schedule row each deadline currently stands as           |

Core's scheduler owns its own tables beneath these. A subclass may store whatever it
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
`computerd`, and the shell named in `ComputerConfig` has to exist in it.
