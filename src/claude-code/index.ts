import { definePlugin, PLUGIN_CONTRACT_VERSION } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import { claudeCodeEgress } from "./egress.js";
import { credentialPool } from "./credentials.js";
import type { CredentialStore, Lead } from "./credentials.js";
import {
  attachRun,
  drainRun,
  execIdFor,
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
  READ_ONLY_PERMISSION_MODE,
  type ClaudeCodeConfig,
  type PermissionMode
} from "./config.js";
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
/**
 * Which permission mode a subtask type runs under.
 *
 * **Not a setting, and deliberately not reachable by a host.** The pairing of a
 * type to a mode is the entire difference between the two types this package
 * declares, and every mode but `bypassPermissions` produces a session that cannot
 * edit its checkout — so a host able to supply this could, by omitting it, hand a
 * reading subtask the ability to edit the tree it shares with its parent.
 *
 * `undefined` means the writing default, which `buildLaunch` owns: resolving it
 * here as well would write the flag from two places.
 */
function permissionModeForType(type: string): PermissionMode | undefined {
  return type === CLAUDE_CODE_READ_TYPE ? READ_ONLY_PERMISSION_MODE : undefined;
}

export function claudeCodeSession(config: ClaudeCodeConfig) {
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * What a host may hand a drain beyond its window: where to send a note the
   * moment it is parsed, and where to offer a cursor part-way through.
   *
   * Optional, and a host that passes neither gets exactly the behaviour a drain
   * had before they existed — every note on the outcome, one cursor at the end.
   * See {@link file://./run.ts DrainOptions}.
   */
  type Sinks = Pick<DrainOptions, "onProgress" | "onCheckpoint">;

  const launch = (
    prompt: string,
    dir: string,
    permissionMode?: PermissionMode
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
    //
    // The per-run argument wins over the config: a read-only subtask type runs the
    // same session in the same container under a mode that cannot edit, and it is
    // the *subtask* that is read-only, not the deployment.
    ...((permissionMode ?? config.permissionMode)
      ? { permissionMode: permissionMode ?? config.permissionMode }
      : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.author ? { author: config.author } : {})
  });

  return {
    /**
     * Spawn a session for one subtask and drain its first window.
     *
     * `subtaskId` namespaces the exec id. Subtasks are a concurrent fan-out, so
     * two sessions in one workspace under one id would spawn over each other —
     * see {@link execIdFor}.
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
      // `using`, so the attachment is released even when the drain throws.
      using handle = await startRun(runtime, {
        // Derived from the subtask type **here**, never taken from the caller.
        // A host able to pass it is a host able to omit it, and what it would
        // fall through to is the writing mode — so a reading subtask would edit
        // the checkout it shares with its parent, which is the one guarantee
        // that type makes.
        ...launch(prompt, dir, permissionModeForType(type)),
        execId,
        timeoutMs
      });
      return await drainRun(handle, freshCursor(execId), {
        windowMs,
        ...sinks
      });
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
        handle = await attachRun(runtime, cursor);
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
      return await drainRun(session, cursor, { windowMs, ...sinks });
    },

    /** Stop a session — `SIGTERM`, so its own process tree goes with it. */
    async stop(
      runtime: SessionRuntime,
      subtaskId: string | number
    ): Promise<void> {
      await killRun(runtime, execIdFor(subtaskId));
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
      // A workspace of this subtask's own, not the parent's — two writing
      // sessions in one container edit one working tree. See
      // {@link file://./config.ts ClaudeCodeConfig.subtaskWorkspace}, which also
      // carries why the name must be a pure function of these two ids.
      [WORKSPACE_RUNTIME_KEY]: await config.subtaskWorkspace({
        taskId: ctx.taskId,
        subtaskId: ctx.subtaskId
      })
    }),

    /**
     * The workspace was this execution's alone, so it goes when the execution does.
     *
     * `onSettled` rather than `onAbort`: this has to run on the **success** path
     * above all, which is the one an abort hook never sees. Core contains a throw
     * here, so a container that cannot be stopped does not fail a subtask that
     * worked.
     *
     * Reclaim rather than release — there is nothing in it worth keeping, and
     * emptying its storage is what stops an ephemeral workspace accumulating. The
     * *parent's* workspace is the opposite case and takes `releaseContainer`
     * instead; the workspace host carries that distinction.
     */
    onSettled: async (ctx): Promise<void> => {
      await config.reclaimSubtaskWorkspace({
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
 * The reading plugin: the same CLI, in the **parent's** container, under a mode
 * that cannot edit the tree.
 *
 * Sharing the parent's workspace is the entire economy of this type. That
 * container already has the checkout and the dependency tree, so a reading subtask
 * costs no clone, no install and no container of its own — which is why several can
 * run at once against one repository. What they do share is the container's CPU and
 * the credential pool, so "free" is only true of containers.
 *
 * Nothing to reclaim, therefore, and deliberately no `onSettled`: the workspace
 * belongs to the parent and outlives every subtask that read in it.
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
  DEFAULT_WINDOW_MS,
  READ_ONLY_PERMISSION_MODE
} from "./config.js";
export type {
  ClaudeCodeConfig,
  EffortLevel,
  PermissionMode
} from "./config.js";
