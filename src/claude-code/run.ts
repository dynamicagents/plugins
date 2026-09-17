import { shellQuote } from "@cloudflare/computer";
import type {
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions
} from "@cloudflare/computer";
import type { ProgressEvent } from "@dynamicagents/core/subtasks";
import {
  parseStream,
  toProgress,
  RATE_LIMIT_OK,
  type ClaudeCodeResult,
  type RateLimitInfo
} from "./events.js";
import {
  DEFAULT_PERMISSION_MODE,
  type EffortLevel,
  type PermissionMode
} from "./config.js";

/**
 * Launching Claude Code in the workspace container, and draining it in windows.
 *
 * ## One Dynamic Agents subtask is one `claude -p` session
 *
 * Not one turn, and not one tool call. The unit has to be substantial because of
 * what an invocation costs before it does anything: the harness carries an
 * 18.7-27k token cached prefix, and a ten-call burst billed **twenty** raw input
 * tokens against 187,130 cache reads. On anything short the prefix is the bill.
 *
 * ## Detached, then re-attached — never owned by a request
 *
 * The run is spawned under an exec id and left running. Each chunk re-attaches,
 * drains for a bounded window, and returns. That shape is not a preference: a
 * drain owned by an RPC that returns in milliseconds gets disposed mid-command,
 * which is exactly how the dependency install used to die halfway through
 * `npm ci`.
 *
 * ## The cursor
 *
 * `getExec(id, { resume })` accepts `"tail"`, `"full"` **or an event sequence
 * number**, and the number is what this uses. Each chunk records the last `seq`
 * it consumed, so the next one resumes exactly there instead of replaying an
 * arbitrary tail. Replay still happens when a chunk dies before it can
 * checkpoint, which is why the progress keys stay positional (see
 * `toProgress`); the cursor makes replay rare, the keys make it harmless.
 *
 * The cursor also carries the **exec id** and the **parsed result**, and both
 * are there for reasons that only show up under concurrency or retry — see
 * {@link DrainCursor}.
 */

/**
 * Just enough of a workspace runtime to drive one detached session.
 *
 * Structural rather than `@cloudflare/computer`'s `WorkspaceRuntime`, for the
 * reason `InstallProbe` is structural one folder over: the class is not exported
 * as a type, it carries a dozen members none of this needs, and a spec that has
 * to construct one cannot test a drain without a container. Three methods is the
 * whole dependency.
 */
export interface SessionRuntime {
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<"utf8">
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<"utf8">
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  killExec(id: string, options?: WorkspaceRuntimeKillOptions): Promise<void>;
}

/** Namespace for every session exec id in a workspace. */
export const CLAUDE_EXEC_PREFIX = "claude-code-run";

/**
 * The exec id one session occupies.
 *
 * **Per subtask, not fixed**, and the difference is load-bearing. A workspace is
 * one Durable Object and one container, but subtasks are a flat *concurrent*
 * fan-out — two `claude-code` subtasks for the same caller and repository run at
 * the same time, against the same workspace. Under a single shared id they
 * would spawn over one another, each drain would attach to whichever exec won,
 * and `killRun` would stop somebody else's session. That is the displacement bug
 * the coder's install guard exists to prevent, in a new place; here the answer
 * is simply not to share the id.
 *
 * Fixed *per subtask*, though, because the point is still to find it again: an
 * isolate that dies mid-drain leaves the session running in the container, and
 * `getExec` is how the next chunk re-attaches instead of starting a second one.
 */
export function execIdFor(subtaskId: string | number): string {
  return `${CLAUDE_EXEC_PREFIX}:${subtaskId}`;
}

/**
 * What the container is given instead of a credential.
 *
 * Claude Code does not validate it locally — proven in the Phase 0c spike, where
 * a run with this exact value succeeded and the proxy log confirmed the
 * container only ever sent the placeholder. The egress gateway swaps in the real
 * credential on the way out, so a `postinstall` script that dumps the
 * environment learns this and nothing else.
 *
 * Shaped like a real token deliberately: something that looks obviously fake
 * invites a future reader to "fix" it by putting the real one there.
 */
export const CREDENTIAL_PLACEHOLDER = "sk-ant-oat01-" + "0".repeat(24);

/**
 * The environment key a host may not set.
 *
 * `LaunchOptions.env` is merged last so a deployment can add what a repository
 * needs, and that merge is exactly how the placeholder could be replaced by a
 * real credential — silently, and in every container from then on. The whole
 * design rests on the container holding nothing worth stealing, so this one key
 * is refused rather than overridden.
 */
const RESERVED_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

