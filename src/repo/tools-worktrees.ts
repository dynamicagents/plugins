import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { RepoWorktrees } from "./index.js";
import { UNSAFE_BRANCH } from "./url.js";

/**
 * Moving between the host's worktrees — not to be confused with
 * `./tools-worktree.ts`, which reads and writes the one checkout the tools point
 * at.
 *
 * Thin by design: which worktrees exist and what a switch reaches are the host's
 * facts — see {@link RepoWorktrees} — so these tools check a branch's shape and
 * pass the host's sentence through.
 */
export function worktreesTools(worktrees: RepoWorktrees): ToolSet {
  const refuse = (branch: string) =>
    `"${branch}" is not a plain branch name — pass it as the subtask's report named it`;

  return {
    repo_worktrees: tool({
      description:
        "List the worktrees your writing subtasks committed in: each one's branch, whether a session is still working in it, and whether its commits are pushed. Pass `release` with a branch to give up its worktree once you have decided not to keep that work — unpushed commits in it are lost.",
      inputSchema: z.object({
        release: z
          .string()
          .optional()
          .describe("A branch whose worktree to give up")
      }),
      execute: async ({ release }) => {
        if (release === undefined) return await worktrees.list();
        if (UNSAFE_BRANCH.test(release)) return refuse(release);
        return await worktrees.release(release);
      }
    }),

    repo_worktree: tool({
      description:
        "Point every repo tool and your file reads at the worktree holding a branch a writing subtask reported — to review its commits with repo_diff, test it, push it and open the pull request from there. Call with no branch to come back to your own checkout.",
      inputSchema: z.object({
        branch: z
          .string()
          .optional()
          .describe(
            "The branch a subtask's report named, e.g. 'claude-coder/<task>/<n>'; omit to go back to your own checkout"
          )
      }),
      execute: async ({ branch }) => {
        if (branch !== undefined && UNSAFE_BRANCH.test(branch))
          return refuse(branch);
        return await worktrees.use(branch);
      }
    })
  };
}
