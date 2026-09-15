import { describe, it, expect } from "vitest";
import {
  guardPath,
  isGitInternal,
  isSkipped,
  skipNames,
  walkSkips
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
    const skips = walkSkips("/workspace/repo");
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

/**
 * A walk skips the big directories *unless the caller named one*, which is the
 * half that keeps the skip from becoming a wall: a search rooted inside a
 * dependency that skipped that dependency would match nothing and report that
 * everything was skipped, sending the model after a bug that is not there.
 */
describe("walkSkips", () => {
  it("skips both by default", () => {
    expect([...walkSkips("/workspace/repo")]).toEqual([".git", "node_modules"]);
  });

  it("stops skipping the dependency tree when the caller names it", () => {
    expect([...walkSkips("/workspace/repo/node_modules/zod")]).toEqual([
      ".git"
    ]);
  });

  /**
   * `.git` has no opt-in, and the two halves of that agree: a walk rooted inside
   * it is refused by `guardPath` before it starts, and a walk that merely passes
   * through it still drops those results. Naming it cannot turn the policy off.
   */
  it("keeps skipping .git even when it is named", () => {
    expect([...walkSkips("/workspace/repo/.git")]).toContain(".git");
    expect(guardPath("/workspace/repo/.git", "sb_grep")).toBeDefined();
  });

  it("searches a named directory rather than reporting it skipped", () => {
    const skips = walkSkips("/workspace/repo/node_modules/zod");
    expect(isSkipped(skips, "/workspace/repo/node_modules/zod/index.js")).toBe(
      false
    );
  });

  it("names what it skipped, for the sentence that reports a crowded page", () => {
    expect(skipNames(walkSkips("/workspace/repo"))).toBe(
      "`.git` and `node_modules`"
    );
    expect(skipNames(walkSkips("/workspace/repo/node_modules"))).toBe("`.git`");
  });
});

describe("guardPath", () => {
  it("clears an ordinary path", () => {
    expect(guardPath("/workspace/repo/src/a.ts", "sb_read")).toBeUndefined();
  });

  /**
   * The dependency tree is part of the workspace, so a read of one is an
   * ordinary read. Refusing it would be the plugin describing a filesystem that
   * is no longer there, and the model would route around the refusal into
   * `sb_exec` for a file the file tools can serve.
   */
  it("clears a path inside the dependency tree", () => {
    expect(
      guardPath("/workspace/repo/node_modules/zod/index.js", "sb_read")
    ).toBeUndefined();
  });

  /**
   * `.git` is present and refused, so the note names where repository work
   * belongs and, emphatically, does *not* offer `sb_exec` — which would hand
   * back the exact capability the refusal withholds, in the one place the model
   * is looking for a way around it.
   */
  it("redirects a .git path to the repo tools, and never to sb_exec", () => {
    const note = guardPath("/workspace/repo/.git/config", "sb_write")!;
    expect(note).toContain("repo_status");
    expect(note).not.toContain("sb_exec");
  });

  /**
   * The verb is the calling tool's own name. A refusal that says "sb_read cannot
   * see it" while the model called `sb_grep` reads like a bug in the plugin.
   */
  it("names the tool that was called", () => {
    expect(guardPath("/workspace/repo/.git", "sb_grep")).toContain("sb_grep");
  });
});
