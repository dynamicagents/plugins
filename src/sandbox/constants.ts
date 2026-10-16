/**
 * What the object and the daemon in its container must spell identically.
 *
 * A module of its own, with no imports, because the daemon runs in Node and
 * cannot load anything that reaches `cloudflare:workers`.
 */

/** Bumped when an RPC of the object changes shape, so a caller can tell a busy object still on older code. */
export const SANDBOX_CONTRACT = 2;

/**
 * The harness's own root session, which a sandbox keeps for control prompts:
 * the daemon answers it without starting a CLI. The contract spec pins it to
 * the harness's `ROOT_SESSION`.
 */
export const CONTROL_SESSION = "root";

/** A control prompt that only starts the container. */
export const CONTROL_WAKE = "control:wake";

/** Markers and job output in the container: made by the object, owned by the agent. */
export const RUN_DIR = "/run/da";

/** The marker a CLI turn waits for, holding the runtime id its egress was prepared for. */
export const EGRESS_READY = `${RUN_DIR}/egress-ready`;

/** How long a CLI turn waits for {@link EGRESS_READY} before it refuses to start. */
export const EGRESS_WAIT_MS = 60_000;
