import { definePlugin, PLUGIN_CONTRACT_VERSION } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
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
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WINDOW_MS,
  type ClaudeCodeConfig
} from "./config.js";
import { closeCopy, copyNote, openCopy, WORKSPACE_MOUNT } from "./copy.js";
import {
  CLAUDE_CODE_READ_SPEC,
  CLAUDE_CODE_READ_TYPE,
  CLAUDE_CODE_SPEC,
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "./recipe.js";

/**
 * `@dynamicagents/plugins/claude-code` — subtasks that run the Claude Code CLI.
 *
 * ## Why this exists
 *
 * A Claude **subscription** credential does not work for raw Messages API calls
 * on a frontier model: every Opus call returns `429` in ~10 ms at zero tokens.
 * The same credential, sent by the Claude Code client, succeeds — Opus 5,
 * Sonnet 5 and Haiku 4.5 all answer, at `service_tier: standard`. The harness is
 * the unlock, so the way to reach those models on a subscription is to run the
 * sanctioned client, which is what this plugin makes delegable.
 *
 * ## What it contributes, and what it does not
 *
 * It declares **one subtask type and no tool families**. That is unusual here
 * and it is the whole shape of the thing: Claude Code brings its own tools, its
 * own loop and its own context management, so there is nothing for core's
 * resumable runner to drive. The host's subagent overrides `executeChunk` and
 * calls {@link claudeCodeSession} instead.
 *
 * ## The credential never enters the container
 *
 * The session is launched with a placeholder. Every request out of the container
 * is intercepted by `computerd` and handed to {@link claudeCodeEgress} on the
 * Worker side, which swaps in a real credential and strips credential headers
 * from every other destination.
 *
 * It can **also** restrict which hosts the container may reach, but that is
 * `restrictToHosts` and it is **off unless a deployment sets it** — so do not
 * read it as a boundary that exists by default. The containment that always
 * holds is the credential swap.
 *
 * ## The 5-hour and weekly limits are routed around, not predicted
 *
 * **No budget gate, and one must not come back.** An estimate of spend is a
 * guess about a bucket nobody can read, and it only moves when a run *ends* — so
 * it caps nothing, it only refuses to start.
 *
 * The gateway sees Anthropic's actual response, which is the one place the
 * bucket announces itself. So the credential is a **pool**: the first usable
 * entry is used, a refusal marks it spent until its reset and advances the lead,
 * and the client's own retry — prompted by a rewritten `retry-after` — lands on
 * the next one. When every entry is spent the upstream wait passes through
 * unchanged and the run fails cleanly with the reset time. See
 * {@link file://./credentials.ts}.
 *
 * ## Requires
 *
 * One or more `claude setup-token` credentials, a container image with the CLI
 * installed at a pinned version, and a workspace Durable Object whose egress
 * policy is `{ mode: "http-gateway" }` and which supplies a
 * {@link CredentialStore}. See the README.
 */

/**
 * Bind a config to a workspace runtime: start, drain, stop.
 *
 * The three calls a host's `executeChunk` needs and nothing else. State lives in
 * the {@link DrainCursor} the caller persists between chunks, so this holds none
 * and a fresh isolate picks up exactly where the last one stopped.
 */
export function claudeCodeSession(config: ClaudeCodeConfig) {
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * What a host may hand a drain beyond its window: where to send a note the
   * moment it is parsed, where to offer a cursor part-way through, and the signal
   * that asks for the window back.
   *
   * Optional, and a host that passes none gets a drain that reports once, at the
   * end of its window, and runs it out. See {@link file://./run.ts DrainOptions}.
   */
  type Sinks = Pick<DrainOptions, "onProgress" | "onCheckpoint" | "signal">;

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
     * Spawn a session for one subtask and drain its first window.
     *
     * `subtaskId` namespaces the exec id. Subtasks are a concurrent fan-out, so
     * two sessions in one workspace under one id would spawn over each other —
     * see {@link execIdFor}.
     *
     * A reading session runs in a throwaway copy of `dir`, made here — see
     * {@link file://./copy.ts}. **Derived from the type inside this call and
     * never taken from the caller**: a host able to ask for the copy is a host
     * able to leave it out, and a reading session without one would run in the
     * tree its parent and every other reader share.
     */
    async start(
      runtime: SessionRuntime,
      subtaskId: string | number,
      type: string,
      prompt: string,
      dir: string,
      sinks: Sinks = {}
    ): Promise<DrainOutcome> {
      const execId = execIdFor(subtaskId);
      const copy =
        type === CLAUDE_CODE_READ_TYPE
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
        timeoutMs
      });
      const cursor = freshCursor(execId);
      return await settle(
        runtime,
        await drainRun(handle, copy ? { ...cursor, copy: true } : cursor, {
          windowMs,
          ...sinks
        })
      );
    },

    /**
     * Give a finished writing session one more turn, and drain its first window.
     *
     * `sessionId` is the one its `result` line reported. The transcript is on the
     * container's disk, so this must run in the workspace the session did. Later
     * windows go through {@link resume} with the cursor this returns, like any
     * other session's.
     */
    async followUp(
      runtime: SessionRuntime,
      subtaskId: string | number,
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
      const execId = followUpExecIdFor(subtaskId);
      using handle = await startRun(runtime, {
        ...launch(prompt, dir),
        resume: sessionId,
        execId,
        timeoutMs
      });
      return await settle(
        runtime,
        await drainRun(handle, freshCursor(execId), { windowMs, ...sinks })
      );
    },

    /**
     * Re-attach to a running session and drain one more window.
     *
     * **A session whose container was replaced is reported, not thrown.** The
     * attachment is the first thing to notice a replacement, and the caller is a
     * chunk loop with a cursor it will happily keep presenting: a throw here
     * retries the same dead id until the chunk allowance runs out, and the run
     * ends on a stack trace that names neither the session nor the cause. A
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
            "starting this subtask again, since a rerun repeats from the " +
            "beginning."
        };
      }
      using session = handle;
      return await settle(
        runtime,
        await drainRun(session, cursor, { windowMs, ...sinks })
      );
    },

    /**
     * Stop a session — `SIGTERM`, so its own process tree goes with it — and
     * delete its copy if it had one.
     *
     * The copy is closed here as well as when a drain reaches the end, because a
     * session stopped with no drain attached has nobody else to close it. A no-op
     * for a session that had none.
     */
    async stop(
      runtime: SessionRuntime,
      subtaskId: string | number
    ): Promise<void> {
      const execId = execIdFor(subtaskId);
      // First, and allowed to fail: most sessions never had a follow-up, and
      // one that did has usually finished its first exec already.
      await killRun(runtime, followUpExecIdFor(subtaskId)).catch(() => {});
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
     * storage, and this same config object is also held by the parent's plugin
     * list and by the subagent facet, neither of which has any. Making it a
     * field would force both of them to invent one.
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
        label: CLAUDE_CODE_TYPE
      })
  };
}

