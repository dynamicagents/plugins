#!/usr/bin/env node
/**
 * Fail if a comment names a sibling file that is not there.
 *
 * This package comments heavily and cross-references constantly, and a reference
 * is the part that rots first: the file moves, the comment stays, and the next
 * reader spends a minute proving the note is stale rather than reading it.
 *
 * **Relative references only**, and that is the whole scope. A rename inside a
 * directory leaves the old name in every comment that pointed at it, and nothing
 * else here notices — `tsc` sees imports, and a path inside a block comment is
 * not one. Those are checkable against the file that wrote them, so they are
 * checked.
 *
 * Package-rooted paths are deliberately out. In this repo they are almost always
 * illustrative (a snippet showing a consumer their own layout) or a path into
 * another repo of the train, which AGENTS.md says to write as prose precisely
 * because it does not resolve from here. Checking them would mean an allowlist
 * longer than the rule.
 *
 * A reference spelled `.js` resolves against the `.ts` beside it, so a comment
 * written the way an import is spelled still checks out.
 *
 * Run: `npm run verify:references`
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SCAN = ["src", "test", "scripts"];
// AGENTS.md is left out: it documents the `{@link file://…}` convention, so the
// paths in it are the example rather than a reference to anything.
const LOOSE = ["README.md", "wrangler.jsonc"];
const EXT = /\.(ts|mjs|js|md|json|jsonc)$/;
// Longest alternative first. Regex alternation is ordered, so a shorter
// extension listed ahead of a longer one that starts with it truncates the
// match and reports a file nobody named — `js` ahead of `json` did exactly that
// here, and this script found it in itself.
const TARGET = "(?:jsonc|json|mjs|md|ts|js)";

/** A sibling or a neighbour, resolved against the file that names it. */
const RELATIVE = new RegExp(
  `(?<![\\w.-])\\.{1,2}/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.${TARGET}`,
  "g"
);

/**
 * Paths that are deliberately not this package's, with the reason.
 *
 * Add to this only for a path that genuinely lives elsewhere — never to silence
 * a reference that has simply gone stale.
 */
const EXTERNAL = new Map([
  [
    "./package.json",
    "an `exports` map key, not a sibling — scripts here reason about subpaths"
  ]
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXT.test(entry) ? [full] : [];
  });

const files = [
  ...SCAN.flatMap((d) => walk(path.join(root, d))),
  ...LOOSE.map((f) => path.join(root, f)).filter(existsSync)
];

/** A reference resolves if it is there, or if its `.js` is a `.ts` beside it. */
const resolves = (abs) =>
  existsSync(abs) ||
  (abs.endsWith(".js") && existsSync(abs.slice(0, -3) + ".ts"));

const lineOf = (text, ref) =>
  text.slice(0, text.indexOf(ref)).split("\n").length;

let failed = false;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  const report = (ref, abs) => {
    if (seen.has(ref) || EXTERNAL.has(ref) || resolves(abs)) return;
    seen.add(ref);
    failed = true;
    console.error(
      `✗ ${path.relative(root, file)}:${lineOf(text, ref)} names ${ref}, which does not exist`
    );
  };
  for (const [ref] of text.matchAll(RELATIVE))
    report(ref, path.resolve(path.dirname(file), ref));
}

if (failed) {
  console.error(
    "\nA comment points at a file that is not there. Either the path moved and " +
      "the comment did not, or the reference was never right. Fix the comment — " +
      "and if the path really is outside this package, say so in EXTERNAL above."
  );
  process.exit(1);
}

console.log("Every path named in a comment exists.");
