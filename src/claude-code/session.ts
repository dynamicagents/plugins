import { claudeCodeEgress } from "./egress.js";
import { credentialPool } from "./credentials.js";
import type { CredentialStore, Lead } from "./credentials.js";
import {
  attachRun,
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
import { DEFAULT_TIMEOUT_MS, type ClaudeCodeConfig } from "./config.js";
import { closeCopy, copyNote, openCopy, WORKSPACE_MOUNT } from "./copy.js";

/**
 * Bind a config to a workspace runtime: start, follow up, resume, stop.
 *
 * What `claudeCodeModel` drives a run with, and what a host's `settle` stops
 * one with. State lives in the {@link DrainCursor} the caller stores, so this
 * holds none and a fresh isolate picks up exactly where the last one stopped.
 */
export function claudeCodeSession(config: ClaudeCodeConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * What a host may hand a drain: where to send a note the moment it is
   * parsed, where to offer a cursor part-way through, and the signal that stops
   * it. See {@link file://./run.ts DrainOptions}.
   */
  type Sinks = DrainOptions;

  const launch = (prompt: string, dir: string) => ({
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
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.author ? { author: config.author } : {})
  });

  /**
   * Delete a reading session's copy once its drain reaches the end.
   *
   * Here rather than left to a host, because the copy is this package's guarantee:
   * a host that forgot would leave a copy — and whatever it installed — on the
   * container's disk until the next sweep.
   */
  const settle = async (
    runtime: SessionRuntime,
    outcome: DrainOutcome
  ): Promise<DrainOutcome> => {
    if (outcome.done && outcome.cursor.copy) {
      await closeCopy(runtime, outcome.cursor.execId);
    }
    return outcome;
  };

  return {
    /**
     * Spawn a session for one run and drain it.
     *
     * `runId` namespaces the exec id. Runs are concurrent, so two sessions in
     * one workspace under one id would spawn over each other — see
     * {@link execIdFor}.
     *
     * A reading session runs in a throwaway copy of `dir`, made here — see
     * {@link file://./copy.ts}. **Made inside this call, from `kind`, and never
     * handed in by the caller**: a host able to pass the copy is a host able to
     * leave it out, and a reading session without one would run in the tree its
     * parent and every other reader share.
     */
    async start(
      runtime: SessionRuntime,
      runId: string,
      kind: "write" | "read",
      prompt: string,
      dir: string,
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      const execId = execIdFor(runId);
      const copy =
        kind === "read"
          ? await openCopy(runtime, { execId, source: dir, timeoutMs })
          : undefined;
      // `using`, so the attachment is released even when the drain throws.
      using handle = await startRun(runtime, {
        ...(copy
          ? {
              // Started in the original and moved into the copy by the command:
              // the copy is on container disk, where no exec can start.
              ...launch(`${prompt}\n\n${copyNote(copy)}`, dir),
              workdir: copy.dir,
              ...(copy.isolated ? { readOnly: WORKSPACE_MOUNT } : {})
            }
          : launch(prompt, dir)),
        execId,
        timeoutMs,
        signal: sinks.signal
      });
      const cursor = freshCursor(execId);
      return await settle(
        runtime,
        await drainRun(handle, copy ? { ...cursor, copy: true } : cursor, sinks)
      );
    },

    /**
     * Give a finished writing session one more turn, and drain it.
     *
     * `sessionId` is the one its `result` line reported. The transcript is on the
     * container's disk, so this must run in the workspace the session did. A
     * drain cut short goes on through {@link resume} with the cursor it stored,
     * like any other session's.
     */
    async followUp(
      runtime: SessionRuntime,
      runId: string,
      sessionId: string,
      prompt: string,
      dir: string,
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      // Without one, `--resume` would be dropped and a new session started
      // under the follow-up's id — unrelated work, reported as the follow-up.
      if (!sessionId) {
        throw new Error(
          "claude-code: a follow-up needs the session id its result reported"
        );
      }
      const execId = followUpExecIdFor(runId);
      using handle = await startRun(runtime, {
        ...launch(prompt, dir),
        resume: sessionId,
        execId,
        timeoutMs,
        signal: sinks.signal
      });
      return await settle(
        runtime,
        await drainRun(handle, freshCursor(execId), sinks)
      );
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
     * already reports through.
     *
     * **What it must not say is that starting over is safe.** A session is an
     * agent: by the time its container went, it may have written files that
     * reached the workspace, committed, pushed, or called something outside
     * altogether. None of that is visible from here — only that the attachment
     * is gone — so the honest report is what is known plus where to look, and
     * the decision belongs to whoever can read the durable state.
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
          stderr:
            "the container holding this session was replaced, so the session " +
            "was lost before it finished and cannot be re-attached. What it had " +
            "already written to the workspace is still there, and anything it " +
            "did outside the workspace — a commit, a push, a request — has " +
            "already happened. Check the workspace and the branch before " +
            "starting this work again, since a rerun repeats from the " +
            "beginning."
        };
      }
      using session = handle;
      return await settle(runtime, await drainRun(session, cursor, sinks));
    },

    /**
     * Stop a session — `SIGTERM`, so its own process tree goes with it — and
     * delete its copy if it had one.
     *
     * The copy is closed here as well as when a drain reaches the end, because a
     * session stopped with no drain attached has nobody else to close it. A no-op
     * for a session that had none.
     */
    async stop(runtime: SessionRuntime, runId: string): Promise<void> {
      const execId = execIdFor(runId);
      // First, and allowed to fail: most sessions never had a follow-up, and
      // one that did has usually finished its first exec already.
      await killRun(runtime, followUpExecIdFor(runId)).catch(() => {});
      await killRun(runtime, execId);
      await closeCopy(runtime, execId);
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
