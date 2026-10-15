import { action, type Action } from "@cloudflare/think";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  actionTask,
  GITHUB_ACTION_TIMEOUT_MS,
  GITHUB_PAGE_SIZE,
  sha256
} from "./context.js";
import type { RepoContext } from "./context.js";

/**
 * Pull requests and issues: opening one over REST, reading one over the hosted
 * MCP server. The split is not arbitrary — see `./mcp.ts` for which operations
 * the allowlist admits and why the write stayed where it was.
 */

/** One comment on an issue or a pull request's timeline. */
interface TimelineComment {
  user?: { login?: string };
  body?: string;
}

export function prTools(ctx: RepoContext): ToolSet {
  const { bounded, github, mcp, githubRepo } = ctx;

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
        const target = await githubRepo(dir);
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
        const existing = await github(
          "repo_open_pr",
          `/repos/${owner}/${repo}/pulls?${filter}`
        );
        const open =
          existing.ok && Array.isArray(existing.data)
            ? (existing.data[0] as { html_url?: string } | undefined)
            : undefined;
        if (open?.html_url)
          return `already open, nothing new was created: ${open.html_url}`;

        const opened = await github(
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
        const target = await githubRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;
        const where = {
          owner: decodeURIComponent(owner),
          repo: decodeURIComponent(repo)
        };

        // `issue_read` deliberately, even for a pull request: GitHub models
        // every PR as an issue, and that is the view carrying the discussion.
        // `repo_pr_view` is for the parts that are only a PR's.
        const issue = await mcp("repo_issue_view", "issue_read", {
          ...where,
          issue_number: number,
          method: "get"
        });
        if (!issue.ok) return bounded(issue.message);
        const data = issue.data as {
          title?: string;
          state?: string;
          user?: { login?: string };
          body?: string;
          html_url?: string;
        };
        // No `pull_request` key on this read, so the kind comes from the URL
        // GitHub builds for it: a pull request's is `/pull/<n>` where an
        // issue's is `/issues/<n>`.
        const isPull = /\/pull\/\d+/.test(data.html_url ?? "");

        const comments = await mcp("repo_issue_view", "issue_read", {
          ...where,
          issue_number: number,
          method: "get_comments",
          perPage: GITHUB_PAGE_SIZE
        });
        // A failure here is not a failure of the tool: the issue itself was
        // read, and half an answer beats none.
        const thread = (
          comments.ok && Array.isArray(comments.data) ? comments.data : []
        ) as TimelineComment[];
        // A full page means there is very likely another. Said out loud, because
        // this thread is what the model reasons from: comments arrive oldest
        // first, so the ones it cannot see are the most recent — the review
        // feedback, on the pull request busy enough to have overflowed.
        const moreComments = thread.length >= GITHUB_PAGE_SIZE;

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"} [${data.state ?? "?"}]` +
              (isPull ? " (pull request)" : ""),
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
                  `\n(showing the first ${GITHUB_PAGE_SIZE} comments; the thread is ` +
                    `longer, and the newest are not among them)`
                ]
              : [])
          ].join("\n")
        );
      }
    }),

    repo_pr_view: tool({
      description:
        "Read a pull request's state, the reviews that have landed on it, and the files it touches — whether it is mergeable, who has reviewed and with what verdict, and which paths changed. Use this to check on a pull request you opened, to see whether a review has arrived before reading its threads, or to see what an existing one does before duplicating it.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number")
      }),
      execute: async ({ dir, number }) => {
        const target = await githubRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;
        const where = {
          owner: decodeURIComponent(owner),
          repo: decodeURIComponent(repo),
          pullNumber: number
        };

        const pr = await mcp("repo_pr_view", "pull_request_read", {
          ...where,
          method: "get"
        });
        if (!pr.ok) return bounded(pr.message);
        const data = pr.data as {
          title?: string;
          state?: string;
          draft?: boolean;
          merged?: boolean;
          mergeable_state?: string;
          head?: { ref?: string };
          base?: { ref?: string };
          html_url?: string;
        };

        const files = await mcp("repo_pr_view", "pull_request_read", {
          ...where,
          method: "get_files",
          perPage: GITHUB_PAGE_SIZE
        });
        const changed = (
          files.ok && Array.isArray(files.data) ? files.data : []
        ) as { filename?: string; additions?: number; deletions?: number }[];
        const moreFiles = changed.length >= GITHUB_PAGE_SIZE;

        // The reviews, because "has one landed yet" is the question an agent
        // watching a pull request between sessions actually has, and an empty
        // list of threads does not answer it: a review can finish having left
        // no comments.
        const reviews = await mcp("repo_pr_view", "pull_request_read", {
          ...where,
          method: "get_reviews",
          perPage: GITHUB_PAGE_SIZE
        });
        const landed = (
          reviews.ok && Array.isArray(reviews.data) ? reviews.data : []
        ) as {
          user?: { login?: string };
          state?: string;
          submitted_at?: string;
        }[];
        // A draft its author has not sent, visible only to whoever holds the
        // token that wrote it. Reporting one as a review names a verdict
        // nobody has read.
        const submitted = landed.filter(
          (r) => (r.state ?? "").toUpperCase() !== "PENDING"
        );
        // Reviews arrive oldest first, so a full page leaves the newest unread
        // — and "has a review landed yet" is what this tool is called for. Said
        // rather than left to the list, which would otherwise read as complete.
        const moreReviews = landed.length >= GITHUB_PAGE_SIZE;

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"}`,
            `${data.merged ? "merged" : (data.state ?? "?")}` +
              (data.draft ? " (draft)" : "") +
              // GitHub computes mergeability asynchronously and reports
              // `unknown` until it has, which is common on a pull request
              // opened seconds ago — exactly when this tool is most likely to
              // be called.
              (data.mergeable_state === undefined ||
              data.mergeable_state === "unknown"
                ? ", mergeability not yet computed"
                : data.mergeable_state === "clean"
                  ? ""
                  : `, mergeable_state ${data.mergeable_state}`),
            `${data.head?.ref ?? "?"} → ${data.base?.ref ?? "?"}`,
            data.html_url ?? "",
            "",
            !reviews.ok
              ? "Reviews: (could not be read)"
              : submitted.length === 0
                ? "Reviews: none has landed yet."
                : [
                    "Reviews:",
                    ...submitted.map(
                      (r) =>
                        `  ${r.user?.login ?? "unknown"} — ${(r.state ?? "?").toLowerCase()}` +
                        `${r.submitted_at ? ` at ${r.submitted_at}` : ""}`
                    )
                  ].join("\n"),
            ...(moreReviews
              ? [
                  `(showing the first ${GITHUB_PAGE_SIZE} reviews; this pull ` +
                    `request has more, and the newest are not among them)`
                ]
              : []),
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
                  `\n(showing the first ${GITHUB_PAGE_SIZE} files; this pull request ` +
                    `touches more)`
                ]
              : [])
          ].join("\n")
        );
      }
    })
  };
}

