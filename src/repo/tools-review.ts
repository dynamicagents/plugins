import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { FORGE_PAGE_SIZE } from "./context.js";
import type { RepoContext } from "./context.js";

/** A review as a conversation: whether it landed, what it said, and answering it. */

/**
 * How many pages of review threads one `repo_pr_threads` call will walk.
 *
 * A bound rather than a full walk, for the reason {@link FORGE_PAGE_SIZE} is one
 * — but unlike the single page everything else here takes, threads genuinely
 * have to page: a review long enough to spill one puts its newest threads on the
 * last page, and those are exactly the ones an agent was sent to answer. So this
 * is high enough that a real review never reaches it and low enough that a
 * pathological pull request cannot turn one tool call into an unbounded number of
 * round trips.
 */
const MAX_THREAD_PAGES = 10;

/** One comment in a thread. */
interface ThreadComment {
  author?: { login?: string };
  body?: string;
}

/** One review thread, as {@link REVIEW_THREADS_QUERY} selects it. */
interface ReviewThread {
  id: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  /** The comment that opened it — the reviewer's actual point. */
  opening?: { nodes?: ThreadComment[] };
  /** The end of the conversation, including any reply this plugin sent. */
  latest?: { totalCount?: number; nodes?: ThreadComment[] };
}

/**
 * How much of one thread's conversation is read back.
 *
 * Both ends, because the two uses pull opposite ways: what the reviewer asked for
 * is at the top, and whether a reply landed is at the bottom. A thread shorter
 * than this is returned whole and the two selections are the same comments, which
 * is why the render de-duplicates on the count rather than on the text.
 */
const MAX_THREAD_COMMENTS = 6;

/** One page of them. */
interface ThreadPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: ReviewThread[];
}

/** What {@link THREAD_OWNER_QUERY} returns for a thread id. */
interface ThreadOwner {
  pullRequest?: {
    number?: number;
    repository?: { nameWithOwner?: string };
  } | null;
}

/**
 * The review threads on one pull request.
 *
 * `isResolved` is the field the whole workflow turns on and REST does not expose
 * at all — which is why these three operations are GraphQL while everything else
 * in this file is REST. Both ends of each thread are selected; see
 * {@link MAX_THREAD_COMMENTS} for why one end is not enough.
 */
const REVIEW_THREADS_QUERY = `
  query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:${FORGE_PAGE_SIZE},after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{
            id isResolved isOutdated path line
            opening: comments(first:1){nodes{author{login} body}}
            latest: comments(last:${MAX_THREAD_COMMENTS}){totalCount nodes{author{login} body}}
          }
        }
      }
    }
  }`;

/**
 * Who is currently *asked* to review, apps included.
 *
 * REST's `pulls/{n}/requested_reviewers` carries `users` and `teams` and no
 * third key, so a Bot reviewer — Copilot is one — is absent from a request that
 * is live, and its answer for "Copilot is working on it right now" is byte for
 * byte its answer for "nobody was ever asked". GraphQL types the requested
 * reviewer as a union with `Bot` in it, which is what makes the two
 * distinguishable at all.
 */
const REVIEW_REQUESTS_QUERY = `
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewRequests(first:${FORGE_PAGE_SIZE}){
          nodes{
            requestedReviewer{
              ... on User{login}
              ... on Bot{login}
              ... on Team{slug}
            }
          }
        }
      }
    }
  }`;

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

/** One thread, as the model reads it: where it is, its id, and the conversation. */
function renderThread(t: ReviewThread): string {
  const where = t.path
    ? `${t.path}${typeof t.line === "number" ? `:${t.line}` : ""}`
    : "(no file)";
  const total = t.latest?.totalCount ?? 0;
  const tail = t.latest?.nodes ?? [];
  // Whole when it fits, and both ends with the middle named when it does not.
  // The opening comment is the reviewer's actual point and the tail is where a
  // reply this plugin sent would be, so neither end can be the one dropped.
  const conversation =
    total > tail.length
      ? [
          ...(t.opening?.nodes ?? []),
          {
            author: { login: "…" },
            body: `(${total - tail.length - 1} earlier replies not shown)`
          },
          ...tail
        ]
      : tail;

  return [
    `--- ${where}${t.isResolved ? " [resolved]" : ""}${t.isOutdated ? " [outdated]" : ""}`,
    `id: ${t.id}`,
    ...conversation.map(
      (c) => `${c.author?.login ?? "unknown"}: ${c.body ?? ""}`
    )
  ].join("\n");
}

