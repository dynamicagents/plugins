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
   * Not to be confused with the agent's own reasoning effort, which belongs to
   * a different model on the Worker side. This one reaches only the CLI in the
   * container.
   */
  effort?: EffortLevel;

  /**
   * Caps on Claude Code's own subagent tree.
   *
   * Advisory, and the distinction is the reason there is no turn ceiling beside
   * them — see the README on what this package deliberately does not do. That
   * tree is invisible to the agent running the session, so it multiplies
   * whatever these say; {@link timeoutMs} is the ceiling that actually holds, because the
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

/** Fifteen minutes, well under the coder workspace's 20-minute idle timer. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
