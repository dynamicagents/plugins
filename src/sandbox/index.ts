/**
 * `@dynamicagents/plugins/sandbox` — a container whose disk is the checkout,
 * driven from a Durable Object through `agents`' `ContainerHarness`.
 *
 * The README has the model. The daemon an image runs is the separate,
 * Node-only `@dynamicagents/plugins/sandbox/daemon`.
 */
export {
  SandboxObjectBase,
  type CheckoutRecord,
  type ExecResult,
  type PolledMessage,
  type PollResult,
  type SandboxObjectConfig,
  type SnapshotSeed
} from "./object.js";
export {
  CONTROL_SESSION,
  CONTROL_WAKE,
  EGRESS_READY,
  RUN_DIR,
  SANDBOX_CONTRACT
} from "./constants.js";
export {
  readRunHeader,
  RUN_HEADER_PREFIX,
  RunHeaderError,
  SANDBOX_ROOT,
  withRunHeader,
  type RunHeader
} from "./header.js";
export {
  AGENT_GID,
  AGENT_HOME,
  AGENT_UID,
  agentEnv,
  asAgent
} from "./agent-exec.js";
export {
  CREDENTIAL_HEADERS,
  egressPlan,
  forward,
  sandboxEgress,
  type EgressCall,
  type EgressPlan,
  type SandboxEgressRule
} from "./egress.js";
export {
  deriveAdvisories,
  renderAdvisory,
  sessionAdvisory,
  shapeOf,
  type AdvisoryAudience,
  type AdvisoryShape,
  type WorkspaceAdvisory
} from "./advisory.js";
export {
  DEFAULT_INSTALL_PLAN,
  type InstallPlan,
  type InstallRule,
  type InstallState
} from "./install-plan.js";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
