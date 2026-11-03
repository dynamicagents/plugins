/**
 * What `npm run verify:references` reads here, and what it is allowed to find.
 *
 * The checker is core's, run through its `da-verify-references` bin, and core is
 * where what a reference is and why only comments are read is explained.
 */
export default {
  scan: ["src", "test", "scripts"],

  // `AGENTS.md` is in. It documents the `{@link file://…}` convention, so one
  // path in it is the example rather than a reference, and that one is allowed
  // below; every other pointer in it is into this package and is exactly the
  // kind that rots.
  loose: ["README.md", "AGENTS.md", "wrangler.jsonc"],

  /**
   * Paths that are deliberately not this package's, with the reason.
   *
   * Add to this only for a path that genuinely lives elsewhere, or is the
   * example rather than a reference. Never to silence a path that has simply
   * gone stale: that one is the finding.
   */
  external: new Map([
    [
      "./package.json",
      "an `exports` map key, not a sibling. The scripts here reason about subpaths"
    ],
    [
      "../path/to.ts",
      "the shape of a `{@link file://…}` pointer, in the comment rule that teaches it"
    ],
    [
      "src/agents/coder/agent.ts",
      "a consumer's layout, naming the file a README example would go in"
    ]
  ])
};
