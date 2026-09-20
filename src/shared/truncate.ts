/**
 * The one directory every subpath may reach, and the terms it holds on.
 *
 * Plugin isolation exists so a bundle grows only with what it imports: reaching
 * a sibling drags that sibling's dependencies in behind it, which is why
 * installing `/repo` must not pull `@cloudflare/computer`. A module that imports
 * *nothing* carries none of that, so `verify:exports` lets any subpath reach
 * here — and fails this directory the moment a file in it imports anything at
 * all, relative or bare. That check is the whole reason the exception is safe;
 * a helper that needs a dependency belongs in the plugin that already has it.
 */

/**
 * Middle-out truncation, so both the first error and the final summary survive.
 *
 * The `half < 1` guard is not defensive padding. Without it a `max` at or below
 * the marker's own length makes `half` zero or negative, and `slice(-0)` is
 * `slice(0)` — the *whole* string — so the function returns more than it was
 * given: 500 characters in, 543 out at `max: 80`. A silent inversion of the one
 * thing it does, reachable from a public config field.
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
