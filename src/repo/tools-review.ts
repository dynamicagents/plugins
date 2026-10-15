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

/** A review as a conversation: what it said, and answering it. */

/**
 * How many pages of review threads one `repo_pr_threads` call will walk.
 *
 * A bound rather than a full walk, for the reason {@link GITHUB_PAGE_SIZE} is one
 * — but unlike the single page everything else here takes, threads genuinely
 * have to page: a review long enough to spill one puts its newest threads on the
 * last page, and those are exactly the ones an agent was sent to answer. So this
 * is high enough that a real review never reaches it and low enough that a
 * pathological pull request cannot turn one tool call into an unbounded number of
 * round trips.
 */
const MAX_THREAD_PAGES = 10;

/** One comment in a thread, as the MCP read returns it. */
interface ThreadComment {
  author?: string;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

/** One review thread. `is_resolved` is what the whole workflow turns on. */
interface ReviewThread {
  id: string;
  is_resolved?: boolean;
  is_outdated?: boolean;
  comments?: ThreadComment[];
  /** Every comment on the thread, which may exceed those returned. */
  total_count?: number;
}

/** One page of them. */
interface ThreadPage {
  review_threads?: ReviewThread[];
  page_info?: { has_next_page?: boolean; end_cursor?: string | null };
}

/**
 * How much of one thread's conversation is read back.
 *
 * Both ends, because the two uses pull opposite ways: what the reviewer asked for
 * is at the top, and whether a reply landed is at the bottom. A thread shorter
 * than this is returned whole, which is the ordinary case — the read asks for a
 * hundred comments per thread and almost every thread has a handful.
 */
const MAX_THREAD_COMMENTS = 6;

/** What {@link THREAD_OWNER_QUERY} returns for a thread id. */
interface ThreadOwner {
  pullRequest?: {
    number?: number;
    repository?: { nameWithOwner?: string };
  } | null;
}

/** Which pull request, in which repository, a thread id names. */
const THREAD_OWNER_QUERY = `
  query($id:ID!){
    node(id:$id){
      ... on PullRequestReviewThread {
        pullRequest{number repository{nameWithOwner}}
      }
    }
  }`;

const THREAD_REPLY_MUTATION = `
  mutation($id:ID!,$body:String!){
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){
      comment{url}
    }
  }`;

const THREAD_RESOLVE_MUTATION = `
  mutation($id:ID!){
    resolveReviewThread(input:{threadId:$id}){thread{isResolved}}
  }`;

/**
 * One thread, as the model reads it: where it is, its id, and the conversation.
 *
 * Where it is comes from the **first comment** rather than the thread: a thread
 * is a location only through the comments on it, so a thread whose comments did
 * not come back has no file to name.
 */
function renderThread(t: ReviewThread): string {
  const comments = t.comments ?? [];
  const first = comments[0];
  const line = first?.line ?? first?.original_line;
  const where = first?.path
    ? `${first.path}${typeof line === "number" ? `:${line}` : ""}`
    : "(no file)";
  const total = t.total_count ?? comments.length;

  // Whole when it fits, and both ends with the middle named when it does not.
  // The opening comment is the reviewer's actual point and the tail is where a
  // reply this plugin sent would be, so neither end can be the one dropped.
  const shown =
    comments.length > MAX_THREAD_COMMENTS
      ? [
          ...comments.slice(0, 1),
          {
            author: "…",
            body: `(${comments.length - MAX_THREAD_COMMENTS} earlier replies not shown)`
          },
          ...comments.slice(-(MAX_THREAD_COMMENTS - 1))
        ]
      : comments;
  // Said only when the read itself was short of the conversation, which the
  // slice above is not: that one is this render's own choice and both ends
  // survive it.
  const unread =
    total > comments.length
      ? [
          {
            author: "…",
            body: `(${total - comments.length} comments were not read)`
          }
        ]
      : [];

  return [
    `--- ${where}${t.is_resolved ? " [resolved]" : ""}${t.is_outdated ? " [outdated]" : ""}`,
    `id: ${t.id}`,
    ...[...shown, ...unread].map(
      (c) => `${c.author ?? "unknown"}: ${c.body ?? ""}`
    )
  ].join("\n");
}

/**
 * The owner and repository as their own names, rather than as REST path segments.
 *
 * {@link file://./context.ts githubRepo} percent-encodes both, because that is
 * what makes a path safe. A GraphQL *variable* and an MCP argument are not paths
 * — both are compared against the repository's actual name — so an encoded one
 * would silently stop matching the moment a name contains a character worth
 * encoding.
 */
function decoded(target: { owner: string; repo: string }): {
  owner: string;
  repo: string;
} {
  return {
    owner: decodeURIComponent(target.owner),
    repo: decodeURIComponent(target.repo)
  };
}

export function reviewTools(ctx: RepoContext): ToolSet {
  const { bounded, mcp, githubRepo } = ctx;

  return {
    repo_pr_threads: tool({
      description:
        "Read the review threads on a pull request in the repository you have checked out — the inline comments a reviewer left on specific lines, which are not on the conversation timeline repo_issue_view reads. Unresolved ones only, unless you ask for all. An empty answer on a pull request whose review has not landed means nothing yet rather than nothing to do — repo_pr_view says whether one has.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number"),
        includeResolved: z
          .boolean()
          .optional()
          .describe("Include threads already resolved. Defaults to false.")
      }),
      execute: async ({ dir, number, includeResolved }) => {
        const target = await githubRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = decoded(target);

        const threads: ReviewThread[] = [];
        let after: string | undefined;
        let truncated = false;
        // Paged, and that is not an optimisation. A review long enough to spill a
        // page puts its newest threads on the last one — exactly the threads the
        // model was sent to answer — so a single page can report a busy review as
        // clean. The page cap is what stops a pathological pull request becoming
        // an unbounded number of round trips.
        for (let page = 0; ; page++) {
          if (page >= MAX_THREAD_PAGES) {
            truncated = true;
            break;
          }
          const answered = await mcp("repo_pr_threads", "pull_request_read", {
            owner,
            repo,
            pullNumber: number,
            method: "get_review_comments",
            perPage: GITHUB_PAGE_SIZE,
            ...(after ? { after } : {})
          });
          if (!answered.ok) return bounded(answered.message);
          const page_ = answered.data as ThreadPage;
          if (!page_?.review_threads)
            return `#${number} is not a pull request in ${owner}/${repo}`;
          threads.push(...page_.review_threads);
          if (!page_.page_info?.has_next_page) break;
          after = page_.page_info.end_cursor ?? undefined;
          if (!after) break;
        }

        // Said once, and said on **every** exit including the empty one. A run
        // that stopped early and found nothing open in what it did read must not
        // answer "nothing to do": the unread pages are exactly where the newest
        // threads are, which is the false-clean result the paging exists to
        // prevent — reintroduced at the one exit that skipped the warning.
        const unread = truncated
          ? `\n\n(stopped after ${MAX_THREAD_PAGES} pages, so this is not the whole review — there are more threads than were read)`
          : "";

        const shown = includeResolved
          ? threads
          : threads.filter((t) => !t.is_resolved);
        if (shown.length === 0)
          return bounded(
            (includeResolved
              ? `#${number} has no review threads.`
              : `#${number} has no unresolved review threads.` +
                (threads.length > 0
                  ? ` (${threads.length} resolved — pass includeResolved to read them.)`
                  : "")) + unread
          );

        const rendered = shown.map((t) => renderThread(t)).join("\n\n");

        return bounded(rendered + unread);
      }
    })
  };
}

