import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { FORGE_PAGE_SIZE } from "./context.js";
import type { RepoContext } from "./context.js";

/** The forge's REST surface: pull requests, issues and their comments. */
export function forgeTools(ctx: RepoContext): ToolSet {
  const { bounded, forge, forgeRepo } = ctx;

  return {
    repo_open_pr: tool({
      description:
        "Open a pull request for a pushed branch and return its URL. Do this once the branch is pushed and the tests pass.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        head: z.string().describe("The branch you pushed"),
        base: z.string().describe("The branch to merge into, e.g. 'main'"),
        title: z.string().describe("Pull request title"),
        body: z
          .string()
          .describe(
            "Pull request description — what changed and why, and how you verified it"
          )
      }),
      execute: async ({ dir, head, base, title, body }) => {
        // The checkout's own origin, never a URL the model names — the rule the
        // three read tools follow, and it binds harder here because this one
        // writes. A repository named at the call site is bounded only by the
        // host allowlist, so an agent talked into naming one could open a pull
        // request on anything the token can write to.
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        // One may be open already: a call abandoned before its answer arrived
        // still opened it, and the retry that follows is the ordinary case.
        // Best-effort — a lookup that fails leaves the POST to answer for itself.
        // The filter wants `owner:branch`; a fork's head already says whose.
        const filter = new URLSearchParams({
          state: "open",
          head: head.includes(":")
            ? head
            : `${decodeURIComponent(owner)}:${head}`,
          base
        });
        const existing = await forge(
          "repo_open_pr",
          `/repos/${owner}/${repo}/pulls?${filter}`
        );
        const open =
          existing.ok && Array.isArray(existing.data)
            ? (existing.data[0] as { html_url?: string } | undefined)
            : undefined;
        if (open?.html_url)
          return `already open, nothing new was created: ${open.html_url}`;

        const opened = await forge(
          "repo_open_pr",
          `/repos/${owner}/${repo}/pulls`,
          { method: "POST", body: { title, head, base, body } }
        );
        if (!opened.ok)
          // A POST whose answer never arrived may still have been received, and
          // a blind retry is how one pull request becomes two.
          return bounded(
            `${opened.message}\nIf this was a timeout rather than a rejection the ` +
              `pull request may have been opened anyway — check with repo_pr_view ` +
              `before retrying, or the retry will open a second one alongside it.`
          );
        const data = opened.data as { html_url?: string };
        return (
          data.html_url ??
          "pull request opened, but the response carried no URL"
        );
      }
    }),

    repo_issue_view: tool({
      description:
        "Read an issue or pull request from the repository you have checked out: its title, state, description and comments. Use this when a task refers to an issue number, before guessing what it asks for.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Issue or PR number")
      }),
      execute: async ({ dir, number }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        // The issues endpoint, deliberately, even for a pull request: GitHub
        // models every PR as an issue, and this is the one that carries the
        // discussion. `repo_pr_view` is for the parts that are only a PR's.
        const issue = await forge(
          "repo_issue_view",
          `/repos/${owner}/${repo}/issues/${number}`
        );
        if (!issue.ok) return bounded(issue.message);
        const data = issue.data as {
          title?: string;
          state?: string;
          user?: { login?: string };
          body?: string;
          pull_request?: unknown;
        };

        const comments = await forge(
          "repo_issue_view",
          `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${FORGE_PAGE_SIZE}`
        );
        // A failure here is not a failure of the tool: the issue itself was
        // read, and half an answer beats none.
        const thread = (
          comments.ok && Array.isArray(comments.data) ? comments.data : []
        ) as { user?: { login?: string }; body?: string }[];
        // A full page means there is very likely another. Said out loud, because
        // this thread is what the model reasons from: comments arrive oldest
        // first, so the ones it cannot see are the most recent — the review
        // feedback, on the pull request busy enough to have overflowed.
        const moreComments = thread.length >= FORGE_PAGE_SIZE;

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"} [${data.state ?? "?"}]` +
              (data.pull_request ? " (pull request)" : ""),
            `opened by ${data.user?.login ?? "unknown"}`,
            "",
            data.body?.trim() || "(no description)",
            ...thread.map(
              (c) =>
                `\n--- ${c.user?.login ?? "unknown"} ---\n${c.body?.trim() ?? ""}`
            ),
            ...(comments.ok ? [] : [`\n(comments could not be read)`]),
            ...(moreComments
              ? [
                  `\n(showing the first ${FORGE_PAGE_SIZE} comments; the thread is ` +
                    `longer, and the newest are not among them)`
                ]
              : [])
          ].join("\n")
        );
      }
    }),

    repo_pr_view: tool({
      description:
        "Read a pull request's state and the files it touches — whether it is mergeable, its review state, and which paths changed. Use this to check on a pull request you opened, or to see what an existing one does before duplicating it.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number")
      }),
      execute: async ({ dir, number }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        const pr = await forge(
          "repo_pr_view",
          `/repos/${owner}/${repo}/pulls/${number}`
        );
        if (!pr.ok) return bounded(pr.message);
        const data = pr.data as {
          title?: string;
          state?: string;
          draft?: boolean;
          merged?: boolean;
          mergeable?: boolean | null;
          head?: { ref?: string };
          base?: { ref?: string };
          html_url?: string;
        };

        const files = await forge(
          "repo_pr_view",
          `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${FORGE_PAGE_SIZE}`
        );
        const changed = (
          files.ok && Array.isArray(files.data) ? files.data : []
        ) as { filename?: string; additions?: number; deletions?: number }[];
        const moreFiles = changed.length >= FORGE_PAGE_SIZE;

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"}`,
            `${data.merged ? "merged" : (data.state ?? "?")}` +
              (data.draft ? " (draft)" : "") +
              // `mergeable` is computed asynchronously by GitHub and is `null`
              // until it has been, which is common on a pull request opened
              // seconds ago — exactly when this tool is most likely to be called.
              (data.mergeable === null
                ? ", mergeability not yet computed"
                : data.mergeable === false
                  ? ", NOT mergeable"
                  : ""),
            `${data.head?.ref ?? "?"} → ${data.base?.ref ?? "?"}`,
            data.html_url ?? "",
            "",
            changed.length
              ? changed
                  .map(
                    (f) =>
                      `  ${f.filename ?? "?"} (+${f.additions ?? 0} -${f.deletions ?? 0})`
                  )
                  .join("\n")
              : files.ok
                ? "  (no files reported)"
                : "  (changed files could not be read)",
            ...(moreFiles
              ? [
                  `\n(showing the first ${FORGE_PAGE_SIZE} files; this pull request ` +
                    `touches more)`
                ]
              : [])
          ].join("\n")
        );
      }
    }),

    repo_pr_comment: tool({
      description:
        "Leave a comment on a pull request or issue in the repository you have checked out. Use this to report what you did, or to answer a review — not to announce work you have not finished.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z
          .number()
          .int()
          .positive()
          .describe("Pull request or issue number"),
        body: z.string().describe("The comment, as markdown")
      }),
      execute: async ({ dir, number, body }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        const posted = await forge(
          "repo_pr_comment",
          `/repos/${owner}/${repo}/issues/${number}/comments`,
          { method: "POST", body: { body } }
        );
        if (!posted.ok)
          // The same hazard `repo_open_pr` names, for the same reason: a POST
          // whose answer never arrived may still have been received, and a blind
          // retry is how one comment becomes two.
          return bounded(
            `${posted.message}\nIf this was a timeout rather than a rejection the ` +
              `comment may exist anyway — read it back with repo_issue_view before retrying.`
          );
        const data = posted.data as { html_url?: string };
        return data.html_url ?? `commented on #${number}`;
      }
    })
  };
}
