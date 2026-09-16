/**
 * The container failures that are the deployment's fault, not the workspace's.
 *
 * Everything else this host catches is worth retrying: a container that is
 * starting, a connection that dropped, a command that died with it. These two
 * are not. They describe a Worker and a container application that cannot work
 * together no matter how many times they are asked, and they clear only when an
 * operator deploys.
 *
 * Telling them apart matters for what gets *said*. The cause is already in the
 * thrown message, but a caller logs its own sentence and the cause travels in a
 * detail field that a log digest truncates — so an operator scanning for what
 * broke reads the symptom ("could not trust the interception CA") and not the
 * reason. {@link deploymentFault} is how a caller puts the reason in the message
 * instead.
 */

/**
 * A failure no retry can clear, in the two registers a caller needs.
 *
 * `summary` is the log message: what is wrong, short enough to scan. `remedy`
 * goes to whoever is blocked by it — it reaches a model through the install
 * record, so it says what a person has to do rather than what a tool should try.
 */
export interface DeploymentFault {
  readonly summary: string;
  readonly remedy: string;
}

/**
 * Match on the shape the backend formats, not on the prose after it.
 *
 * `[stage=auth]` is the stage label `CloudflareContainerBackend` writes into
 * every message it throws from that stage, and the container-application
 * sentence is the runtime's own, surfaced verbatim through the backend's
 * `priorExit=` field. Both are stabler than the explanations they introduce, and
 * neither has a `code` to key on the way a lost exec does.
 */
const AUTH_STAGE = "[stage=auth]";
const NO_APPLICATION = "no container application";

/**
 * Whether this error says the deployment is wrong, and what to say about it.
 *
 * `undefined` for everything else, which is the answer that keeps the existing
 * behaviour: a caller that gets it logs and retries exactly as before.
 */
export function deploymentFault(err: unknown): DeploymentFault | undefined {
  const text = String(err);
  if (text.includes(AUTH_STAGE))
    return {
      summary: "the container image is older than this Worker",
      remedy:
        "the container is running an image that predates this Worker, so the " +
        "two cannot authenticate and nothing can reach it. The image and the " +
        "Worker are released as a pair and have to be deployed together, so " +
        "this clears when an operator redeploys the Worker with its container " +
        "image — no command here can recover it."
    };
  if (text.includes(NO_APPLICATION))
    return {
      summary: "this Worker has no container application",
      remedy:
        "the container application this workspace starts containers from does " +
        "not exist, so no container can start. Deploying the Worker is what " +
        "creates it — deleting it does not cause it to be rebuilt — so this " +
        "clears when an operator redeploys, and not before."
    };
  return undefined;
}