export interface LaunchOptions {
  /** The subtask's prompt — the whole of what this session is asked to do. */
  prompt: string;
  /** Where the checkout is. The session runs with this as its cwd. */
  dir: string;
  model?: string;
  /**
   * How hard the model thinks, per turn. Unset, the model's own default.
   *
   * See {@link file://./config.ts ClaudeCodeConfig.effort} for what a level
   * costs, and why an unrecognised one is worse here than a rejected one.
   */
  effort?: EffortLevel;
  /**
   * Caps on Claude Code's own subagent tree.
   *
   * These steer rather than enforce, and the distinction matters: the inner
   * tree is invisible to Dynamic Agents' scheduler and unreachable by its
   * cancellation sweep, so a cap it chooses to ignore has no backstop. What
   * actually bounds the spend is the egress gateway, which every inner call
   * also crosses.
   */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;
  /**
   * How the session answers its own permission prompts.
   *
   * Defaults to {@link DEFAULT_PERMISSION_MODE}. See
   * {@link file://./config.ts ClaudeCodeConfig.permissionMode} for why the
   * default is the permissive one, and {@link buildLaunch} for the root guard
   * that decides how it has to be passed.
   */
  permissionMode?: PermissionMode;
  /**
   * Merged last, so a host can add what a repository needs.
   *
   * **Never secrets**, and {@link RESERVED_ENV_KEY} is refused outright rather
   * than trusted to the reader of that sentence.
   */
  env?: Record<string, string>;
}

export interface Launch {
  command: string;
  env: Record<string, string>;
}

/**
 * Build the command and environment for one session.
 *
 * `--output-format stream-json` with `--verbose`, because the stream is the only
 * way to report progress before the run ends and a run legitimately lasts longer
 * than any single chunk. `--verbose` is required: without it Claude Code emits
 * only the final result even in stream mode.
 *
 * Note what is **absent**. No `--bare`, no `--settings` override, no
 * `CLAUDE_CONFIG_DIR`: a cloned repository's `CLAUDE.md`, skills and hooks are
 * exactly the material that makes the agent good at that repository, and the
 * container is already an arbitrary-code-execution environment by design — the
 * install runs the repo's `postinstall`, the agent runs its test suite. Stripping
 * one door while the others stand open buys nothing and costs the agent its
 * context. (§4 of the design plan, cancelled 2026-08-21.)
 *
 * No `ANTHROPIC_BASE_URL` either, and that one is a genuine simplification over
 * the spike: `http-gateway` egress intercepts transparently, so the client talks
 * to the real hostname and the gateway sees it. Nothing has to be told to use a
 * proxy, which means nothing in the container can be told *not* to.
 *
 * ## `--permission-mode`, and the root guard behind it
 *
 * `-p` is headless. There is no terminal, so there is nobody to answer a
 * permission prompt — and Claude Code's headless path does not wait for one, it
 * **auto-denies**. Left unset the mode is `default`, and `default` gates Write,
 * Edit and every Bash command. A session in that state reads the repository
 * perfectly and cannot change one byte of it, while reporting prose that reads
 * like considered reluctance rather than a blocked tool. That cost this
 * deployment a day of "the container is fixed but nothing lands".
 *
 * So the mode is passed explicitly, and {@link DEFAULT_PERMISSION_MODE} is
 * `bypassPermissions` — see
 * {@link file://./config.ts ClaudeCodeConfig.permissionMode} for why the
 * permissive value is the correct default here rather than a concession.
 *
 * **`IS_SANDBOX=1` ships in the same branch as the flag, and separating the two
 * breaks a session harder than passing no flag at all.** The container runs as
 * root, and the CLI refuses to bypass its permission checks under uid 0 unless
 * that variable is set: it calls `process.exit(1)` **before the first JSON
 * line**, with the only explanation on stderr. The failure then surfaces as
 * "exited with code 1 without reporting a result" and names nothing. One branch
 * below writes both so they cannot drift, and the variable is applied *after* a
 * host's `env` so a host cannot unset the thing making its own mode work.
 *
 * `IS_SANDBOX` has one other documented effect in this client: a repeated API
 * `529` stops raising the custom overload error and keeps retrying instead.
 * Harmless here — the egress gateway is what decides when to give up.
 *
 * The alternative is an image that does not run as root, which is a real option
 * and a much larger one: the FUSE mount, the checkout and every install path
 * currently assume uid 0. If that ever changes, this variable is the line to
 * delete.
 */
