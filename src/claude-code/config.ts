/**
 * What one deployment tunes about its sessions, in one shape: the daemon reads
 * the CLI's half, and the sub-agent's model the ceiling.
 */
/**
 * The permission modes `claude --permission-mode` accepts.
 *
 * Spelled out rather than `string`, because a typo is otherwise a run that
 * starts, denies everything, and reports prose about being unable to proceed —
 * the exact failure this option exists to end. The CLI validates the value too,
 * but it does so by exiting 1 with a message on stderr, and stderr reaches an
 * operator far less reliably than a type error reaches a developer.
 *
 * Two of these are worth knowing about before picking one. `default` is not
 * among the choices the pinned CLI documents, and is accepted and echoed back as
 * `permissionMode: "default"` anyway — so it stays. `manual` is the reverse: the
 * CLI documents it and no session here has been run under it, so it is spellable
 * rather than recommended, and whatever it prompts for the headless path denies.
 * See {@link ClaudeCodeConfig.permissionMode} for why the default is the
 * permissive one.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "manual"
  | "auto";

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
   * whatever these say; {@link timeoutMs} is the ceiling that actually holds.
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
   * is swapped in by the egress on the Worker side — and it already runs a
   * cloned repository's `postinstall` and its test suite, which is arbitrary
   * code execution by design. Gating the agent's own edits while that stands
   * open buys nothing. Containment is the credential swap.
   *
   * A run may set its own, over this one: a planning run's is `plan`, as its run
   * header says — see `../sandbox/header.ts`.
   */
  permissionMode?: PermissionMode;

  /**
   * How long a session may run before its sub-agent stops it — a ceiling on a
   * session that has stopped making progress. See
   * {@link file://./harness-model.ts DEFAULT_HARNESS_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}
