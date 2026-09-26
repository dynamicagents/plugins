import { describe, it, expect } from "vitest";
import {
  guardPath,
  isGitInternal,
  isSkipped,
  skipNames,
  WALK_SKIPS
} from "./paths.js";

/**
 * The guard, on its own terms.
 *
 * It became a pure function when it stopped resolving symlinks, so this asserts
 * it directly rather than through a tool and a workspace stub. What that cannot
 * show is that each tool actually calls it — `index.spec.ts` keeps those, and
 * both halves are needed: a guard nobody calls passes every test here.
 */

describe("segments, not substrings", () => {
  it("matches .git as a whole segment, sparing the dotfiles that merely start with it", () => {
    expect(isGitInternal("/workspace/repo/.git/config")).toBe(true);
    expect(isGitInternal("/workspace/repo/.git")).toBe(true);
    // The trap: these are ordinary tracked files and must stay readable.
    expect(isGitInternal("/workspace/repo/.gitignore")).toBe(false);
    expect(isGitInternal("/workspace/repo/.gitattributes")).toBe(false);
    expect(isGitInternal("/workspace/repo/.github/workflows/ci.yml")).toBe(
      false
    );
    expect(isGitInternal("/workspace/repo/src/git/index.ts")).toBe(false);
  });

  it("skips node_modules as a whole segment, not as a substring", () => {
    const skips = WALK_SKIPS;
    expect(isSkipped(skips, "/workspace/repo/node_modules/zod/index.js")).toBe(
      true
    );
    expect(isSkipped(skips, "/workspace/repo/node_modules")).toBe(true);
    expect(isSkipped(skips, "/workspace/repo/src/node_modules_old/a.ts")).toBe(
      false
    );
    expect(isSkipped(skips, "/workspace/repo/src/my_node_modules.ts")).toBe(
      false
    );
  });
});

describe("WALK_SKIPS", () => {
  it("names what it skipped, for the sentence that reports a crowded page", () => {
    expect(skipNames(WALK_SKIPS)).toBe("`.git` and `node_modules`");
  });
});

describe("guardPath", () => {
  it("clears an ordinary path", () => {
    expect(guardPath("/workspace/repo/src/a.ts", "read")).toBeUndefined();
  });

  /**
   * The tree is on the container's disk, so the workspace these tools read has
   * nothing there. Unlike `.git`, `bash` is the right route.
   */
  it("routes a node_modules path to bash", () => {
    const note = guardPath(
      "/workspace/repo/node_modules/zod/index.js",
      "read"
    )!;
    expect(note).toContain("bash");
    expect(
      guardPath("/workspace/repo/src/node_modules_old/a.ts", "read")
    ).toBeUndefined();
  });

  /**
   * `.git` is present and refused, so the note names where repository work
   * belongs and, emphatically, does *not* offer `bash` — which would hand
   * back the exact capability the refusal withholds, in the one place the model
   * is looking for a way around it.
   */
  it("redirects a .git path to the repo tools, and never to bash", () => {
    const note = guardPath("/workspace/repo/.git/config", "write")!;
    expect(note).toContain("repo_status");
    expect(note).not.toContain("bash");
  });

  /**
   * The verb is the calling tool's own name. A refusal that says "read cannot
   * see it" while the model called `grep` reads like a bug in the plugin.
   */
  it("names the tool that was called", () => {
    expect(guardPath("/workspace/repo/.git", "grep")).toContain("grep");
  });
});
