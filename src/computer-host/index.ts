/**
 * The host half of `@dynamicagents/plugins/computer`: the Durable Object that
 * owns a workspace, and everything it drives.
 *
 * `../computer/` ships the tools a model calls and the policy behind them —
 * which advisories matter, how an install command is resolved, what a result
 * reads like. This ships the object those tools talk to: the container backend,
 * the one alarm and everything multiplexed onto it, the dependency install, the
 * credentialed git, and the pull the library schedules for nobody.
 *
 * **A separate subpath, so the two cannot merge by accident.** An agent that
 * installs `computer()` for its tools carries no container backend and no
 * isomorphic-git; only the Worker that *deploys* a workspace imports this. The
 * dependency runs one way — this reaches `../computer/`, never the reverse — and
 * `scripts/verify-exports.mjs` is what holds that, on the built graph.
 *
 * ## What the host still owes
 *
 * Subclass {@link WorkspaceObjectBase}, answer {@link WorkspaceObjectConfig},
 * and declare the binding, the container and the migration in `wrangler.jsonc`.
 * `README.md` has the snippet and the storage keys this owns.
 */

export {
  WorkspaceObjectBase,
  WORKSPACE_DIR,
  workspaceName,
  type WorkspaceObjectConfig,
  type WorkspaceGitConfig
} from "./object.js";

// The dependency install, exported because a host that wants to report on one —
// or a spec that drives it — needs the type, not because anything but
// `./object.ts` constructs it.
export { InstallJob, type InstallJobDeps } from "./install.js";

// The pull the library owns no alarm for. Its constants are exported because a
// host deferring to a drain has to back off at the same rate this does.
export {
  WorkspaceSync,
  SYNC_DRAIN_BUDGET_MS,
  SYNC_DRAIN_RESUME_MS,
  SYNC_DRAIN_MAX_BACKOFF_MS,
  syncRetryDelayMs,
  type DrainOutcome,
  type SyncDrainIntent,
  type WorkspaceSyncDeps
} from "./sync.js";

// `TRUST_CA_COMMAND` is exported so a host can assert what its image will be
// asked to run — see the file for why this cannot live in an entrypoint.
export {
  ContainerTrust,
  TRUST_CA_COMMAND,
  type ContainerTrustDeps
} from "./ca-trust.js";

export { WorkspaceGitHost, type GitHostDeps } from "./git-host.js";

export type { WorkspaceWakeHandlers } from "./wake.js";