export type ClaudeCodeSession = ReturnType<typeof claudeCodeSession>;

/**
 * Refuse a deployment with no credential at DO start, naming this plugin, rather
 * than at the first model call inside a subtask somebody is waiting on. The thunk
 * is still what the gateway calls per request, so a rotation is picked up.
 */
function requireCredentials(config: ClaudeCodeConfig): void {
  if (config.credentials().filter(Boolean).length === 0) {
    throw new Error(
      "claude-code: no credentials. Set at least one `claude setup-token` " +
        "credential and pass it as " +
        "`credentials: () => [env.CLAUDE_CODE_OAUTH_TOKEN_1]`."
    );
  }
}

/**
 * The writing plugin.
 *
 * `subtaskType` and nothing else: no `toolFamilies`, because Claude Code's tools
 * are its own, and no `capability` on the plugin, because a plugin declaring a
 * subtask type puts its capability block on the **type** — declaring both makes
 * the main agent read the same advice twice per round.
 *
 * **Two plugins rather than one with two types**, because core's contract is one
 * `subtaskType` per plugin — and the split is honest anyway: the two answer
 * `resolveRuntime` differently, which is the whole difference between them. A host
 * installs both, or only {@link claudeCodeRead} if it never writes.
 */
export function claudeCode(config: ClaudeCodeConfig): AgentPlugin {
  requireCredentials(config);

  return definePlugin({
    key: "claude-code",
    contractVersion: PLUGIN_CONTRACT_VERSION,
    subtaskType: CLAUDE_CODE_SPEC,

    /**
     * Hand each writing subtask a workspace of its **own**.
     *
     * Not the parent's: two writing sessions in one container are two autonomous
     * agents editing one working tree. The host answers which object that is and
     * puts a checkout in it — see
     * {@link file://./config.ts ClaudeCodeConfig.subtaskWorkspace}, which carries
     * the whole argument, including why the name must be a pure function of these
     * two ids.
     *
     * This runs on the **parent** — core dispatches `resolveRuntime` to the
     * plugin that declared the subtask type, which is this one — so the host's
     * seam resolves here and would throw in the facet, where `callerKey()` is
     * deliberately unavailable. Whatever this returns arrives at `executeChunk`
     * as its `runtime` argument, and the host reads the name back out with
     * {@link WORKSPACE_RUNTIME_KEY}.
     *
     * Without it a delegated session has no way to address the Durable Object
     * holding the checkout it was told to work in — and it cannot be a subtask
     * param instead, because those are rendered to the delegating model and a
     * model-authored workspace name would let it name somebody else's.
     */
    // Annotated rather than inferred: without it TypeScript narrows the
    // plugin's runtime generic to this one key, which then fails to accept a
    // plain `SubtaskRuntime` anywhere else.
    resolveRuntime: async (ctx): Promise<Record<string, unknown>> => ({
      // A workspace no other live session shares — two writing sessions in one
      // container edit one working tree. See
      // {@link file://./config.ts ClaudeCodeConfig.subtaskWorkspace}, which also
      // carries why one subtask must get one name on every chunk.
      [WORKSPACE_RUNTIME_KEY]: await config.subtaskWorkspace({
        taskId: ctx.taskId,
        subtaskId: ctx.subtaskId,
        // `""` is the schema's default: no branch asked for.
        ...(ctx.params.continue ? { continue: ctx.params.continue } : {})
      })
    }),

    /**
     * An execution cut short leaves commits nobody asked to keep. Before
     * {@link onSettled}, which core runs after this on the same paths.
     */
    onAbort: async (ctx): Promise<void> => {
      await config.abortSubtaskWorkspace({
        taskId: ctx.taskId,
        subtaskId: ctx.subtaskId
      });
    },

    /**
     * An execution the Workflow gave up on keeps what it did, and says where —
     * see {@link file://./config.ts ClaudeCodeConfig.failSubtaskWorkspace}.
     */
    onFail: async (ctx): Promise<string | void> =>
      await config.failSubtaskWorkspace({
        taskId: ctx.taskId,
        subtaskId: ctx.subtaskId
      }),

    /**
     * The execution is over, so its workspace can go to the next subtask.
     *
     * `onSettled` rather than `onAbort`: this has to run on the **success** path
     * above all, which is the one an abort hook never sees. Core contains a throw
     * here, so a workspace that cannot be released does not fail a subtask that
     * worked.
     */
    onSettled: async (ctx): Promise<void> => {
      await config.releaseSubtaskWorkspace({
        taskId: ctx.taskId,
        subtaskId: ctx.subtaskId
      });
    }

    // **No `requires.secrets`, and it is not an omission.** It named
    // `CLAUDE_CODE_OAUTH_TOKEN` while there was exactly one credential with a
    // name this package could know. The pool's entries are host-named — a
    // deployment may call them anything and may have three — so there is no
    // name left to declare. The property `requires` bought is kept by the
    // `credentials()` check above, which is strictly better: it fails at DO
    // start on the *value* being absent rather than on a name being unset.
  });
}

