/**
 * `@dynamicagents/plugins/workspace` — the Durable Object a container workspace
 * lives in, and the client side every other plugin reaches it through.
 *
 * The filesystem **is** a Durable Object's SQLite, mounted into the container
 * over FUSE by `computerd`. Commands see a normal `/workspace`; the Worker reads
 * the same tree over RPC; and when the container is replaced the tree is pushed
 * back into the new one — so a checkout outlives the container that held it.
 *
 * `WorkspaceObjectBase` is the object: container backend, egress, CA trust,
 * credentialed git, the dependency install, the sync drain and idle reclaim. A
 * host subclasses it and answers a short config. Everything else here is what
 * reaches it from outside: `openWorkspace`, `workspaceExec`, and the advisory
 * vocabulary it reports its state in.
 *
 * `@dynamicagents/plugins/computer` is the agent's tools over it; `/repo` and
 * `/scratch` take `workspaceExec` injected.
 *
 * Requires the Workers **Paid** plan (containers) and a Durable Object binding
 * whose class extends `WorkspaceObjectBase` — see the README for the wrangler
 * block.
 */

/** How a repository installs its dependencies — the mechanical half. */
export {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallPlan,
  type InstallProbe,
  type InstallResolution,
  type InstallRule,
  type InstallState
} from "./install.js";

/**
 * The workspace-advisory vocabulary, which a host needs all of: the type to
 * return over RPC, `deriveAdvisories` to build it from what it already knows,
 * and `sessionAdvisory` for a host driving a whole session rather than one
 * command. `shapeOf` and `renderAdvisory` are exported for the specs that hold
 * their exhaustiveness — a host has no reason to call either, since calling them
 * would mean writing policy or wording that has one home already.
 */
export {
  deriveAdvisories,
  renderAdvisory,
  sessionAdvisory,
  shapeOf,
  type AdvisoryAudience,
  type AdvisoryInput,
  type AdvisoryShape,
  type WorkspaceAdvisory
} from "./advisory.js";

// A host implementing `InstallProbe` needs exactly this, and hand-rolling it
// loses the fast path: across a Durable Object boundary `fs` is a stub carrying
// `exists`, which a `stat`-only probe never asks for.
export { pathExists } from "./read.js";

export { cancelledNote, truncateOutput } from "./format.js";

export {
  openWorkspace,
  openWorkspaceFs,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY,
  type WorkspaceHost
} from "./open.js";
export { withShell, withShellTranscript } from "./shell.js";
export {
  workspaceExec,
  DEFAULT_CWD,
  DEFAULT_TIMEOUT_MS,
  type WorkspaceClientConfig
} from "./exec.js";

/**
 * The object itself. The modules below import the client-side leaves beside
 * them, never this barrel: a cycle through a module that builds a class at
 * import time is a base that evaluates `undefined`.
 */
export {
  WorkspaceObjectBase,
  IDLE_RECLAIM_MS,
  WORKSPACE_DIR,
  workspaceName,
  type WorkspaceObjectConfig,
  type WorkspaceGitConfig
} from "./object.js";

// The dependency install, exported because a host that wants to report on one —
// or a spec that drives it — needs the type, not because anything but
// `./object.ts` constructs it.
export { InstallJob, type InstallJobDeps } from "./install-job.js";

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
