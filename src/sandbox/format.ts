/**
 * Elapsed time in the shape a sentence wants: seconds under a minute, then
 * minutes and zero-padded seconds.
 *
 * No hours tier, and padded, because every caller renders a command's
 * configured time limit or an install running under one, and those limits are
 * set in minutes. The padding keeps a limit reading as one value rather than
 * two numbers.
 *
 * `/claude-code`'s {@link file://../claude-code/cards.ts duration} is a
 * deliberate second renderer of the same quantity, not a caller of this one.
 * Why the two differ, and what merging them would cost, is stated there.
 */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
