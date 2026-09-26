import type { WorkspaceRuntimeStatus } from "@cloudflare/computer";

/**
 * Text shared by the workspace and the tools over it: the output bound, the
 * elapsed-time phrase, and what a killed command is told.
 */

/**
 * Middle-out truncation, so both the first error and the final summary survive.
 *
 * The guard is not defensive padding. Without it a `max` at or below the marker's
 * own length makes `half` zero or negative, and `slice(-0)` is `slice(0)` — the
 * *whole* string — so the function returns more than it was given: 500 characters
 * in, 543 out at `max: 80`. A silent inversion of the one thing it does,
 * reachable from a public config field.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  // No budget for two halves plus the marker: keep the head, which is where the
  // first error is, and say nothing clever.
  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

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
 * `@dynamicagents/plugins/repo` as `clone failed:` with an empty reason — which reads
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
