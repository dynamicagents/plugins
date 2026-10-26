import type { GrepMatch } from "./client.js";

/**
 * Turning a result into the text a model reads.
 *
 * One theme runs through all of it: every function here spends a byte budget,
 * and each spends it in the shape its content wants. A command transcript is
 * cut from the middle, because the first error and the final summary are what
 * matter and the middle is noise. A listing or a match set is emitted whole item
 * by whole item until the budget runs out, because cutting *its* middle loses a
 * whole file's worth of hits with nothing to say it happened. Getting those two
 * the wrong way round is the mistake they are kept apart to prevent.
 */

/**
 * How much of one matching line the model is shown.
 *
 * A grep match carries the whole line, and a minified bundle is one line of
 * megabytes — a single match in `dist/` would otherwise be the entire result. The
 * head is kept because a match's file and line number are what the model acts on;
 * it reads the region with `read` next.
 */
const MAX_MATCH_LINE_CHARS = 200;

/** One matching line, bounded — see {@link MAX_MATCH_LINE_CHARS}. */
function capLine(text: string): string {
  // A CRLF file leaves the carriage return on every line, since the reader splits
  // on `\n` alone. Invisible in the output and pure noise in the token count.
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  return line.length <= MAX_MATCH_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_MATCH_LINE_CHARS)}… [+${line.length - MAX_MATCH_LINE_CHARS} chars]`;
}

/**
 * Emit whole items until the byte budget is spent, and report exactly how many.
 *
 * Core's `truncateOutput` is wrong for every list this module produces, and is
 * deliberately not used by them. It keeps both ends and drops the middle, which is
 * right for a build log and destructive for a match list or a directory listing,
 * where the middle is a whole file's worth of hits or a whole subtree that silently
 * vanishes. So the budget is spent item by item, in order, and the caller learns
 * where it stopped.
 *
 * `shown` is the load-bearing return value: it is what makes the next page's offset
 * exact rather than a guess. A block is committed whole or not at all, because half
 * a match's context reads like a corrupt result — and the first block always goes
 * out, so one enormous item cannot produce an empty answer.
 */
export function packBlocks(
  blocks: string[][],
  maxChars: number
): { body: string; shown: number } {
  const out: string[] = [];
  let used = 0;
  let shown = 0;

  for (const block of blocks) {
    const cost = block.reduce((n, line) => n + line.length + 1, 0);
    if (shown > 0 && used + cost > maxChars) break;
    out.push(...block);
    used += cost;
    shown += 1;
  }

  return { body: out.join("\n"), shown };
}

/**
 * Search results, in the shape `grep -n` has trained every model to read.
 *
 * ## Grouped by file
 *
 * Matches arrive contiguous per file — `fs.grep` walks a generator of files — so
 * grouping is free, and it is worth taking: an absolute path in this workspace is
 * ~40 characters, and repeating it on 200 lines spends more of the budget on paths
 * than on code.
 *
 * `:` marks a matching line and `-` a context line, which is `grep`'s own
 * convention. In the payload the distinction is only `isMatch`, and losing it would
 * leave the model unable to tell which line it actually searched for.
 *
 * Only a *suffix* is ever dropped, so grouping survives the cut: a header is emitted
 * whenever the path changes, and no earlier block can disappear from under a later
 * one.
 *
 * `capped` reports whether any line was shortened, so the caller can say once — not
 * once per line — how to reach the full text.
 */
export function renderGrepMatches(
  matches: GrepMatch[],
  maxChars: number
): { body: string; shown: number; capped: boolean } {
  let path: string | undefined;
  const blocks: string[][] = [];
  const hasLongLine: boolean[] = [];

  matches.forEach((match, i) => {
    const block: string[] = [];
    // A blank line before every file but the first, so the groups separate.
    if (match.path !== path)
      block.push(i === 0 ? match.path : `\n${match.path}`);
    path = match.path;

    // `context` already contains the matching line, flagged — so it replaces the
    // bare one rather than being added around it.
    const body = match.context?.length
      ? match.context
      : [{ line: match.line, text: match.text, isMatch: true }];

    hasLongLine.push(body.some((l) => l.text.length > MAX_MATCH_LINE_CHARS));
    for (const line of body)
      block.push(
        `  ${line.line}${line.isMatch ? ":" : "-"} ${capLine(line.text)}`
      );

    blocks.push(block);
  });

  const { body, shown } = packBlocks(blocks, maxChars);
  // Only a line that actually made it out is worth explaining.
  return { body, shown, capped: hasLongLine.slice(0, shown).includes(true) };
}