export function buildLaunch(options: LaunchOptions): Launch {
  /**
   * Refused rather than silently dropped.
   *
   * A host that set this meant something by it, and the something is always
   * wrong — the placeholder is what makes the container safe to run a
   * stranger's `postinstall` in. The config is static, so this fails on the
   * first run in development rather than surprising a live task.
   */
  if (options.env && RESERVED_ENV_KEY in options.env) {
    throw new Error(
      `claude-code: ${RESERVED_ENV_KEY} cannot be set through \`env\`. The ` +
        "container is launched with a placeholder and the egress gateway swaps " +
        "in the real credential on the way out; putting a real one here would " +
        "hand it to every process in the container, including a cloned " +
        "repository's install scripts. Pass it as `credential` instead."
    );
  }

  const permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;

  const argv = ["claude", "-p", shellQuote(options.prompt)];
  argv.push("--output-format", "stream-json", "--verbose");
  argv.push("--permission-mode", permissionMode);
  if (options.model) argv.push("--model", shellQuote(options.model));
  if (options.effort) argv.push("--effort", options.effort);

  const env: Record<string, string> = {
    // Pinned image; an autoupdate would move the wire shape the gateway and the
    // parser are both written against, mid-run and without a deploy.
    DISABLE_AUTOUPDATER: "1",
    // Telemetry and feature-flag fetches. Turned off at the source so an
    // egress-restricted deployment does not fill its logs with 403s that mean
    // nothing.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  if (options.maxSubagentDepth !== undefined)
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(options.maxSubagentDepth);
  if (options.maxConcurrentSubagents !== undefined)
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(
      options.maxConcurrentSubagents
    );

  return {
    command: argv.join(" "),
    // The last two are applied **after** the host's environment rather than
    // before it. For the placeholder that makes the guard above a second line
    // rather than the only one; for `IS_SANDBOX` it means a host cannot unset
    // the variable its own permission mode depends on — see the note above.
    env: {
      ...env,
      ...options.env,
      ...(permissionMode === "bypassPermissions"
        ? { IS_SANDBOX: "1" }
        : undefined),
      [RESERVED_ENV_KEY]: CREDENTIAL_PLACEHOLDER
    }
  };
}

/** Where a drain got to. Persisted between chunks by the caller. */
export interface DrainCursor {
  /**
   * The exec id this session occupies.
   *
   * Carried rather than derived so a re-attach cannot compute a different one
   * from the subtask id it happens to have in hand.
   */
  execId: string;
  /** The last event sequence consumed; the next chunk resumes from here. */
  seq: number;
  /** Bytes after the last newline — an incomplete line the next read finishes. */
  carry: string;
  /** Progress notes emitted so far. The base for the positional keys. */
  emitted: number;
  /**
   * The `result` line, once seen.
   *
   * Carried because it and the `exit` event are two separate events and a window
   * can end between them. Without this a run whose result arrived in the last
   * moments of one chunk reports a terminal outcome with **no result** in the
   * next — and `persistResult` converts an empty report into a failure, so a
   * successful session would be recorded as a failed one.
   */
  result?: ClaudeCodeResult;
  /**
   * A bounded slice of the session's stderr, for the runs that explain
   * themselves nowhere else.
   *
   * stderr is not the protocol stream and is never parsed as one — see
   * `consume` below. It is kept for exactly one case: a process that exits
   * **before** emitting a `result` line, where the JSON stream holds nothing and
   * the only account of what happened is the text the CLI printed on its way
   * out. A bad flag, a refused permission mode under root, a Node crash. Without
   * this the caller can only report an exit code.
   *
   * Carried on the cursor rather than kept local because the death and the exit
   * event can land in different windows.
   */
  stderr?: string;
}

/** A cursor for a session that has not started yet. */
export function freshCursor(execId: string): DrainCursor {
  return { execId, seq: 0, carry: "", emitted: 0 };
}

/**
 * Whether a bucket reading says anything the last one did not.
 *
 * Every field, because each is separately actionable: the status decides whether
 * a credential is worth using, `resetsAt` is when it recovers, the type says
 * which bucket is talking, and the overage pair says whether spending past it is
 * allowed and why not. Comparing only the status would hold a rollover — a new
 * `resetsAt` under an unchanged `allowed` — out of the logs entirely.
 *
 * **Over the keys rather than a written-out list**, which is the difference
 * between one bug and a class of them: a field added to
 * {@link RateLimitInfo} and forgotten here does not make a smaller log, it makes
 * a change to the reading that never reaches a log at all — the one failure this
 * function exists to prevent, and a silent one. Shallow is exact because the
 * reading is flat and every value on it is a primitive; a nested field would
 * need this revisited, and the parser is where that would be decided.
 */
function changedReading(
  previous: RateLimitInfo | undefined,
  next: RateLimitInfo
): boolean {
  if (previous === undefined) return true;
  const before: Record<string, unknown> = { ...previous };
  const after: Record<string, unknown> = { ...next };
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].some(
    (key) => before[key] !== after[key]
  );
}