/**
 * The reading plugin: the same CLI, in the **parent's** container, in a throwaway
 * copy of the parent's checkout.
 *
 * Sharing the parent's workspace is the entire economy of this type. That
 * container already has the checkout and the dependency tree, so a reading subtask
 * costs no clone, no install and no container of its own — which is why several can
 * run at once against one repository. What they do share is the container's CPU and
 * the credential pool, so "free" is only true of containers.
 *
 * **Isolated by where it runs, not by what it may do.** The session launches with
 * the same permission mode a writing one does, in a copy nobody else reads and
 * nothing syncs back — see {@link file://./copy.ts}. A mode that refuses edits is
 * not an alternative: every such mode also refuses the commands a question
 * usually needs answered — the suite, the build, a registry query.
 *
 * Nothing to reclaim, therefore, and deliberately no `onSettled`: the workspace
 * belongs to the parent and outlives every subtask that read in it, and the copy
 * is deleted by the session driver when the session ends.
 */
export function claudeCodeRead(config: ClaudeCodeConfig): AgentPlugin {
  requireCredentials(config);

  return definePlugin({
    key: "claude-code-read",
    contractVersion: PLUGIN_CONTRACT_VERSION,
    subtaskType: CLAUDE_CODE_READ_SPEC,

    resolveRuntime: async (): Promise<Record<string, unknown>> => ({
      [WORKSPACE_RUNTIME_KEY]: config.workspaceName()
    })
  });
}

export { ANTHROPIC_HOST, claudeCodeEgress } from "./egress.js";
export type { EgressConfig } from "./egress.js";
export {
  credentialPool,
  readRefusal,
  readRateLimitEvent
} from "./credentials.js";
export type {
  CredentialPool,
  CredentialPoolConfig,
  CredentialState,
  CredentialStore,
  Lead,
  Refusal
} from "./credentials.js";
export {
  buildLaunch,
  CLAUDE_EXEC_PREFIX,
  CREDENTIAL_PLACEHOLDER,
  execIdFor,
  followUpExecIdFor,
  freshCursor
} from "./run.js";
export type {
  DrainCursor,
  DrainOptions,
  DrainOutcome,
  Launch,
  LaunchOptions,
  SessionRuntime
} from "./run.js";
export { parseStream, toProgress, RATE_LIMIT_OK } from "./events.js";
export type {
  ClaudeCodeEvent,
  ClaudeCodeResult,
  ClaudeCodeUsage,
  RateLimitInfo
} from "./events.js";
export {
  CLAUDE_CODE_CAPABILITY,
  CLAUDE_CODE_READ_CAPABILITY,
  CLAUDE_CODE_READ_RECIPE,
  CLAUDE_CODE_READ_SPEC,
  CLAUDE_CODE_READ_TYPE,
  CLAUDE_CODE_RECIPE,
  CLAUDE_CODE_SPEC,
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "./recipe.js";
export {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WINDOW_MS
} from "./config.js";
export type {
  ClaudeCodeConfig,
  EffortLevel,
  PermissionMode
} from "./config.js";