/**
 * The owner and repository as their own names, rather than as REST path segments.
 *
 * {@link forgeRepo} percent-encodes both, because that is what makes a path safe.
 * A GraphQL *variable* is not a path — it is compared against the repository's
 * actual name — so an encoded one would silently stop matching the moment a name
 * contains a character worth encoding.
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

/**
 * The review bot's logins, which GitHub does not spell the same way twice.
 *
 * One account arrives as `Copilot` from the issue timeline, as
 * `copilot-pull-request-reviewer` from GraphQL, and as
 * `copilot-pull-request-reviewer[bot]` from `pulls/{n}/reviews`. Compared
 * exactly against the login a caller names, the request matches and the review
 * never does, so `repo_pr_review_status` reports "none pending — waiting will
 * not change it" at the moment the review lands. That is the one answer a
 * polling caller stops on, so the mismatch does not degrade the tool, it
 * inverts it.
 *
 * An alternation of the spellings that account answers to, and deliberately not
 * a `copilot-` prefix: `copilot-swe-agent` is a **different** account, one that
 * opens pull requests rather than reviewing them, so a prefix would let its
 * request or its authorship answer a question asked about the reviewer.
 */
const COPILOT_LOGIN = /^copilot(-pull-request-reviewer)?$/;

/**
 * Whether a login from the API is the reviewer the caller asked about.
 *
 * `[bot]` is a suffix REST appends to an app's login and GraphQL does not, so it
 * is never part of the identity — stripping it is what lets a caller name any
 * app reviewer the way GitHub's UI shows it.
 */
function sameReviewer(a: string, b: string): boolean {
  const bare = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
  const [x, y] = [bare(a), bare(b)];
  return COPILOT_LOGIN.test(x) && COPILOT_LOGIN.test(y) ? true : x === y;
}