/** Distinguishes "the window ran out" from a real stream event in the race below. */
const WINDOW_EXPIRED = Symbol("window-expired");

export type DrainOutcome =
  | {
      done: false;
      cursor: DrainCursor;
      progress: ProgressEvent[];
      /**
       * The bucket as the client reported it **during this window**, if it did.
       *
       * Deliberately not carried on the cursor the way `result` is. A caller
       * acts on this against whichever credential is leading *now*, so a reading
       * replayed on every later chunk would let one window's observation retire
       * a credential that was not even in use when it was taken. Absent means
       * "this window learned nothing", which is the honest answer.
       */
      rateLimit?: RateLimitInfo;
    }
  | {
      done: true;
      cursor: DrainCursor;
      progress: ProgressEvent[];
      /** The bucket as reported **in this window**. See the `done: false` arm. */
      rateLimit?: RateLimitInfo;
      exitCode: number;
      /** Absent when the process died without ever emitting a `result` line. */
      result?: ClaudeCodeResult;
      /**
       * What the process printed on stderr, bounded — only when there is no
       * `result` to explain the exit. Present on the terminal outcome alone
       * because that is the only place a caller has nothing else to report.
       */
      stderr?: string;
    };

export interface DrainOptions {
  /**
   * How long this chunk may block before checkpointing and yielding.
   *
   * Must stay comfortably under the Workflow step timeout, and it is what stops
   * a run burning its whole chunk allowance in seconds: a drain that returned
   * the moment it had nothing to read would exhaust `MAX_CHUNKS_PER_BRANCH`
   * before the session finished thinking.
   *
   * **It is not the reporting interval**, and reading it as one is the mistake
   * {@link DrainOptions.onProgress} exists to remove: a session that finishes
   * inside a single window reaches no boundary at all, so a caller with nothing
   * but the outcome learns everything at once, once the work is over.
   */
  windowMs: number;
  /**
   * Called with each note as it is parsed, rather than with all of them when the
   * window ends.
   *
   * Notes are still returned on the outcome as well — a caller that does not
   * pass this keeps exactly the old behaviour — so a caller that posts from here
   * must drop what it is handed back, or the same note is posted twice. The keys
   * are positional, so the gatekeeper would dedupe it, but paying for the second
   * post to be discarded is not a plan.
   *
   * **Never awaited inside the read loop.** A post is a signed round trip to the
   * gatekeeper — measured at ~700 ms — and awaiting one per note would stall
   * reading the container's stream for as long as the session is talkative.
   * Calls are chained instead, so they stay in order, and the chain is settled
   * before the drain returns.
   */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
  /**
   * Called with a cursor that is safe to persist, no more often than
   * {@link CHECKPOINT_MIN_MS}.
   *
   * **Only meaningful alongside `onProgress`, and that coupling is the whole
   * point.** A caller normally commits the cursor after the drain returns,
   * because a cursor written ahead of consuming events would skip events a retry
   * never saw. A cursor offered here names a position whose notes have *already
   * been handed to the sink*, so resuming from it loses nothing a person saw —
   * which is only true because the sink posted them.
   *
   * Without it, a chunk that dies mid-window resumes from the last committed
   * position, which is wherever the previous window ended. One production run
   * lost six and a half minutes of a session that way and re-derived it by
   * replaying the whole stream.
   */
  onCheckpoint?: (cursor: DrainCursor) => void | Promise<void>;
  now?: () => number;
}

/**
 * How rarely a drain offers a cursor to persist.
 *
 * A checkpoint is a Durable Object storage write, and the stream can carry many
 * events a second while a session reads files — so this is a floor on the writes,
 * not a schedule for them. Sized against what it is protecting: the loss it
 * bounds is re-drained in seconds, so buying a smaller bound with a write per
 * event would cost more than the bound is worth.
 */
const CHECKPOINT_MIN_MS = 30_000;

/** Whether a thrown value is the runtime refusing to reuse a live exec id. */
function isExecBusy(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "EEXEC_BUSY";
}

/**
 * Whether a thrown value means the session this cursor names is gone for good.
 *
 * `EEXEC_LOST` is the runtime saying the container that held the execution was
 * replaced. The session died with it, and no attachment will ever find it — so
 * unlike `EEXEC_BUSY`, which is a live session reached the wrong way, there is
 * nothing to recover and retrying only spends chunks discovering that again.
 */
