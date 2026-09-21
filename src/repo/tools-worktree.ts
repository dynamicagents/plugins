import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { PROTECTED_BRANCHES, UNSAFE_BRANCH } from "./url.js";
import { resolveDefaultBranch } from "./checkout.js";
import type { RepoContext } from "./context.js";

/** Reading the working tree, committing it, and publishing the branch. */
export function worktreeTools(ctx: RepoContext): ToolSet {
  const {
    author,
    bounded,
    config,
    fetchOrigin,
    logFailure,
    plain,
    origin,
    pushBranch
  } = ctx;

  return {
    repo_status: tool({
      description: "Show which files changed in the checkout.",
      inputSchema: z.object({ dir: z.string().describe("Checkout directory") }),
      execute: async ({ dir }) => {
        const result = await plain("status --short", dir);
        // "(no changes)" is a claim about the tree. A command that failed
        // supports no claim about anything, and reporting one as the other sends
        // the model on to commit against a repository it cannot read.
        if (!result.success) {
          logFailure("repo_status", result);
          return bounded(
            `could not read the status of ${dir}: ${result.stderr || result.stdout}`
          );
        }
        return bounded(result.stdout.trim()) || "(no changes)";
      }
    }),

    repo_diff: tool({
      description:
        "Show a diff. With no ref, the uncommitted changes in the checkout — read this before committing, it is the cheapest way to catch an edit that did more than you intended. With a ref, everything that ref adds, which is how you review work that arrived on a branch rather than in your own tree. Pass stat:true first on a large change to see which files moved and by how much, then read the full diff of what matters.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        staged: z.boolean().optional().describe("Show staged changes instead"),
        ref: z
          .string()
          .optional()
          .describe(
            "Review a ref instead of the working tree — e.g. 'origin/coder/add-json-flag'. Fetch it first; a ref this checkout has never seen cannot be diffed."
          ),
        stat: z
          .boolean()
          .optional()
          .describe(
            "Summarise as a per-file changed-line count instead of the full patch"
          )
      }),
      execute: async ({ dir, staged, stat, ref }) => {
        // Shape-checked for the same reason `repo_push` checks a branch: a ref is
        // model-authored, and `git diff -x` reads a leading `-` as an option
        // rather than a name. `UNSAFE_BRANCH` already refuses that and the
        // traversal spellings.
        if (ref !== undefined && UNSAFE_BRANCH.test(ref))
          return `"${ref}" is not a plain ref — pass something like "origin/coder/add-json-flag"`;

        const flags = [staged ? "--staged" : "", stat ? "--stat" : ""]
          .filter(Boolean)
          .join(" ");
        // `HEAD...<ref>`, and the order is the whole point: `git diff A...B`
        // compares the merge base of the two to **B**, so the reviewed ref has to
        // be on the right. Reversed, this reports what the reviewer's own HEAD
        // gained since the branch diverged — which is the "the branch reverted
        // things" reading it exists to avoid, printed with confidence.
        //
        // The ref goes in an env var and is never interpolated — see `shell`'s
        // `vars`, which carries why. A `--` would not be enough on its own here,
        // because the injection this prevents is a second shell command.
        const result = ref
          ? await plain(`diff ${flags} HEAD..."$REPO_REF" --`, dir, {
              REPO_REF: ref
            })
          : await plain(`diff ${flags}`, dir);
        // Same reasoning as `repo_status`: "(no diff)" and "the diff could not
        // be read" are opposite answers, and this is the tool a reviewing agent
        // trusts most.
        if (!result.success) {
          logFailure("repo_diff", result);
          return bounded(
            ref
              ? // Names the ref and the likely cause: the common failure is a ref
                // this checkout has never fetched, and "unknown revision" on its
                // own does not say that.
                `could not diff "${ref}" in ${dir} — fetch it first if it has not ` +
                  `been fetched: ${result.stderr || result.stdout}`
              : `could not read the diff in ${dir}: ${result.stderr || result.stdout}`
          );
        }
        // Truncated from the middle rather than the end: the head of a diff and
        // its tail are both informative, and the middle of a large one rarely
        // is. A model that needs the part that was dropped can ask for `stat`
        // and then read the file.
        return bounded(result.stdout.trim()) || "(no diff)";
      }
    }),

    repo_commit: tool({
      description:
        "Stage everything and commit. Write the message for a reviewer reading it in the log a year from now: what changed and why, not how.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        message: z.string().describe("Commit message")
      }),
      execute: async ({ dir, message }) => {
        const refused = await config.beforeWrite?.({
          tool: "repo_commit",
          dir
        });
        if (refused) return refused;

        // Checked rather than fired and forgotten. A failed `add` leaves the
        // index holding less than the model believes, and the commit that
        // follows still succeeds — so the round reports a commit that quietly
        // does not contain the change.
        const staged = await plain("add -A", dir);
        if (!staged.success) {
          logFailure("repo_commit", staged);
          return bounded(
            `could not stage the changes in ${dir}: ${staged.stderr || staged.stdout}`
          );
        }
        // The message is model-authored free text — quotes, backticks, newlines,
        // `$(…)`. Expanded from the environment inside the container, all of
        // that is inert; interpolated into the command string, none of it is.
        const result = await plain(`commit -m "$GIT_COMMIT_MESSAGE"`, dir, {
          GIT_COMMIT_MESSAGE: message,
          // On the commit as well as in the checkout's config, and this is
          // the copy that is current: config is written when a checkout is set
          // up, and the environment is read at the commit. A workspace that
          // outlived a change of identity commits under the new one.
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email
        });
        if (!result.success && /nothing to commit/i.test(result.stdout))
          return "nothing to commit — the working tree is clean";
        if (!result.success) {
          logFailure("repo_commit", result);
          return bounded(`commit failed: ${result.stderr || result.stdout}`);
        }
        return bounded(result.stdout.trim());
      }
    }),

    /**
     * Bring the remote's branches into a checkout without touching its tree.
     *
     * `repo_clone` fetches too, but it resets the tree afterwards and only ever
     * reaches the checkout it clones into — so work pushed to a branch by
     * somebody else, a submodule's included, had no way into a checkout that
     * already existed. Nothing here writes to the working tree, so there is no
     * refusal path for uncommitted work.
     */
    repo_fetch: tool({
      description:
        "Fetch every branch from a checkout's own origin, without touching its working tree. This is how a branch someone else pushed becomes a ref you can review: after it, repo_diff with ref 'origin/<branch>'. Pass the directory of the repository the branch was pushed to — in a superproject, that is the submodule's directory.",
      inputSchema: z.object({ dir: z.string().describe("Checkout directory") }),
      execute: async ({ dir }) => {
        // The checkout's own origin, for the reason `repo_push` reads it: it has
        // already passed the allowlist, and a URL named here would not have.
        const { remote, unreachable } = await origin(dir);
        if (unreachable)
          return bounded(`could not fetch in ${dir}: ${unreachable}`);
        if (!remote)
          return `${dir} has no origin on an allowed host — clone it with repo_clone first`;
        const fetched = await fetchOrigin(dir, remote.url);
        if (!fetched.success) {
          logFailure("repo_fetch", fetched);
          return bounded(`fetch failed: ${fetched.stderr || fetched.stdout}`);
        }
        return `fetched ${remote.url} into ${dir}; its branches are under origin/ — review one with repo_diff and ref "origin/<branch>"`;
      }
    }),

    repo_push: tool({
      description:
        "Push a branch to the remote. Refuses to push to a protected branch and refuses to force-push — open a pull request instead.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        branch: z
          .string()
          .describe(
            "Branch name to create and push, e.g. 'coder/add-json-flag'"
          )
      }),
      execute: async ({ dir, branch }) => {
        // Enforced here rather than in the prompt: a guardrail a model can talk
        // itself out of is not a guardrail.
        //
        // Shape first, then the name. `git push origin <name>` reads `<name>`
        // as a refspec, so `+x:main` is a force push to main that the name
        // check below would wave through — it only ever sees a literal string.
        if (UNSAFE_BRANCH.test(branch))
          return `"${branch}" is not a plain branch name — use something like "coder/add-json-flag"`;
        if (PROTECTED_BRANCHES.has(branch))
          return `refusing to push to "${branch}" — push a work branch and open a pull request`;

        // The repository's *own* default, which is often none of the four names
        // above: a repo whose trunk is `release` deserves the same protection.
        // A command that never ran stops here rather than standing the guards
        // down — the same rule as the two probes further down, and the reason
        // {@link resolveDefaultBranch} reports the two separately.
        const head = await resolveDefaultBranch(plain, dir);
        if (head.unreachable)
          return bounded(`could not push "${branch}": ${head.unreachable}`);
        const defaultBranch = head.branch;
        if (defaultBranch && defaultBranch === branch)
          return `refusing to push to "${branch}" — it is this repository's default branch; push a work branch and open a pull request`;

        const { remote, unreachable } = await origin(dir);
        if (unreachable)
          return bounded(`could not push "${branch}": ${unreachable}`);
        if (!remote)
          return `${dir} has no origin on an allowed host — clone it with repo_clone first`;

        const refused = await config.beforeWrite?.({
          tool: "repo_push",
          dir,
          branch,
          url: remote.url
        });
        if (refused) return refused;

        // Switch to the branch, or create it — but never *reset* it.
        //
        // `-b`, never `-B`: `-B` is create-or-reset, so on a branch that already
        // holds the commit it force-moves it to wherever HEAD is now. The commit
        // survives only as an unreferenced object, and what gets pushed is an
        // empty branch with a pull request opened on it — a complete loss
        // dressed up as success.
        const exists = await plain(
          `rev-parse --verify --quiet "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        // Same reasoning as the probe in `repo_clone`: `!success` means "no such
        // branch, create it" only when git was there to say so.
        if (exists.unreachable)
          return bounded(`could not push "${branch}": ${exists.stderr}`);
        const checkout = await plain(
          exists.success
            ? `checkout "$REPO_BRANCH"`
            : `checkout -b "$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        if (!checkout.success) {
          logFailure("repo_push", checkout);
          return bounded(
            `could not switch to branch "${branch}": ${checkout.stderr || checkout.stdout}`
          );
        }

        // Nothing to push is a bug upstream of here, not a no-op.
        //
        // A branch level with the default branch means the commit went
        // somewhere else, or was never made. Pushing it succeeds, `repo_open_pr`
        // opens an empty pull request, and the round reports a URL as if the
        // work had landed — the one outcome worse than an error.
        //
        // The guard is skipped only when there is no baseline to compare
        // against: a repository with no `origin/HEAD` is unusual but legitimate,
        // and guessing is worse than not guarding. Once there *is* one, a
        // comparison that fails is an unanswered question rather than a pass —
        // the same rule the three probes around this one follow.
        if (defaultBranch) {
          const ahead = await plain(
            `rev-list --count "origin/$REPO_BASE..HEAD"`,
            dir,
            {
              REPO_BASE: defaultBranch
            }
          );
          if (ahead.unreachable)
            return bounded(`could not push "${branch}": ${ahead.stderr}`);
          if (!ahead.success) {
            logFailure("repo_push", ahead);
            return bounded(
              `could not tell whether "${branch}" has anything to push: comparing it ` +
                `against origin/${defaultBranch} failed with ` +
                `${ahead.stderr || ahead.stdout || "no output"}\n` +
                `Nothing was pushed. Pushing without that answer risks an empty pull ` +
                `request reported as success, so check repo_status and repo_diff first.`
            );
          }
          if (ahead.stdout.trim() === "0") {
            return (
              `refusing to push "${branch}" — it has no commits that origin/${defaultBranch} ` +
              `does not already have, so the pull request would be empty. Check repo_status ` +
              `and repo_diff: either the change was never committed, or it was committed on ` +
              `a different branch.`
            );
          }
        }

        // A pre-flight check, not a value anyone downstream consumes: `push`
        // takes the branch *name* and resolves it itself, against the same
        // files. What this buys is the failure arriving here, where the sentence
        // can name the branch and the checkout, instead of surfacing as a push
        // that rejects a ref nobody can see.
        const tip = await plain(
          `rev-parse --verify "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        if (!tip.success || !tip.stdout.trim()) {
          logFailure("repo_push", tip);
          return bounded(
            `could not resolve "${branch}" to a commit: ${tip.stderr || tip.stdout}`
          );
        }

        const result = await pushBranch(dir, remote.url, branch);
        if (!result.success) {
          logFailure("repo_push", result);
          return bounded(`push failed: ${result.stderr || result.stdout}`);
        }
        try {
          await config.afterPush?.({ dir, branch, commit: tip.stdout.trim() });
        } catch (err) {
          console.warn("[repo] afterPush failed", {
            dir,
            branch,
            err: String(err)
          });
        }

        // What `--set-upstream` would do as a side effect of the push, written
        // here because the push happens on the host's side: a subagent reaching
        // for a bare `git push` in the shell should still find the branch
        // tracking something.
        //
        // Checked, but *reported* rather than raised: this is the one place in
        // the plugin where a failed command is not a failed operation. The push
        // has landed, saying so is the important half, and all that is lost is
        // the convenience these two keys buy.
        const remoteSet = await plain(
          `config "branch.$REPO_BRANCH.remote" origin`,
          dir,
          { REPO_BRANCH: branch }
        );
        const mergeSet = await plain(
          `config "branch.$REPO_BRANCH.merge" "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        const untracked = [remoteSet, mergeSet].find((r) => !r.success);
        if (untracked) {
          // Named apart from the push, which succeeded — a log line reading
          // "repo_push failed" next to a branch that is on the remote is worse
          // than no log line.
          logFailure("repo_push (upstream tracking)", untracked);
          return bounded(
            `pushed ${branch}, but could not record what it tracks: ` +
              `${untracked.stderr || untracked.stdout}\n` +
              `The push itself landed. The only consequence is local: a bare ` +
              `\`git push\` from the shell will not know where to send this ` +
              `branch, and needs \`git push -u origin ${branch}\` once.`
          );
        }
        return `pushed ${branch}`;
      }
    })
  };
}
