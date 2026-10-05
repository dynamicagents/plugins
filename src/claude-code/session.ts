import { claudeCodeEgress } from "./egress.js";
import { credentialPool } from "./credentials.js";
import type { CredentialStore, Lead } from "./credentials.js";
import {
  attachRun,
  containerLost,
  drainRun,
  execIdFor,
  followUpExecIdFor,
  freshCursor,
  isExecLost,
  killRun,
  startRun,
  type DrainCursor,
  type DrainOutcome,
  type DrainOptions,
  type SessionRuntime
} from "./run.js";
import {
  DEFAULT_TIMEOUT_MS,
  type ClaudeCodeConfig,
  type PermissionMode
} from "./config.js";

/**
 * What continuing an interrupted conversation takes — see
 * {@link file://./run.ts LaunchOptions.resume}.
 */
export interface ResumeSession {
  sessionId: string;
  /** Continue under a new id, leaving the original conversation whole. */
  fork?: boolean;
}

/** What one session needs to be launched: see {@link ClaudeCodeSession.start}. */
export interface StartSession {
  /** The whole of what this session is asked to do, or its next user turn. */
  prompt: string;
  /** The checkout. */
  dir: string;
  jsonSchema?: Record<string, unknown>;
  /**
   * This session's mode, over the config's — see
   * {@link file://./model.ts ClaudeCodeModelOptions.permissionMode}.
   */
  permissionMode?: PermissionMode;
  /** A Claude Code conversation to continue rather than start. */
  resume?: ResumeSession;
}

/**
 * Bind a config to a workspace runtime: start, follow up, resume, stop.
 *
 * What `claudeCodeModel` drives a run with, and what a host's `settle` stops
 * one with. State lives in the {@link DrainCursor} the caller stores, so this
 * holds none and a fresh isolate picks up exactly where the last one stopped.
 *
 * ## Two senses of "resume", and they are not the same mechanism
 *
 * {@link ClaudeCodeSession.resume} re-attaches to a running **exec** — the
 * process is alive in the container and a drain that was cut reads on from the
 * cursor's sequence. Nothing about the conversation changes; this is plumbing.
 *
 * {@link StartSession.resume} continues a Claude Code **conversation** that has
 * already ended, in a new process with a new exec: the session's transcript is
 * read back into context and the prompt is the next user turn. Where that
 * transcript lives — and so how long this is possible at all — is
 * {@link file://./run.ts SESSION_CONFIG_DIR}.
 */
