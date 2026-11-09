import { parseWorktreeRepo } from "./pool.js";

/**
 * What the parent's tools are pointed at, as far as its worktrees need to know.
 *
 * The selection is the host's, because which repository a caller works in is a
 * decision its own tools make on every call, synchronously. This is the part of
 * it a worktree reads and moves, so a host passes what it already keeps.
 */

/** Enough to clone the parent's repository again somewhere else. */
export interface WorktreeCheckout {
  /** The clone url `/repo-github` used, already through its host allowlist. */
  url: string;
  /**
   * Where it put the tree. A worktree's own clone goes to the same path: each
   * container has its own filesystem, so it collides with nothing, and it is
   * what lets the parent's tools move into a worktree at the paths they already
   * use.
   */
  dir: string;
  /** The branch the parent is on, so a session starts from the same commit. */
  branch: string;
}

export interface WorktreeSelection {
  /**
   * `owner/repo`, a sentinel (a scratchpad, a worktree the parent switched
   * into), or undefined before anything was opened.
   */
  get(): string | undefined;
  /** Point the parent's tools at a repository or a worktree's sentinel. */
  set(name: string): void;
  /**
   * Enrol a name in the host's reclaim sweep **without** pointing anything at
   * it: a worktree a session is prepared in must be swept, and must not become
   * what the parent's own tools address until the parent switches into it.
   */
  note(name: string): void;
  /**
   * Where a session works for `repo`: a superproject the caller checked out
   * that carries it as a submodule, or `repo` itself.
   */
  rootOf(repo: string): string;
  /** The selection's checkout, as the parent's clone recorded it. */
  checkout(): WorktreeCheckout | undefined;
  /** A repository's own checkout, whatever is selected now. */
  checkoutOf(repo: string): WorktreeCheckout | undefined;
}

/**
 * Whether the parent's current selection names a repository a worktree can be
 * cloned from: itself, or the pool of a worktree it has switched into.
 *
 * Stated as "not a sentinel" for everything else, a scratchpad included, so a
 * sentinel added later is refused by default instead of being mistaken for a
 * repository name.
 */
export function selectedRepo(selected: string | undefined): string | undefined {
  if (selected === undefined) return undefined;
  const worktree = parseWorktreeRepo(selected);
  if (worktree) return worktree.repo;
  return selected.startsWith("<") ? undefined : selected;
}

/**
 * The repository a session is placed in, and whose worktrees the parent's
 * reads are shown: the root of the one selected. See
 * {@link WorktreeSelection.rootOf}.
 */
export function placementRepo(active: WorktreeSelection): string | undefined {
  const selected = selectedRepo(active.get());
  return selected === undefined ? undefined : active.rootOf(selected);
}
