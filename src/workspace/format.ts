import type { WorkspaceRuntimeStatus } from "@cloudflare/computer";

/**
 * Text shared by the workspace and the tools over it: the output bound, the
 * elapsed-time phrase, and what a killed command is told.
 */

/** Elapsed time in the shape a sentence wants. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Why a command has nothing to show for itself.
 *
 * {@link renderResult} states a non-`completed` status on its verdict line;
 * {@link file://./exec.ts workspaceExec} has no verdict line, only the four fields its caller
 * branches on. A *killed* process writes nothing, so without this a `git clone`
 * that hit the ten-minute ceiling reaches the model through
 * `@dynamicagents/plugins/repo-github` as `clone failed:` with an empty reason — which reads
 * like a bug in the plugin rather than a limit it can work within.
 *
 * Only `cancelled`. A `failed` status is an ordinary non-zero exit, where the
 * command's own stderr is the better explanation and this would be noise on top
 * of it.
 *
 * Both plausible causes are named because the exit code cannot separate them:
 * 137 is SIGKILL, which is what the timeout sends *and* what the kernel sends a
 * container that ran out of memory.
 */
export function cancelledNote(
  status: WorkspaceRuntimeStatus | undefined,
  exitCode: number,
  timeoutMs: number
): string | undefined {
  if (status !== "cancelled") return undefined;
  return (
    `the command was killed rather than exiting on its own (exit ${exitCode}), so ` +
    `anything it had not yet written is gone. The two usual causes are the ` +
    `per-command time limit — ${humanMs(timeoutMs)} here — and the container ` +
    `running out of memory.`
  );
}
