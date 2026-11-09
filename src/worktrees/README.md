# `@dynamicagents/plugins/worktrees`

A checkout of its own for each writing sub-agent, kept on its branch afterwards for the
parent to read, push and continue.

```ts
import { repo } from "@dynamicagents/plugins/repo-github";
import {
  sqlPoolStore,
  subtaskWorkspaces,
  worktreeSwitch,
  type WorktreeCopy
} from "@dynamicagents/plugins/worktrees";

const copy: WorktreeCopy = {
  noCheckout:
    "there is nothing checked out yet. Clone a repository before delegating.",
  held: (branch) =>
    `a worktree already holds ${branch}. Continue it, or name another branch.`,
  neverPushed: (branch) =>
    `${branch} was never pushed, and its commits are gone.`,
  kept: (branch, wip) =>
    `Its work is kept on \`${branch}\`${wip ? ", with a WIP commit on top" : ""}.`,
  resume: "Delegate with `continue` set to the branch to carry it on."
};

// In the sub-agent's `prepare` and `settle`, built from the parent's context:
const workspaces = subtaskWorkspaces({
  binding: env.MY_SANDBOX,
  callerKey: () => ctx.callerKey(),
  exec: (command, options, sandbox) => shellIn(sandbox)(command, options),
  stopSession: (sandbox, runId) =>
    env.MY_SANDBOX.getByName(sandbox).stopRun(runId),
  admit: async () => {},
  active: selection,
  pool: sqlPoolStore(ctx.storage),
  label: "my-agent",
  copy
});

// On the parent's own install, the way between worktrees:
repo({
  /* … */
  worktrees: worktreeSwitch({
    active: selection,
    pool: sqlPoolStore(ctx.storage),
    binding: env.MY_SANDBOX,
    callerKey: ctx.callerKey,
    reclaimMs: SANDBOX_RECLAIM_MS,
    copy
  })
});
```

Not a plugin to install: a mechanism a host wires into the sub-agents it owns. Which
sub-agents get a worktree, when a run continues one, and what the delegating model is
told to do next are the host's. What is here is the rest: the pool, the clone, the
branch, and what a run that stopped keeps.

## What a worktree is

A sandbox of its own, one per slot, with a full clone of the parent's repository: the
superproject and each submodule, every one with objects of its own. A session's branch
and its commits stay in it after the session ends, so the parent can switch its reads
into it, push it, or send a session back to it. A slot no session holds is reset onto
the next session's branch rather than cloned again, because a fetch and a reset cost
seconds and a clone minutes.

Its sandbox is keyed `sandboxName(caller, worktreeRepo(repo, slot))`, in the host's own
sandbox namespace, so it needs **no binding of its own**: the host's sandbox class,
which extends `SandboxObjectBase` from `/sandbox`, is what `binding` names.

## What the host passes

| field                          | what it is                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`, `callerKey`         | the host's sandbox namespace, and the verified caller a sandbox name is keyed on                                                        |
| `exec`                         | a shell in a named sandbox, per call: the worktree being prepared is never the one the parent's tools are on                            |
| `stopSession`, `admit`         | stop a run's session before its work is kept; refuse a session before anything reaches its container                                    |
| `active`                       | a `WorktreeSelection`: the parent's current repository or sentinel, its recorded checkouts, and which superproject carries a repository |
| `pool`                         | a `PoolStore`; `sqlPoolStore(storage)` keeps it in the parent's SQLite                                                                  |
| `label`                        | prefixes each refusal and log line, and names the branch a session starts when its caller named none                                    |
| `copy`                         | a `WorktreeCopy`: the sentences that tell the delegating model which call to make next                                                  |
| `reclaimMs` (`worktreeSwitch`) | how long the host's sweep leaves an untouched sandbox, as the parent is told it                                                         |

**A `PoolStore` is synchronous.** A claim checks the pool and writes itself in one step,
so two runs prepared at once cannot both pass a check made before either was written.

**`copy` has no defaults.** Its sentences name the host's tools and their inputs (the
delegating tool, its `continue`), which this subpath does not know. Every other sentence
is about the worktree, and is this subpath's.

**A host validates its own tool's input** before `resolve`, in its own words, with
`isBranchName` from `/repo-github`. `resolve` refuses what slips through, in terms that
name no tool.

## Keeping the pool honest

The host's reclaim sweep empties sandboxes, and the pool has to hear of it:

- `forgetWorktree(pool, sentinel)` for each sandbox the sweep reclaimed;
- `reconcileWorktrees(pool, hasCheckout)` after it, for a sandbox that went some other
  way: a row describing a checkout that is gone would never be free again;
- `idleWorktrees(pool)` names every worktree no session is in, for a host to release
  their containers when a task settles.

A worktree's sentinel goes to the host's sweep list through `active.note`, never
`active.set`, when it is claimed, so a worktree the parent never switched into is still
swept.
