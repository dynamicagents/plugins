/**
 * `@dynamicagents/plugins/worktrees`: a checkout of its own for each writing
 * session, kept on its branch afterwards for the parent to read and push.
 *
 * A mechanism a host wires, not a plugin it installs: the host owns the
 * sub-agents that run in a worktree, its sandbox binding, the parent's
 * selection, and the sentences that name its own tools. It passes those in;
 * what is here is the pool, the clone, the branch and what a stopped run keeps.
 * The tools that switch the parent into a worktree are `/repo-github`'s, over
 * the {@link WorktreeSwitch} this builds.
 */

export {
  claim,
  forgetWorktree,
  holderOf,
  idleWorktrees,
  isFree,
  parseWorktreeRepo,
  reconcileWorktrees,
  runBranch,
  slotOf,
  sqlPoolStore,
  workingOn,
  worktreeRepo,
  type ClaimTerms,
  type PoolRepo,
  type PoolStore,
  type Worktree
} from "./pool.js";
export {
  placementRepo,
  selectedRepo,
  type WorktreeCheckout,
  type WorktreeSelection
} from "./selection.js";
export {
  subtaskWorkspaces,
  type KeptWork,
  type RunRef,
  type SessionPlace,
  type SubtaskWorkspaces,
  type WorktreeCopy,
  type WorktreeHost
} from "./sessions.js";
export {
  gitmodulesOf,
  parseGitmodules,
  readSubmodules,
  submoduleCloneUrl,
  submoduleRepos,
  type CheckoutShell,
  type Submodule
} from "./submodules.js";
export { worktreeSwitch, type WorktreeSwitch } from "./switch.js";
