# `@dynamicagents/plugins/workspace`

The Durable Object a container workspace lives in, and the client side every other
plugin reaches it through.

The filesystem **is** a Durable Object's SQLite, mounted into the container over
FUSE. Commands see a normal `/workspace`, the Worker reads the same tree over RPC,
and when the container is replaced the tree is pushed into the new one — so the
checkout outlives the container that held it.

What builds on it: [`/computer`](../computer/) is the agent's tools over it;
[`/repo`](../repo/) and [`/scratch`](../scratch/) take `workspaceExec` injected;
[`/claude-code`](../claude-code/) runs its sessions in its container.

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

## Egress is unrestricted

`@cloudflare/computer`'s `WorkspaceEgressPolicy` is `mode: "direct"` in the example
below, so anything in the container can reach anything on the network. That is
deliberate for now — a build needs a registry, and a coding agent needs the web — but
it means holding no credential in the container is the whole of the containment.
Narrowing it to an allowed-host list, with a small classifier for the requests that
fall outside, is possible future work rather than something this object does today.
[`/claude-code`](../claude-code/) puts its own gateway there with `http-gateway`.

## What an object must answer

**You probably do not write this.** `WorkspaceObjectBase` ships from this
subpath — the container backend, the alarm, the dependency install, the credentialed
git — and a host subclasses it and answers a short config. [The object](#the-object) below
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

`workspaceExec` exports the shell alone, for [`/repo`](../repo/) — so that plugin gets
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

## The object

```ts
import {
  DEFAULT_INSTALL_PLAN,
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@dynamicagents/plugins/workspace";

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

| key                                                                          | what it holds                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `install`                                                                    | the install record — the state the gate above reads          |
| `install:armed`, `install:last-armed`, `install:context`, `install:watch-id` | core `/job`'s bookkeeping, derived from the id above         |
| `install:tree`                                                               | the tree the running container holds, by directory and lock  |
| `deps:purged`                                                                | synced `node_modules` trees have been deleted from storage   |
| `checkout`                                                                   | where the work is, and whether it is a clone or a scratchpad |
| `lastUsedAt`                                                                 | what the idle clock measures                                 |
| `idle-reclaim-id`, `container-idle-id`, `sync-drain-id`                      | the schedule row each deadline currently stands as           |

The scheduler owns its own tables beneath these. A subclass may store whatever it
likes alongside, and one does: a credential pool's state, per workspace.

### `running` is the state that blocks work

The one install state that holds a command back. So a `running` record must never
outlive the command it describes, and the ways it can are not reachable from one
place: a spawn can fail before a drain is attached, a drain can be cut short by an
eviction, an exec can be handed back for a container that never answers, and two
installs can displace each other. `install-job.ts` closes each and names which.

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
`computerd`, and the shell a caller names in its `shell` has to exist in it. The object
also needs `mount`, `mountpoint` and `sha256sum` in the image, `/usr/local/sbin`
ahead of the package managers on `PATH`, and a container allowed to bind-mount,
which Cloudflare Containers are.