export function isExecLost(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "EEXEC_LOST";
}

/**
 * Whether a thrown value is the *previous* window's attachment, not yet released.
 *
 * An exec's event stream admits one subscriber at a time. A chunk boundary asks
 * for the next one within milliseconds of the last one returning, and the
 * release on the far side is asynchronous and unobservable from here — the
 * workspace client carries `Symbol.dispose`, not `Symbol.asyncDispose`, so
 * there is nothing a caller can await to know the attachment is gone. So the
 * boundary races the teardown every time, and {@link attachRun} answers by
 * waiting rather than by failing.
 *
 * **Matched on the message, not on a code, and that is not laziness.** This one
 * is raised inside the container image rather than by the runtime client: the
 * string appears nowhere in the Worker bundle, and it arrives at a Workflow step
 * as a plain `Error` with no `code` — unlike `EEXEC_BUSY` and `EEXEC_LOST`
 * above, which the client throws and codes. The code is checked first anyway, so
 * the day the container starts sending one this keeps working and the string
 * test becomes the fallback it should have been.
 */
function isExecSubscribed(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e?.code === "EEXEC_SUBSCRIBED") return true;
  return (
    typeof e?.message === "string" &&
    e.message.includes("already has a live subscriber")
  );
}

/**
 * How long {@link attachRun} waits out a subscriber that has not been released.
 *
 * Bounded, because what it is waiting on may not be a teardown at all: an
 * isolate that is genuinely wedged holding the stream releases it when it dies,
 * and nothing here can tell that apart from one that is a moment from
 * finishing. Exceeding this rethrows, so the Workflow step retries with a fresh
 * isolate — which is the right escalation, and the one this whole mechanism
 * exists to stop being the *first* resort.
 *
 * Sized well above what the race costs in practice. The boundary normally clears
 * on the first or second look, and a deployment where it took fifteen seconds is
 * what this is sized to outlast.
 */
const ATTACH_MAX_MS = 30_000;

/** The first gap between attach attempts, doubled up to {@link ATTACH_CAP_MS}. */
const ATTACH_BACKOFF_MS = 250;

/**
 * The ceiling on that doubling.
 *
 * Without it the last gap before {@link ATTACH_MAX_MS} would be most of the
 * budget, so a subscriber released early in it would still be waited out to the
 * end. What this buys is that the wait ends soon after the release, rather than
 * at the next power of two.
 */
const ATTACH_CAP_MS = 2_000;

/**
 * Start a session, detached.
 *
 * **Falls back to attaching when the id is already live**, which is not a
 * nicety. `start` spawns and then drains for minutes, so a chunk that fails
 * anywhere after the spawn is retried by the Workflow with no cursor to resume
 * from — and `@cloudflare/computer` refuses to reuse an id whose execution is
 * still running (`EEXEC_BUSY`). Without this the retry throws, every later retry
 * throws the same way, and a perfectly healthy session in the container becomes
 * unreachable.
 *
 * **The sync stays on the default, and `defer` is not an option here.** A
 * deferred exec skips the post-command pull entirely and settles the outcome
 * from the cursor instead — and its `cancel` reads the stream to the end first,
 * so ending a window would block until the session exits rather than yielding
 * the chunk. Both halves are exactly what this drain is built not to do.
 */
export async function startRun(
  runtime: SessionRuntime,
  options: LaunchOptions & { execId: string; timeoutMs: number }
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  const { command, env } = buildLaunch(options);
  try {
    return await runtime.exec(command, {
      id: options.execId,
      cwd: options.dir,
      encoding: "utf8",
      env,
      timeoutMs: options.timeoutMs
    });
  } catch (err) {
    if (!isExecBusy(err)) throw err;
    console.info(
      "[claude-code] a session is already running under this id — attaching",
      { execId: options.execId }
    );
    return await attachRun(runtime, freshCursor(options.execId));
  }
}

/** The clock and the wait, injectable so a spec can drive the bound. */
export interface AttachOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Re-attach to a session this isolate did not start.
 *
 * **Waits out a subscriber the previous window has not released yet**, and that
 * wait is the point of this function rather than a refinement of it. The
 * alternative is not "fail fast" — it is spending a Workflow retry to discover a
 * condition that clears on its own in a second, when a chunk step's retries are
 * what a deploy, a severed stub and a network drop have to be covered out of.
 * Core sizes that budget and says why; what matters here is that this must not
 * be charged to it. A deployment lost a twenty-one-minute session exactly that
 * way — consecutive attach races used the retries up, and the redeploy that
 * followed had no attempt left to be retried on. See {@link isExecSubscribed}.
 *
 * Everything else is rethrown on the first look, `EEXEC_LOST` above all: it is
 * the runtime saying the container was replaced, `resume` turns it into a report
 * for the model, and a retry loop would sit on it for {@link ATTACH_MAX_MS}
 * learning nothing.
 */