/**
 * Answering a thread, as a Think action — see
 * {@link file://./tools-pr.ts prActions} for why every failure is
 * thrown. The one outcome returned short of success is a reply that landed on
 * a thread that did not resolve: that reply must never be sent again, so it is
 * settled, and the resolve-only call it asks for is a different key.
 *
 * **Still GraphQL, and still this plugin's own.** Replying and resolving have no
 * REST equivalent, and the hosted MCP server offers them only under a tool that
 * also submits reviews — `APPROVE` included — which is a grant nothing here
 * wants. See `./mcp.ts`. Not installed on claude-coordinator, whose revising
 * Claude Code sessions answer their own reviews from inside their containers.
 */
export function reviewActions(ctx: RepoContext): Record<string, Action> {
  const { bounded, githubGraphql, githubRepo } = ctx;

  const replyInput = z.object({
    dir: z.string().describe("The checkout directory"),
    number: z.number().int().positive().describe("Pull request number"),
    threadId: z
      .string()
      .describe("The thread's id, exactly as repo_pr_threads printed it"),
    body: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The reply, as markdown. Leave it out to resolve a thread you have already replied to."
      ),
    resolve: z
      .boolean()
      .optional()
      .describe("Resolve the thread after replying. Defaults to true.")
  });

  return {
    repo_pr_thread_reply: action({
      description:
        "Answer one review thread on a pull request in the repository you have checked out, and resolve it. Reply with what you changed and where, or with why you did not — either way the thread ends resolved unless you say otherwise. The same reply to one thread twice in one task is sent once.",
      inputSchema: replyInput,
      timeoutMs: GITHUB_ACTION_TIMEOUT_MS,
      // The thread and the resolve flag as well as the body, or the same reply
      // to two threads — "Fixed." — would be one key.
      idempotencyKey: async ({ input, ctx: turn }) =>
        `${actionTask(turn)}:${input.dir}#${input.number}:${input.threadId}:` +
        `${await sha256(input.body ?? "")}:${input.resolve ?? true}`,
      execute: async ({ dir, number, threadId, body, resolve }) => {
        const target = await githubRepo(dir);
        if ("refusal" in target) throw new Error(target.refusal);
        const { owner, repo } = decoded(target);

        // A thread id is a global node id, so unlike every other tool here this
        // one takes something that can name a pull request in a repository
        // nobody checked out — the reach `githubRepo` exists to prevent. Checked
        // rather than trusted: the id came from a tool result the model read,
        // and a model that misremembers one must not write into a stranger's
        // review.
        const belongs = await githubGraphql(
          "repo_pr_thread_reply",
          THREAD_OWNER_QUERY,
          { id: threadId }
        );
        if (!belongs.ok) throw new Error(bounded(belongs.message));
        const node = (belongs.data as { node?: ThreadOwner | null }).node;
        if (!node?.pullRequest)
          throw new Error(
            `${threadId} is not a review thread — read the ids with repo_pr_threads`
          );
        const at = node.pullRequest.repository?.nameWithOwner ?? "";
        if (
          at.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
          node.pullRequest.number !== number
        )
          throw new Error(
            `${threadId} belongs to ${at}#${node.pullRequest.number}, not ${owner}/${repo}#${number}. ` +
              `Read the ids for this pull request with repo_pr_threads.`
          );

        // Resolve-only. The reply and the resolve are two calls, so they fail
        // independently — and the tool that tells a caller "the reply landed,
        // resolve it alone" has to give it a way to do that. Without this the
        // only route back is a second reply the reviewer has already read.
        if (body === undefined) {
          if (resolve === false)
            throw new Error(
              "nothing to do: give a body to reply, or leave resolve unset to resolve the thread"
            );
          const only = await githubGraphql(
            "repo_pr_thread_reply",
            THREAD_RESOLVE_MUTATION,
            { id: threadId }
          );
          if (!only.ok)
            throw new Error(
              bounded(`resolving the thread failed: ${only.message}`)
            );
          return `resolved ${threadId}`;
        }

        const replied = await githubGraphql(
          "repo_pr_thread_reply",
          THREAD_REPLY_MUTATION,
          { id: threadId, body }
        );
        if (!replied.ok)
          // The hazard `repo_pr_comment` names, and worse here: a reply that
          // landed and an answer that did not arrive look identical, and the
          // retry leaves the reviewer two of them.
          throw new Error(
            bounded(
              `${replied.message}\nIf this was a timeout rather than a rejection the ` +
                `reply may exist anyway — read the thread back with repo_pr_threads before retrying.`
            )
          );
        const url =
          (
            replied.data as {
              addPullRequestReviewThreadReply?: { comment?: { url?: string } };
            }
          ).addPullRequestReviewThreadReply?.comment?.url ?? "(no url)";

        if (resolve === false) return `replied: ${url} (left unresolved)`;

        // Reported separately, never folded into the reply's own failure: a
        // thread that was answered and not resolved needs resolving, and one
        // that was never answered needs answering. Saying "it failed" covers
        // both and tells the model to do the wrong one.
        const resolved = await githubGraphql(
          "repo_pr_thread_reply",
          THREAD_RESOLVE_MUTATION,
          { id: threadId }
        );
        if (!resolved.ok)
          return bounded(
            `replied: ${url}\nbut resolving the thread failed: ${resolved.message}\n` +
              `The reply has landed — do not send it again. Call repo_pr_thread_reply on the same ` +
              `threadId with no body to resolve it on its own.`
          );
        return `replied and resolved: ${url}`;
      }
    })
  };
}
