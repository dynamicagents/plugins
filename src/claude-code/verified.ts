/**
 * The Claude Code version this package's egress gateway and stream parser were
 * last verified against, and the one a deployment's image pins.
 *
 * Both are written against that version's traffic — its headers, its beta list,
 * its `stream-json` lines — and the probe's capture,
 * `test/fixtures/claude-code-probe-capture.json`, is that traffic, recorded. The
 * specs read the capture, so they check the gateway and the parser against what
 * this version actually sends and prints.
 *
 * Written by `npm run probe:claude-code -- --record`, never by hand: the value
 * and the capture move together. AGENTS.md's "Updating Claude Code" is the
 * procedure.
 */
export const VERIFIED_CLAUDE_CODE_VERSION = "2.1.285";