export async function attachRun(
  runtime: SessionRuntime,
  cursor: DrainCursor,
  options: AttachOptions = {}
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const deadline = now() + ATTACH_MAX_MS;
  let backoff = ATTACH_BACKOFF_MS;

  for (;;) {
    try {
      return await runtime.getExec(cursor.execId, {
        encoding: "utf8",
        // `0` is a legal seq and also the beginning, so a fresh cursor resumes
        // from the start either way. Later chunks name their own place.
        resume: cursor.seq
      });
    } catch (err) {
      // Rethrown rather than retried once the budget is gone, so the step still
      // fails on a subscriber that is never coming back — just not first.
      if (!isExecSubscribed(err) || now() >= deadline) throw err;
      // Clamped to what is left, so the last gap lands *on* the deadline rather
      // than past it. Uncapped, a schedule whose final doubling straddles the
      // bound would take one more look on the far side of it — and the bound
      // would be a number in a comment rather than one the code keeps.
      const waitMs = Math.min(backoff, deadline - now());
      // One line per wait, not per attempt: this is the condition whose
      // frequency is worth watching, and it went unnamed in the logs for as
      // long as the Workflow was absorbing it a retry at a time.
      console.info(
        "[claude-code] the previous window is still attached — waiting",
        { execId: cursor.execId, waitMs }
      );
      await wait(waitMs);
      backoff = Math.min(backoff * 2, ATTACH_CAP_MS);
    }
  }
}

/**
 * Drain a session for one bounded window.
 *
 * Returns `done: false` when the window expired with the process still running —
 * the caller checkpoints the cursor and comes back — or `done: true` once the
 * stream has finished.
 */
