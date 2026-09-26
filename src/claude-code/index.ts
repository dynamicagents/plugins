/**
 * `@dynamicagents/plugins/claude-code` — sub-agents that run the Claude Code CLI.
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
 * **Two sub-agent specs and a model, and no plugin.** Claude Code brings its own
 * tools, its own loop and its own context management, so there is nothing for
 * an agent loop to drive: the session *is* the sub-agent's model —
 * {@link claudeCodeModel} — and Think's recovery drives that. A host binds
 * {@link CLAUDE_CODE_AGENT} and {@link CLAUDE_CODE_READER_AGENT} to `SubAgent`
 * classes whose `getModel()` returns one, and adds the `prepare` and `settle`
 * that claim and release a workspace.
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

export { claudeCodeModel } from "./model.js";
export type {
  ClaudeCodeModelOptions,
  SessionEnd,
  SessionOutcome,
  SessionWorkspace
} from "./model.js";
export { claudeCodeSession } from "./session.js";
export type { ClaudeCodeSession } from "./session.js";
export {
  CLAUDE_CODE_AGENT,
  CLAUDE_CODE_READER_AGENT,
  type ClaudeCodeInput,
  type ClaudeCodeReadInput
} from "./spec.js";

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
export { DEFAULT_PERMISSION_MODE, DEFAULT_TIMEOUT_MS } from "./config.js";
export type {
  ClaudeCodeConfig,
  EffortLevel,
  PermissionMode
} from "./config.js";