export function claudeCodeSession(config: ClaudeCodeConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * What a host may hand a drain: where to send a note the moment it is
   * parsed, where to offer a cursor part-way through, and the signal that stops
   * it. See {@link file://./run.ts DrainOptions}.
   */
  type Sinks = DrainOptions;

  const launch = (
    prompt: string,
    dir: string,
    permissionMode = config.permissionMode
  ) => ({
    prompt,
    dir,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.maxSubagentDepth === undefined
      ? {}
      : { maxSubagentDepth: config.maxSubagentDepth }),
    ...(config.maxConcurrentSubagents === undefined
      ? {}
      : { maxConcurrentSubagents: config.maxConcurrentSubagents }),
    // Forwarded only when set, so `buildLaunch` owns the default in one place
    // rather than this line resolving it and the flag being written twice.
    ...(permissionMode ? { permissionMode } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.author ? { author: config.author } : {})
  });

  return {
    /**
     * Spawn a session for one run and drain it.
     *
     * `runId` namespaces the exec id. Runs are concurrent, so two sessions in
     * one workspace under one id would spawn over each other — see
     * {@link execIdFor}.
     *
     * `resume` continues a conversation on this session's **own** exec rather
     * than on a second one: a run given a conversation to continue has no first
     * session of its own, so there is nothing for a follow-up exec to follow.
     */
    async start(
      runtime: SessionRuntime,
      runId: string,
      options: StartSession,
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      const execId = execIdFor(runId);
      // `using`, so the attachment is released even when the drain throws.
      using handle = await startRun(runtime, {
        ...launch(options.prompt, options.dir, options.permissionMode),
        ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        ...resumption(options.resume),
        execId,
        timeoutMs,
        signal: sinks.signal
      });
      return await drainRun(handle, freshCursor(execId), sinks);
    },

    /**
     * Give a finished writing session one more turn, and drain it.
     *
     * `sessionId` is the one the session reported — on its `result` line, or on
     * its cursor when it ended without one. This runs in the workspace the
     * session did, because that workspace's {@link file://./run.ts SESSION_CONFIG_DIR}
     * is where the transcript it is continuing can be found. A drain cut short goes
     * on through {@link resume} with the cursor it stored, like any other
     * session's.
     *
     * Never forked: a follow-up is one more turn of the same conversation, which
     * is exactly what a fork is for *not* doing. For the same reason it runs
     * under the session's own `permissionMode`.
     */
    async followUp(
      runtime: SessionRuntime,
      runId: string,
      options: {
        sessionId: string;
        prompt: string;
        dir: string;
        permissionMode?: PermissionMode;
      },
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      // Without one, `--resume` would be dropped and a new session started
      // under the follow-up's id — unrelated work, reported as the follow-up.
      if (!options.sessionId) {
        throw new Error(
          "claude-code: a follow-up needs the session id its result reported"
        );
      }
      const execId = followUpExecIdFor(runId);
      using handle = await startRun(runtime, {
        ...launch(options.prompt, options.dir, options.permissionMode),
        resume: options.sessionId,
        execId,
        timeoutMs,
        signal: sinks.signal
      });
      return await drainRun(handle, freshCursor(execId), sinks);
    },

    /**
     * Re-attach to a running session and drain it to its end.
     *
     * **A session whose container was replaced is reported, not thrown.** The
     * attachment is the first thing to notice a replacement, and the caller is a
     * recovered turn with a cursor it will happily keep presenting: a throw here
     * retries the same dead id until the recoveries run out, and the run ends on
     * a stack trace that names neither the session nor the cause. A
     * terminal outcome ends it at the first attempt instead, with the exit code
     * the runtime uses for a killed process and an explanation on `stderr`,
     * which is exactly the channel a session that died without a result line
     * already reports through. The wording is {@link containerLost}'s.
     */
    async resume(
      runtime: SessionRuntime,
      cursor: DrainCursor,
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      let handle;
      try {
        handle = await attachRun(runtime, cursor, { signal: sinks.signal });
      } catch (err) {
        if (!isExecLost(err)) throw err;
        console.warn("[claude-code] the session's container was replaced", {
          execId: cursor.execId,
          err: String(err)
        });
        return {
          done: true,
          cursor,
          progress: [],
          exitCode: -1,
          stderr: containerLost()
        };
      }
      using session = handle;
      return await drainRun(session, cursor, sinks);
    },

    /** Stop a session — `SIGTERM`, so its own process tree goes with it. */
    async stop(runtime: SessionRuntime, runId: string): Promise<void> {
      // First, and allowed to fail: most sessions never had a follow-up, and
      // one that did has usually finished its first exec already.
      await killRun(runtime, followUpExecIdFor(runId)).catch(() => {});
      await killRun(runtime, execIdFor(runId));
    },

    /**
     * Is any credential usable right now, and if not, when?
     *
     * The same question {@link egress} answers per request, asked ahead of time
     * so a host can decline to start a session it cannot pay for. That is not a
     * micro-optimisation: an invocation carries an 18.7-27k-token cached prefix
     * before it does anything, so starting one and letting the gateway refuse
     * its first model call costs a container start and that prefix to learn what
     * this returns for free — and reports it as a failed run rather than as a
     * rate limit with a time on it.
     *
     * Reads only. Nothing here marks anything spent.
     */
    credentials: (store: CredentialStore): Promise<Lead> =>
      credentialPool({ credentials: config.credentials, store }).lead(),

    /**
     * The `Fetcher` the workspace object installs as its egress policy.
     *
     * `store` is an **argument rather than a config field**, and that is the
     * point: the credential pool's state belongs to whichever object has
     * storage, and this same config object is also held by the agents that run
     * sessions, which have none of their own for it. Making it a field would
     * force them to invent one.
     */
    egress: (store: CredentialStore) =>
      claudeCodeEgress({
        credentials: config.credentials,
        store,
        // Forwarded only when set. Defaulting it to `[]` here would turn "the
        // host said nothing" into "Anthropic only", which is the one reading
        // the three-way semantics exist to keep distinct.
        ...(config.restrictToHosts === undefined
          ? {}
          : { restrictToHosts: config.restrictToHosts }),
        label: "claude-code"
      })
  };
}

export type ClaudeCodeSession = ReturnType<typeof claudeCodeSession>;

/**
 * A conversation to continue, as launch flags.
 *
 * One place rather than a spread at each call site, so `fork` can never travel
 * without the id it forks — which {@link file://./run.ts buildLaunch} refuses,
 * but refuses at launch rather than here.
 */
function resumption(
  resume: ResumeSession | undefined
): { resume: string; fork?: true } | undefined {
  if (!resume) return undefined;
  return { resume: resume.sessionId, ...(resume.fork ? { fork: true } : {}) };
}

/**
 * Refuse a deployment with no credential when the model is built, naming this
 * plugin, rather than at the first model call inside a run somebody is waiting
 * on. The thunk is still what the gateway calls per request, so a rotation is
 * picked up.
 */
export function requireCredentials(config: ClaudeCodeConfig): void {
  if (config.credentials().filter(Boolean).length === 0) {
    throw new Error(
      "claude-code: no credentials. Set at least one `claude setup-token` " +
        "credential and pass it as " +
        "`credentials: () => [env.CLAUDE_CODE_OAUTH_TOKEN_1]`."
    );
  }
}
