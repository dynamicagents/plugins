/**
 * What the devkit checkers read here, a section per checker.
 *
 * The checkers themselves are `.devkit/`, vendored from dev-agents'
 * `packages/devkit`; that package's README is the home of what each one fails
 * on and of every key below. This file is only what is this package's.
 */
export default {
  references: {
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
        "../path/to.ts",
        "the shape of a `{@link file://…}` pointer, in the comment rule that teaches it"
      ],
      [
        "src/agents/coder/agent.ts",
        "a consumer's layout, naming the file a README example would go in"
      ]
    ])
  },

  exports: {
    /** Subpaths that are a container image's entrypoint, never a Worker's import. */
    nodeOnly: ["./sandbox/daemon"],

    /**
     * The subpaths a subpath may reach besides its own, by declaration. Its
     * presence is what turns the own-directory rule on for this package.
     *
     * `/computer` is an agent's tools over a `/sandbox` object and cannot run
     * without one, so reaching it costs a consumer nothing it was not already
     * carrying. It reaches `/sandbox`'s leaf modules, never its object, which is
     * what keeps the container backend out of a bundle that holds only the tools.
     */
    buildsOn: {
      "./computer": ["./sandbox"],
      // Its egress rule and its git are a sandbox's: the contract they meet is `/sandbox`'s.
      "./repo-github": ["./sandbox"],
      // The image's entrypoint shares the object's constants and run header.
      "./sandbox/daemon": ["./sandbox"],
      // On a sandbox: its run header, its egress routes and its RPCs' shapes.
      "./claude-code": ["./sandbox"],
      // The Claude Code CLI in a sandbox image: this plugin's parser and cards.
      "./claude-code/daemon": ["./claude-code", "./sandbox"],
      // A worktree is a sandbox cloned with `/repo-github`'s git, by its branch rule.
      "./worktrees": ["./repo-github", "./sandbox"]
    },

    /**
     * A root barrel re-exports every plugin, so importing one would pull in all
     * of them, which is the exact promise this package makes.
     */
    forbidRootExport: true
  },

  linkLocal: {
    /** Checkouts this package builds against. A missing one is an error. */
    siblings: ["core"],

    /**
     * Packed too when present, skipped when not.
     *
     * `g2a-protocol` is core's own dependency rather than this package's,
     * nothing here imports it, so it normally arrives transitively from the
     * registry. But a local core built against an unpublished protocol change
     * needs that change installed too, or the tarball resolves the published
     * copy and the two disagree.
     */
    optional: ["g2a-protocol"]
  }
};
