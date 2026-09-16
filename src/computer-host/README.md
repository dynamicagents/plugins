# `@dynamicagents/plugins/computer-host`

The Durable Object a workspace lives in. [`/computer`](../computer/) is the half a
model calls; this is the half that deploys.

```ts
import {
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@dynamicagents/plugins/computer-host";

export class Workspace extends WorkspaceObjectBase {
  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "WORKSPACE",
      label: "workspace",
      installPlan: INSTALL_PLAN,
      egress: { mode: "direct" },
      git: {
        token: this.env.GITHUB_TOKEN,
        author: { name: this.env.GITHUB_NAME, email: this.env.GITHUB_EMAIL }
      }
    };
  }
}
```

Subclass it, answer `workspaceConfig()`, export the class and `WorkspaceProxy` from
your Worker entry, and declare the binding, the container and the migration. That is
the whole contract; everything else — the one alarm and the deadlines multiplexed onto
it, the container backend, the dependency install, the credentialed git, the pull the
library schedules for nobody — is inherited.

## Why the class is here and the config is yours

A Durable Object takes no constructor arguments, so per-deployment values cannot
arrive that way. `workspaceConfig()` is the seam, and it is short on purpose: it is
the complete answer to "what is different about this agent's workspace", and the
alternative is a second copy of a thousand-line object drifting in whichever direction
the one nobody redeployed recently went.

`binding` is not cosmetic and not derivable — `computerd` dials **back** through it,
so a wrong name produces a container that starts, mounts nothing, and fails at the
first command without mentioning a binding.

`egress` has no safe default. Omit it and the container comes up with no network at
all: the workspace mounts, commands run, and the install dies on a registry it cannot
reach with nothing naming egress as the cause. `http-gateway` is what puts your Worker
on the container's outbound path — see [`/claude-code`](../claude-code/), which uses it
to swap in a credential the container must never hold.

`git` carries the forge token and the commit identity. They are config rather than an
env read because this package cannot name a consumer's ambient `Env`, and because they
are [`/repo`](../repo/)'s secrets — a workspace holds them only because git runs on
_this_ side of the container boundary, which `git-host.ts` explains.

## What the object owns in storage

These keys are part of the contract, not an implementation detail: they persist on a
deployed object, so renaming one is a storage migration rather than a refactor.

| key                                                      | what it holds                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `install`                                                | the install record — the state [`/computer`](../computer/)'s gate reads |
| `install:armed`, `install:last-armed`, `install:context` | core's `JobLifecycle` bookkeeping, derived from the id above            |
| `install:syncing`                                        | an install whose tree has not finished crossing                         |
| `install:completed`                                      | the fingerprint of a tree that landed in full                           |
| `checkout`                                               | where the work is, and whether it is a clone or a scratchpad            |
| `lastUsedAt`                                             | what the idle clock measures                                            |
| `idle-reclaim-id`, `container-idle-id`, `sync-drain-id`  | the schedule row each deadline currently stands as                      |

Core's scheduler owns its own tables beneath these. A subclass may store whatever it
likes alongside, and one does: a credential pool's state, per workspace.

## `running` is the state that blocks work

The one install state that holds a command back — [`/computer`](../computer/)'s gate
waits on it and then refuses to run. So a `running` record must never outlive the
command it describes, and the ways it can are not reachable from one place: a spawn
can fail before a drain is attached, a drain can be cut short by an eviction, an exec
can be handed back for a container that never answers, and two installs can displace
each other.

`install.ts` closes each of those and names which. If you are reimplementing this
object rather than subclassing it, that file is the one to read first — the gate is on
the other side of a package boundary and cannot check your work.

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
  // Without this, the observer degrades to a no-op and nothing measures a sync.
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

The Workers **Paid** plan, and `@cloudflare/computer` plus `@platformatic/vfs`
installed — both ship as optional peers, so an agent that never runs code carries
neither. `@platformatic/vfs` is what the git client's filesystem adapter loads; without
it, clone, fetch and push throw a named error.

```bash
npm install @cloudflare/computer @platformatic/vfs
```

The image is `@cloudflare/computer`'s contract rather than this one's — it runs
`computerd`, and the shell you name in
[`ComputerConfig`](../computer/) has to exist in it.
