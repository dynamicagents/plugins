/**
 * Everything one `claude-coder` deployment tunes, in one shape.
 *
 * Config at instantiation rather than an `env` argument, for the reason the
 * whole package works this way: `Env` is the ambient interface `wrangler types`
 * generates into a *consumer's* app and does not exist here, and on Workers
 * there is no module-scope `env` to read anyway.
 */
/**
 * The permission modes `claude --permission-mode` accepts.
 *
 * Spelled out rather than `string`, because a typo is otherwise a run that
 * starts, denies everything, and reports prose about being unable to proceed —
 * the exact failure this option exists to end. The CLI validates the value too,
 * but it does so by exiting 1 with a message on stderr, and stderr reaches an
 * operator far less reliably than a type error reaches a developer.
 */
export type PermissionMode =
  "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/**
 * What a session runs under when a deployment says nothing.
 *
 * A default rather than a required field, and deliberately the permissive one:
 * every other value produces a session that cannot edit the checkout it was
 * given, so an unset mode is not a conservative choice, it is a broken one. See
 * {@link ClaudeCodeConfig.permissionMode}.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * The effort levels `claude --effort` accepts.
 *
 * Spelled out for a sharper reason than {@link PermissionMode}: an unrecognised
 * permission mode exits 1, but an unrecognised effort is **warned about on
 * stderr and then ignored**, leaving the session at the model's default. A typo
 * here does not fail, it quietly buys nothing — and stderr from a headless
 * session reaches an operator far less reliably than a type error reaches a
 * developer.
 *
 * A model that does not carry a level is the same silence: the CLI clamps down
 * to `high` rather than refusing, so asking for more than a model offers is
 * indistinguishable from asking for `high`.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCodeConfig {
  /**
   * The credential pool, in priority order — index 0 is tried first.
   *
   * A thunk so a rotated secret is picked up without rebuilding the plugin list.
   * **These values never enter the container** — one is read on the Worker side
   * by the egress gateway and swapped into the outbound request. The container
   * gets {@link file://./run.ts CREDENTIAL_PLACEHOLDER}.
   *
   * `claude setup-token` OAuth credentials. There is deliberately no API-key
   * path: the subscription credential is the one that reaches frontier models
   * through this client, and a second path would be a second thing to get wrong.
   *
   * **Why a pool.** A subscription has a rolling 5-hour bucket and a weekly one,
   * neither readable. Rather than estimate spend against them, the gateway uses
   * the first usable entry and moves on when Anthropic says that one is done —
   * see {@link file://./credentials.ts}. An array of one is valid and behaves
   * exactly as a single credential did: used until its bucket empties, then
   * refused with the reset time.
   */
  credentials: () => readonly string[];

  /**
   * Which workspace this agent's sessions run in.
   *
   * Resolved on the **parent**, where the verified caller is known: core
   * dispatches `resolveRuntime` to the plugin that declared the subtask type,
   * which is this one, and the value it writes is how the subagent facet learns
   * which Durable Object holds its checkout. A facet cannot work this out for
   * itself — `callerKey()` throws there by design — and it is deliberately not a
   * subtask param, because a model-authored workspace name would let a model
   * name somebody else's.
   */
  workspaceName: () => string;

  /**
   * The workspace one **write** subtask runs in, ready to be worked in.
   *
   * A write session gets a workspace no other live session shares, because two
   * autonomous sessions in one container are two agents editing one working tree
   * — each running the project's test suite over the other's half-finished edits.
   * The isolation boundary is the one the platform already draws: `computer` pairs
   * one Durable Object with one container, so a different name is a different
   * filesystem.
   *
   * **The consumer answers this, not the plugin**, for the same reason
   * `workspaceName` is a thunk: which Durable Object a name resolves to, and how
   * one acquires a checkout, are facts about a deployment. Cloning needs a remote
   * url, a directory convention and a host allowlist, all of which belong to
   * `/repo` — a plugin reaching across to another plugin's knowledge is how two
   * copies of it start to drift. A host may keep these workspaces and hand them
   * out again; what it may not do is hand one to two live subtasks.
   *
   * **One subtask gets one name on every chunk.** Core calls `resolveRuntime`
   * once per *chunk*, not once per run, so a second answer would hand chunk two a
   * different container than chunk one and strand the work in the first.
   *
   * `continue` is the branch the delegating model asked to add to, from an
   * earlier subtask's report — the host decides whether it may, and which
   * workspace holds it. Absent, the subtask starts a branch of its own.
   *
   * Resolving is expected to be idempotent and is awaited: returning means the
   * workspace is addressable and has a checkout on the subtask's branch. Arming a
   * dependency install is a legitimate part of that, but awaiting one is not — an
   * install is minutes and this sits in front of the session that is waiting.
   */
  subtaskWorkspace: (ctx: {
    taskId: string;
    subtaskId: number;
    continue?: string;
  }) => Promise<string>;

  /**
   * The execution is over, whatever its outcome — let the workspace go to the
   * next subtask.
   *
   * Called for every terminal outcome, so it has to tolerate a subtask that
   * never resolved a workspace. **Must key on the same `taskId` and
   * `subtaskId`**, or it releases a workspace another subtask holds.
   */
  releaseSubtaskWorkspace: (ctx: {
    taskId: string;
    subtaskId: number;
  }) => Promise<void>;

  /**
   * The execution was cut short — canceled, or failed at its step — so what it
   * committed is not work anybody asked to keep.
   *
   * Called before {@link releaseSubtaskWorkspace}, on those paths only. A session
   * that ended by reporting a failure is not one of them: it said what it did,
   * and its commits stay for the parent to judge.
   */
  abortSubtaskWorkspace: (ctx: {
    taskId: string;
    subtaskId: number;
  }) => Promise<void>;

  /**
   * The Workflow gave up on the execution — its step ran out of retries — which
   * says nothing about the session: every loss this path has seen was a healthy
   * one whose chunk lost its transport. So the opposite of
   * {@link abortSubtaskWorkspace}: stop the session and **keep** what it did.
   *
   * Answers the sentence the delegating model needs to continue it, which core
   * appends to the failure — or nothing, when there was nothing to keep. Called
   * instead of {@link abortSubtaskWorkspace}, before
   * {@link releaseSubtaskWorkspace}.
   */
  failSubtaskWorkspace: (ctx: {
    taskId: string;
    subtaskId: number;
  }) => Promise<string | void>;

  /** Which model the session runs. Unset, Claude Code picks its own default. */
  model?: string;

  /**
   * How hard the session's model thinks, per turn.
   *
   * Unset, the model's own default applies, which is `high` for the frontier
   * models this plugin exists to reach. Raising it buys depth at a multiple of
   * the spend, per turn — so the level decides how many sessions a credential
   * holds, not just how well one thinks. The README's Costs section carries the
   * multiples and the sizing they imply.
   *
   * Not to be confused with the host round loop's own reasoning effort, which
   * belongs to a different model on the Worker side. This one reaches only the
   * CLI in the container.
   */
  effort?: EffortLevel;

  /**
   * Caps on Claude Code's own subagent tree.
   *
   * Advisory, and the distinction is the reason there is no turn ceiling beside
   * them — see the README on what this package deliberately does not do. That
   * tree is invisible to Dynamic Agents' scheduler, so it multiplies whatever
   * these say; {@link timeoutMs} is the ceiling that actually holds, because the
   * container runtime enforces it.
   */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;

  /**
   * How the session answers its own permission prompts.
   *
   * **Defaults to `bypassPermissions`, and anything else breaks the session.**
   * That reads like a strong claim for a security-shaped setting, so here is the
   * measurement behind it: `claude -p` is headless, there is nobody to answer a
   * prompt, and Claude Code's headless path *auto-denies* whatever `default`
   * mode would have asked about. That is Write, Edit and every Bash command — so
   * a session left on the default can read the repository and report on it, and
   * cannot change one byte of it. It does not fail, either: it spends its turns
   * rephrasing the same edit and reports what looks like a considered refusal.
   *
   * The narrower modes do not help. `acceptEdits` clears Write and Edit and
   * leaves `npm ci`, `git` and the test suite denied; `dontAsk` is today's
   * behaviour under another name; `auto` puts a model classifier in front of
   * every tool call, spending the same subscription bucket the session is
   * already drawing on to arrive at an answer it may still refuse.
   *
   * What makes bypassing acceptable is not this flag being careful. It is that
   * the container has nothing to protect: it holds no credential — the real one
   * is swapped in by the egress gateway on the Worker side — and it already runs
   * a cloned repository's `postinstall` and its test suite, which is arbitrary
   * code execution by design. Gating the agent's own edits while that stands
   * open buys nothing. Containment is the credential swap.
   *
   * See {@link file://./run.ts buildLaunch} for the root guard this mode trips,
   * which is the other half of making it work.
   */
  permissionMode?: PermissionMode;

  /**
   * Restrict the container's egress to these hosts, plus `api.anthropic.com`.
   *
   * **Omit it and egress is unrestricted, which is the default.** An empty array
   * is not the same thing — it means Anthropic only. See
   * {@link file://./egress.ts EgressConfig.restrictToHosts} for the full table
   * and for why open is the default.
   *
   * Whatever this says, the container never needs forge access: `/repo` runs
   * clone, fetch and push as isomorphic-git inside the workspace object, so the
   * forge token stays on the Worker side.
   */
  restrictToHosts?: readonly string[];

  /**
   * How long one chunk blocks before checkpointing and yielding.
   *
   * **A read deadline on the session's stdout stream, not a halt.** Nothing is
   * stopped and nothing is destroyed when it expires: the host detaches, the
   * session process inside the container never notices, and the next chunk
   * re-attaches to the live session from the cursor. So the window is bounded
   * against `STEP_TIMEOUT_MS` rather than against core's `CHUNK_SOFT_MS` —
   * there is no in-flight turn to overrun, which is what sizes the recipe
   * path's budget.
   *
   * What prices the headroom instead is the post-exit filesystem pull, which is
   * deliberately unbounded because it carries whatever the session wrote,
   * dependency trees included, and can outlast the window. So no value here can
   * guarantee the chunk fits inside the step timeout: what is left over is
   * sized for an *expected* pull, plus the sub-second unwind of yielding and
   * the step's own bookkeeping, and a large enough pull overruns it whatever
   * this is set to. See {@link file://./run.ts DrainOptions.windowMs}.
   *
   * **Overrunning is the cheaper failure, which is why the default is
   * generous.** The step is killed and retried; the filesystem sync resumes
   * from the blocks it has already committed rather than starting over, and the
   * retry re-attaches to the session from the cursor — so an overrun costs a
   * retry and some replayed notes, never a session's edits. An undersized
   * window costs a chunk boundary on *every* session instead — a checkpoint, a
   * fresh step, a re-hydrated subagent and a re-attach that replays the tail —
   * paid whether or not the pull was ever going to be large.
   *
   * It must also be long enough that a session does not exhaust its branch's
   * chunk allowance while it is still thinking.
   */
  windowMs?: number;

  /**
   * Ceiling on the whole session, enforced by the container runtime.
   *
   * **Must stay below the workspace's container-idle timer**, which is the
   * invariant that has already caused one outage in this repository: two timers
   * of similar length started moments apart, and whichever fired first destroyed
   * the container the other depended on.
   */
  timeoutMs?: number;

  /** Extra environment for the session. Never secrets — see the README. */
  env?: Record<string, string>;

  /**
   * Who the session's own git commits are attributed to.
   *
   * A session has a shell and a checkout, so it commits — and it amends,
   * rebases and cherry-picks, none of which a host can intercept the way it
   * names an identity on a commit it makes itself. Left unset, every one of
   * those falls through to whatever config the checkout happens to carry, which
   * is a value frozen whenever that checkout was created.
   *
   * See {@link file://./run.ts buildLaunch} for why this becomes an environment
   * rather than a `git config`.
   */
  author?: { name: string; email: string };
}

/**
 * Twenty minutes against a 30-minute step timeout, which leaves ~10 minutes for
 * the sub-second unwind of yielding the window and for the post-exit filesystem
 * pull. An expected pull fits there; a pull that carries an install's
 * dependency tree may not, and nothing here promises it will — that pull is
 * unbounded by design. Sized for the expected case deliberately: the pull that
 * overruns is retried and resumes, while a shorter window would buy that back
 * by paying for extra chunk boundaries on every session. See
 * {@link ClaudeCodeConfig.windowMs}.
 */
export const DEFAULT_WINDOW_MS = 20 * 60_000;

/** Fifteen minutes, well under the coder workspace's 20-minute idle timer. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