/**
 * The GitHub writes a recovered turn must not repeat, as Think actions.
 *
 * Every failure is thrown rather than returned. Think settles what an action
 * returns and replays it for the life of the key, so a refusal returned as a
 * string would answer every retry in the task; a throw releases the key, and
 * the retry runs.
 */
export function prActions(ctx: RepoContext): Record<string, Action> {
  const { bounded, github, githubRepo } = ctx;

  const commentInput = z.object({
    dir: z.string().describe("The checkout directory"),
    number: z
      .number()
      .int()
      .positive()
      .describe("Pull request or issue number"),
    body: z.string().describe("The comment, as markdown")
  });

  return {
    repo_pr_comment: action({
      description:
        "Leave a comment on a pull request or issue in the repository you have checked out. Use this to report what you did, or to answer a review — not to announce work you have not finished. The same comment twice in one task is posted once.",
      inputSchema: commentInput,
      timeoutMs: GITHUB_ACTION_TIMEOUT_MS,
      idempotencyKey: async ({ input, ctx: turn }) =>
        `${actionTask(turn)}:${input.dir}#${input.number}:comment:${await sha256(input.body)}`,
      execute: async ({ dir, number, body }) => {
        const target = await githubRepo(dir);
        if ("refusal" in target) throw new Error(target.refusal);
        const { owner, repo } = target;

        const posted = await github(
          "repo_pr_comment",
          `/repos/${owner}/${repo}/issues/${number}/comments`,
          { method: "POST", body: { body } }
        );
        if (!posted.ok)
          // The same hazard `repo_open_pr` names, for the same reason: a POST
          // whose answer never arrived may still have been received. The key
          // is released, so a retry posts again.
          throw new Error(
            bounded(
              `${posted.message}\nIf this was a timeout rather than a rejection the ` +
                `comment may exist anyway — read it back with repo_issue_view before retrying.`
            )
          );
        const data = posted.data as { html_url?: string };
        return data.html_url ?? `commented on #${number}`;
      }
    })
  };
}