export function reviewTools(ctx: RepoContext): ToolSet {
  const { bounded, forge, forgeGraphql, forgeRepo } = ctx;

  return {
    repo_pr_review_status: tool({
      description:
        "Say whether a reviewer has finished reviewing a pull request in the repository you have checked out. Use it before reading review comments: a review that has not landed has left no comments, and an empty thread list means nothing yet.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number"),
        reviewer: z
          .string()
          .optional()
          .describe(
            'The reviewer to ask about, as their login. Defaults to "Copilot".'
          )
      }),
      execute: async ({ dir, number, reviewer }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;
        const who = reviewer ?? "Copilot";

        // A *pending* request outranks any review already on the pull request,
        // and that ordering is the whole logic here. GitHub clears the request
        // when a review is submitted and writes a new one when a re-review is
        // asked for, so "still requested" is true now and "has reviewed" is
        // about the past. Reading them the other way round reports a re-review
        // as finished the moment it is asked for.
        const requested = await forgeGraphql(
          "repo_pr_review_status",
          REVIEW_REQUESTS_QUERY,
          { owner, repo, number }
        );
        if (!requested.ok) return bounded(requested.message);
        const waiting = (
          requested.data as {
            repository?: {
              pullRequest?: {
                reviewRequests?: {
                  nodes?: {
                    requestedReviewer?: { login?: string; slug?: string };
                  }[];
                };
              };
            };
          }
        ).repository?.pullRequest?.reviewRequests;
        if (!waiting)
          return `#${number} is not a pull request in ${owner}/${repo}`;
        const pending = (waiting.nodes ?? []).some((n) => {
          const name =
            n?.requestedReviewer?.login ?? n?.requestedReviewer?.slug;
          return !!name && sameReviewer(name, who);
        });
        if (pending)
          return `${who} has been asked to review #${number} and has not finished.`;

        const reviews = await forge(
          "repo_pr_review_status",
          `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=${FORGE_PAGE_SIZE}`
        );
        if (!reviews.ok) return bounded(reviews.message);
        const all = reviews.data as {
          user?: { login?: string };
          state?: string;
          submitted_at?: string;
        }[];
        const submitted = all.filter(
          (r) =>
            !!r.user?.login &&
            sameReviewer(r.user.login, who) &&
            // A `PENDING` review is a draft its author has not sent, and it is
            // visible to whoever holds the token that wrote it. Counting one as
            // finished reports a review nobody has read, which is the answer a
            // poll loop acts on by stopping.
            (r.state ?? "").toUpperCase() !== "PENDING"
        );

        const theirs = submitted.at(-1);
        if (!theirs) {
          // The endpoint pages oldest-first, so a match beyond the first page is
          // **newer** than everything read — which is to say it is exactly the
          // review being waited for. So a truncated read cannot answer the
          // question at all, and must not answer it with "waiting will not help":
          // that is the one reply a caller ends its polling on.
          if (all.length >= FORGE_PAGE_SIZE)
            return bounded(
              `#${number} has at least ${FORGE_PAGE_SIZE} reviews and only the oldest were read, ` +
                `so whether ${who} has reviewed it is unknown. Read the pull request itself with repo_pr_view, ` +
                `or look for threads with repo_pr_threads.`
            );
          return bounded(
            `#${number} has no review from ${who}, and none is pending. ` +
              `Nobody asked them, or the request was withdrawn — waiting will not change it.`
          );
        }
        return bounded(
          `${who} reviewed #${number}${theirs.submitted_at ? ` at ${theirs.submitted_at}` : ""}` +
            `${theirs.state ? ` (${theirs.state.toLowerCase()})` : ""}. ` +
            `Read what it said with repo_pr_threads — a review can finish having left no comments.`
        );
      }
    }),

    repo_pr_threads: tool({
      description:
        "Read the review threads on a pull request in the repository you have checked out — the inline comments a reviewer left on specific lines, which are not on the conversation timeline repo_issue_view reads. Unresolved ones only, unless you ask for all.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number"),
        includeResolved: z
          .boolean()
          .optional()
          .describe("Include threads already resolved. Defaults to false.")
      }),
      execute: async ({ dir, number, includeResolved }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = decoded(target);

        const threads: ReviewThread[] = [];
        let after: string | null = null;
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
          const answered:
            { ok: true; data: unknown } | { ok: false; message: string } =
            await forgeGraphql("repo_pr_threads", REVIEW_THREADS_QUERY, {
              owner,
              repo,
              number,
              after
            });
          if (!answered.ok) return bounded(answered.message);
          const page_ = (
            answered.data as {
              repository?: { pullRequest?: { reviewThreads?: ThreadPage } };
            }
          ).repository?.pullRequest?.reviewThreads;
          if (!page_)
            return `#${number} is not a pull request in ${owner}/${repo}`;
          threads.push(...(page_.nodes ?? []));
          if (!page_.pageInfo?.hasNextPage) break;
          after = page_.pageInfo.endCursor ?? null;
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
          : threads.filter((t) => !t.isResolved);
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
    }),

    repo_pr_thread_reply: tool({
      description:
        "Answer one review thread on a pull request in the repository you have checked out, and resolve it. Reply with what you changed and where, or with why you did not — either way the thread ends resolved unless you say otherwise.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number"),
        threadId: z
          .string()
          .describe("The thread's id, exactly as repo_pr_threads printed it"),
        body: z
          .string()
          .optional()
          .describe(
            "The reply, as markdown. Leave it out to resolve a thread you have already replied to."
          ),
        resolve: z
          .boolean()
          .optional()
          .describe("Resolve the thread after replying. Defaults to true.")
      }),
      execute: async ({ dir, number, threadId, body, resolve }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = decoded(target);

        // A thread id is a global node id, so unlike every other tool here this
        // one takes something that can name a pull request in a repository
        // nobody checked out — the reach `forgeRepo` exists to prevent. Checked
        // rather than trusted: the id came from a tool result the model read,
        // and a model that misremembers one must not write into a stranger's
        // review.
        const belongs = await forgeGraphql(
          "repo_pr_thread_reply",
          THREAD_OWNER_QUERY,
          { id: threadId }
        );
        if (!belongs.ok) return bounded(belongs.message);
        const node = (belongs.data as { node?: ThreadOwner | null }).node;
        if (!node?.pullRequest)
          return `${threadId} is not a review thread — read the ids with repo_pr_threads`;
        const at = node.pullRequest.repository?.nameWithOwner ?? "";
        if (
          at.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
          node.pullRequest.number !== number
        )
          return (
            `${threadId} belongs to ${at}#${node.pullRequest.number}, not ${owner}/${repo}#${number}. ` +
            `Read the ids for this pull request with repo_pr_threads.`
          );

        // Resolve-only. The reply and the resolve are two calls, so they fail
        // independently — and the tool that tells a caller "the reply landed,
        // resolve it alone" has to give it a way to do that. Without this the
        // only route back is a second reply the reviewer has already read.
        if (body === undefined) {
          if (resolve === false)
            return "nothing to do: give a body to reply, or leave resolve unset to resolve the thread";
          const only = await forgeGraphql(
            "repo_pr_thread_reply",
            THREAD_RESOLVE_MUTATION,
            { id: threadId }
          );
          return only.ok
            ? `resolved ${threadId}`
            : bounded(`resolving the thread failed: ${only.message}`);
        }

        const replied = await forgeGraphql(
          "repo_pr_thread_reply",
          THREAD_REPLY_MUTATION,
          { id: threadId, body }
        );
        if (!replied.ok)
          // The hazard `repo_pr_comment` names, and worse here: a reply that
          // landed and an answer that did not arrive look identical, and the
          // retry leaves the reviewer two of them.
          return bounded(
            `${replied.message}\nIf this was a timeout rather than a rejection the ` +
              `reply may exist anyway — read the thread back with repo_pr_threads before retrying.`
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
        const resolved = await forgeGraphql(
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
