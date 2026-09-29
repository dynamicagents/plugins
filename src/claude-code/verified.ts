/**
 * The Claude Code version this package's egress gateway and stream parser were
 * last verified against, and the one a deployment's image pins.
 *
 * Both are written against that version's traffic — its headers, its beta list,
 * its `stream-json` lines — and `./capture.json` is that traffic, recorded. The
 * specs read the capture, so they check the gateway and the parser against what
 * this version actually sends and prints.
 *
 * Written by `npm run probe:claude-code -- --record`, never by hand: the value
 * and the capture beside it move together. The README's "Updating Claude Code"
 * is the procedure.
 */
export const VERIFIED_CLAUDE_CODE_VERSION = "2.1.238";