export async function drainRun(
  handle: WorkspaceRuntimeExecHandle<"utf8">,
  cursor: DrainCursor,
  options: DrainOptions
): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.windowMs;

  const reader = handle.getReader();
  /**
   * The window's notes, in order — built as the stream is parsed rather than
   * from a list of events at the end, so there is one place a note is numbered
   * and the sink below cannot disagree with what is returned.
   */
  const progress: ProgressEvent[] = [];
  let emitted = cursor.emitted;
  let buffer = cursor.carry;
  let seq = cursor.seq;
  let result = cursor.result;
  // This window's reading only — see `DrainOutcome`. Starting undefined also
  // means the first reading of each window reaches the log, which is what keeps
  // a resumed session's bucket visible without carrying a stale one forward.
  let rateLimit: RateLimitInfo | undefined;
  let stderr = cursor.stderr ?? "";
  let exitCode: number | undefined;
  let checkpointedAt = now();
  /**
   * The sink's calls, chained rather than awaited.
   *
   * Ordering matters — these are sentences in a conversation — and a post is a
   * signed round trip, so awaiting one inside the read loop would stall the
   * drain for as long as the session keeps talking. Failures are swallowed here
   * because the sink's own contract is best-effort; settled before the drain
   * returns, so nothing is cut short when the RPC unwinds.
   */
  let sunk: Promise<void> = Promise.resolve();

  /**
   * Parse whatever complete lines the buffer now holds.
   *
   * Called after **every** stdout event rather than once at the end. Claude
   * Code's stream carries whole tool results, so a chunk that only parsed on the
   * way out would hold an eight-minute transcript of a noisy build in a Durable
   * Object's memory; parsing eagerly keeps only `carry`, which is at most one
   * incomplete line.
   */
  const absorb = (): void => {
    const parsed = parseStream(buffer);
    buffer = parsed.carry;
    for (const event of parsed.events) {
      if (event.kind === "result") result = event.result;
      if (event.kind === "rateLimit") {
        /**
         * Logged when the reading **changes**, not per line — and a change is
         * any field of it, not just the status: a bucket rolling over moves
         * `resetsAt` while saying `allowed` throughout, and the new reset is
         * the useful half of that line.
         *
         * The client repeats itself for as long as a session runs, so a log per
         * event would be the noisiest thing this package writes and every copy
         * after the first would say the same thing. A change is the whole signal:
         * the first reading names the bucket and when it refills, and the only
         * other one that can happen is the bucket saying no — which is the line
         * nobody has captured yet, and the one the pool needs before it can be
         * trusted to act on a status rather than on a refused request.
         */
        if (changedReading(rateLimit, event.info)) {
          const at = { execId: cursor.execId, ...event.info };
          // An unrecognised status is **not** reported as a refusal. Nothing
          // here knows what one means, and a log that calls it exhaustion is
          // how a healthy credential gets retired by the next person to read
          // it. See `RATE_LIMIT_OK`.
          if (event.info.status === RATE_LIMIT_OK)
            console.info("[claude-code] subscription bucket", at);
          else
            console.warn("[claude-code] unrecognised subscription status", at);
        }
        rateLimit = event.info;
      }
    }
    // Numbered from the running total, so a note has the same key whether it is
    // posted from here or returned on the outcome — and the same key again when
    // a retry replays this part of the stream, which is what makes the duplicate
    // harmless. See `toProgress`.
    for (const note of toProgress(parsed.events, emitted)) {
      progress.push(note);
      emitted++;
      const sink = options.onProgress;
      if (sink) sunk = sunk.then(() => sink(note)).catch(() => {});
    }
    if (parsed.skipped > 0) {
      // Not fatal, and deliberately not silent: a systematic schema change
      // shows up here as a rising count long before it shows up as a run that
      // reports nothing.
      //
      // **The sample is the half that makes this actionable.** For a release
      // this warning fired on every session in the deployment with
      // `skipped: 1`, which told an operator that something was being dropped
      // and nothing whatever about what — so it was read as background noise
      // while it was in fact the only trace of a real fault. A count says a
      // schema moved; the line says which way.
      console.warn("[claude-code] unparsed lines in the session stream", {
        skipped: parsed.skipped,
        ...(parsed.sample ? { sample: parsed.sample } : {})
      });
    }
  };

  /**
   * Where the drain has got to, as something safe to persist.
   *
   * One object, so `seq`, `carry` and `emitted` are written together — a cursor
   * that advanced its position without its note count would renumber every key
   * after it, and a replay would then post the whole tail again under keys the
   * gatekeeper has never seen.
   */
  const checkpoint = (): DrainCursor => ({
    execId: cursor.execId,
    seq,
    carry: buffer,
    emitted,
    ...(result ? { result } : {}),
    ...(stderr ? { stderr } : {})
  });

  /**
   * Offer the caller a cursor to persist, at most every
   * {@link CHECKPOINT_MIN_MS}.
   *
   * Fire-and-forget onto the same chain the notes ride, so a storage write
   * cannot stall the read loop and cannot land before the notes it claims are
   * already posted.
   */
  const offerCheckpoint = (): void => {
    const sink = options.onCheckpoint;
    // **Refused without `onProgress`, not merely discouraged.** A checkpoint is
    // only safe because the notes behind it have been posted; offered to a
    // caller that posts nothing, it advances a cursor past notes that were never
    // delivered, and a chunk dying after it loses them permanently. The
    // documented unsafe combination is one nothing can reach.
    if (!sink || !options.onProgress) return;
    if (now() - checkpointedAt < CHECKPOINT_MIN_MS) return;
    checkpointedAt = now();
    const at = checkpoint();
    sunk = sunk.then(() => sink(at)).catch(() => {});
  };

  const finish = async (code?: number): Promise<DrainOutcome> => {
    const next = checkpoint();
    // Everything the sink was given has been delivered before the outcome
    // naming it is returned, so a caller cannot commit a cursor that claims
    // notes nobody posted.
    await sunk;
    return code === undefined
      ? {
          done: false,
          cursor: next,
          progress,
          ...(rateLimit ? { rateLimit } : {})
        }
      : {
          done: true,
          cursor: next,
          progress,
          ...(rateLimit ? { rateLimit } : {}),
          exitCode: code,
          ...(result ? { result } : {}),
          // Only when there is no result. A session that reported for itself has
          // said everything worth saying, and its stderr is the CLI's own
          // diagnostic chatter — surfacing that beside a perfectly good report
          // would bury the report.
          ...(!result && stderr ? { stderr } : {})
        };
  };

  try {
    for (;;) {
      /**
       * Once the process has exited, stop racing the clock and read to the end.
       *
       * This is the single most important branch in the file. The stream
       * `@cloudflare/computer` hands back is wrapped by `withPostPull`, and that
       * wrapper runs **the container-to-workspace filesystem sync** when — and
       * only when — the underlying stream reaches `done`. Returning on the
       * `exit` event instead would leave it unread, so a session's edits would
       * never reach the durable checkout: the run reports success, the files are
       * simply not there.
       *
       * Reading on is also how the sync gets *awaited*: the wrapper resolves its
       * pull before it closes the stream, so observing `done` means the pull was
       * attempted. Attempted, not guaranteed — a pull that fails leaves the
       * stream closing normally and reports itself on the result the host does
       * not see here, and nothing retries it on its own. The host drives any
       * outstanding pull; see this plugin's README.
       *
       * It is also unbounded, deliberately: the pull carries whatever the
       * session wrote, an install's dependency tree included, so this last read
       * can outlast the window that was left. Cutting it short to keep the
       * window would trade a late chunk for edits that never land.
       */
      if (exitCode !== undefined) {
        const next = await reader.read();
        if (next.done) return await finish(exitCode);
        consume(next.value);
        continue;
      }

      const remaining = deadline - now();
      if (remaining <= 0) return await yieldWindow();

      const next = await Promise.race([
        reader.read(),
        sleep(remaining).then((): typeof WINDOW_EXPIRED => WINDOW_EXPIRED)
      ]);

      if (next === WINDOW_EXPIRED) return await yieldWindow();
      if (next.done) {
        // The stream ended without an `exit` event — the container went away
        // under the run. Report it as a failure rather than as still-running,
        // or the caller waits out its whole chunk budget on a dead process.
        return await finish(-1);
      }
      consume(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  function consume(event: {
    seq: number;
    name: string;
    value?: string;
    code?: number;
  }): void {
    seq = event.seq;
    if (event.name === "stdout" && event.value !== undefined) {
      buffer += event.value;
      absorb();
      // After absorbing, never before: the position offered has to be one whose
      // notes are already on the sink's queue.
      offerCheckpoint();
    }
    // stderr is Claude Code's own diagnostics, not the protocol stream. Kept out
    // of the parser so a warning line cannot be mistaken for an event — but
    // **kept**, which it was not, because a process that dies before its first
    // JSON line leaves nothing else behind. See `DrainCursor.stderr`.
    if (event.name === "stderr" && event.value !== undefined) {
      stderr = boundStderr(stderr + event.value);
    }
    if (event.name === "exit") exitCode = event.code ?? -1;
  }

  /**
   * End the window with the session still running.
   *
   * **Cancels rather than merely releasing the lock.** Releasing leaves the
   * attachment and its pending read alive on the far side, and a chunked run
   * would strand one per window. `cancel` is the wrapper's own designed exit —
   * it settles the pending read, resolves the sync outcome as `pending`, and
   * lets the next chunk's `getExec` open a fresh attachment that will run the
   * real sync when the session finally ends.
   *
   * **Cancels before settling the sinks, not after.** `finish` awaits every
   * progress post this window queued — signed round trips to the gatekeeper, one
   * per note — and holding the attachment open across them handed the next chunk
   * a subscriber that was still live for no reason but ordering. Safe in this
   * order because `finish` reads only what `consume` already put in local state,
   * and takes nothing off the stream. It does not close the race that
   * {@link attachRun} waits out — the release is still asynchronous on the far
   * side — it just stops this end adding to it.
   */
  async function yieldWindow(): Promise<DrainOutcome> {
    absorb();
    await reader.cancel("chunk window expired").catch(() => {});
    return await finish();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How much stderr is worth carrying, in characters. */
const STDERR_MAX = 2_000;

/**
 * Keep stderr bounded, from both ends.
 *
 * Applied on every append rather than once at the end, so a session that prints
 * megabytes to stderr — a verbose build, a runaway loop — cannot grow a Durable
 * Object's memory while it does it.
 *
 * Head *and* tail because which end carries the answer depends on how the
 * process died, and the caller cannot know in advance: a Node crash puts its
 * error first and a stack after it, while a CLI that validates its arguments and
 * gives up prints one line and exits, making that line the last thing there is.
 * Keeping both ends costs a few hundred characters and removes the guess.
 *
 * Not a re-implementation of `/computer`'s `truncateOutput`: reaching across the
 * subpath boundary for it would merge two realms `verify:exports` keeps apart,
 * which is the same reason `/repo` carries its own.
 */
function boundStderr(text: string): string {
  if (text.length <= STDERR_MAX) return text;
  const half = Math.floor((STDERR_MAX - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

/**
 * Stop a session.
 *
 * `SIGTERM` rather than `SIGKILL`: Claude Code aborts the turn, kills its own
 * Bash process tree, runs its `SessionEnd` hooks and exits 143. A `SIGKILL`
 * leaves whatever the session had spawned still running in a container the
 * workspace will keep using.
 */
export async function killRun(
  runtime: SessionRuntime,
  execId: string
): Promise<void> {
  await runtime.killExec(execId, { signal: "SIGTERM" });
}
