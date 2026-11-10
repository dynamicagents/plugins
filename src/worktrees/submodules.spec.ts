import { describe, it, expect } from "vitest";
import {
  gitmodulesOf,
  parseGitmodules,
  readSubmodules,
  submoduleCloneUrl,
  submoduleRepos
} from "./submodules.js";

/** `.gitmodules` as `git config --null --get-regexp` prints it. */
const gitmodules = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([key, value]) => `${key}\n${value}\0`)
    .join("");

describe("reading .gitmodules", () => {
  it("groups each submodule's fields, including names with dots in them", () => {
    expect(
      parseGitmodules(
        gitmodules({
          "submodule.a.b.path": "libs/a.b",
          "submodule.a.b.url": "../a.b.git",
          "submodule.a.b.branch": "main",
          "submodule.c.path": "c",
          "submodule.c.url": "https://github.com/acme/c"
        })
      )
    ).toEqual([
      { path: "libs/a.b", url: "../a.b.git", branch: "main" },
      { path: "c", url: "https://github.com/acme/c" }
    ]);
  });

  it("drops an entry git could not check out either", () => {
    expect(parseGitmodules(gitmodules({ "submodule.a.path": "a" }))).toEqual(
      []
    );
  });
});

describe("where a submodule is cloned from", () => {
  const parent = "https://github.com/acme/super.git";

  it("resolves a relative url the way git does, against the superproject's", () => {
    expect(
      submoduleCloneUrl({ path: "core", url: "../core.git" }, parent)
    ).toBe("https://github.com/acme/core.git");
    expect(submoduleCloneUrl({ path: "x", url: "./x" }, parent)).toBe(
      "https://github.com/acme/super.git/x"
    );
  });

  it("refuses ssh, which a container with no key cannot reach anyway", () => {
    expect(() =>
      submoduleCloneUrl(
        { path: "core", url: "git@github.com:acme/core.git" },
        parent
      )
    ).toThrow(/only over https/);
  });
});

/**
 * A `.gitmodules` path becomes a clone target, a cwd, and a row of the lists the
 * branch script reads — so it is refused before any of those, not at each.
 */
describe("which submodule paths are accepted", () => {
  const read = (path: string) =>
    readSubmodules(
      async () => ({
        success: true,
        stdout: gitmodules({
          "submodule.x.path": path,
          "submodule.x.url": "https://github.com/acme/x"
        }),
        stderr: ""
      }),
      "/workspace/super"
    );

  it("accepts an ordinary nested path", async () => {
    await expect(read("libs/core")).resolves.toEqual([
      { path: "libs/core", url: "https://github.com/acme/x" }
    ]);
  });

  it.each([
    ["one that walks out", "../elsewhere"],
    ["an absolute one", "/etc"],
    // One path read as two rows, the second outside the checkout.
    ["one with a newline", "safe\n../outside"],
    ["one with a tab", "safe\tpinned"],
    ["one with an empty segment", "a//b"]
  ])("refuses %s", async (_label, path) => {
    await expect(read(path)).rejects.toThrow(/could leave the checkout/);
  });
});

/**
 * A branch reaches the same rows a path does, so it is refused on the same
 * terms: one value read as two rows is git run outside the checkout.
 */
describe("which submodule branches are accepted", () => {
  const read = (branch: string) =>
    readSubmodules(
      async () => ({
        success: true,
        stdout: gitmodules({
          "submodule.x.path": "x",
          "submodule.x.url": "https://github.com/acme/x",
          "submodule.x.branch": branch
        }),
        stderr: ""
      }),
      "/workspace/super"
    );

  it("accepts a branch, and `.` for the superproject's own", async () => {
    for (const branch of ["main", "release/2", "."]) {
      await expect(read(branch)).resolves.toEqual([
        { path: "x", url: "https://github.com/acme/x", branch }
      ]);
    }
  });

  it.each([
    ["one with a newline", "main\n../other\torigin/main"],
    ["one with a tab", "main\tx"],
    ["one git would refuse", "a..b"]
  ])("refuses %s", async (_label, branch) => {
    await expect(read(branch)).rejects.toThrow(
      /submodule branch git would not take/
    );
  });
});

describe("the repositories a superproject carries", () => {
  it("reads them from `.gitmodules` as text, resolving relative urls and leaving out other hosts", () => {
    const gitmodules = [
      '[submodule "core"]',
      "\tpath = core",
      "\turl = https://github.com/acme/core",
      '[submodule "plugins"]',
      "\tpath = plugins",
      "\turl = ../plugins.git",
      "\tbranch = main",
      '[submodule "elsewhere"]',
      "\tpath = elsewhere",
      "\turl = https://gitlab.com/acme/elsewhere"
    ].join("\n");

    expect(submoduleRepos(gitmodules, "https://github.com/acme/super")).toEqual(
      ["acme/core", "acme/plugins"]
    );
  });
});

/**
 * A superproject's submodules, read from the sandbox's files: `gitmodulesOf`
 * says why as a file, and why a failed read records nothing.
 */
describe("a checkout's .gitmodules", () => {
  /** A sandbox as the file read sees it: `null` is a file that is not there. */
  const sandboxHolding = (
    files: Record<string, string | { throws: unknown }>
  ) => ({
    readFile: async (path: string) => {
      const held = files[path];
      if (held === undefined) return null;
      if (typeof held !== "string") throw held.throws;
      return new TextEncoder().encode(held);
    }
  });

  const read = (files: Record<string, string | { throws: unknown }>) =>
    gitmodulesOf(sandboxHolding(files), "/workspace/super");

  it("is the file", async () => {
    expect(await read({ "/workspace/super/.gitmodules": "[submodule]" })).toBe(
      "[submodule]"
    );
  });

  /**
   * The two nothings, which must not collapse into one. "No submodules" is
   * recorded; "could not read" is not, or a transient fault would erase a
   * superproject's submodules from the selection and send the next session to
   * clone the root alone.
   */
  it("is empty when the repository has no submodules", async () => {
    expect(await read({})).toBe("");
  });

  it("is unknown when the file is there and will not read", async () => {
    expect(
      await read({
        "/workspace/super/.gitmodules": { throws: new Error("EIO") }
      })
    ).toBeUndefined();
  });

  it("is unknown when the sandbox cannot be reached at all", async () => {
    const text = await gitmodulesOf(
      {
        readFile: async () => {
          throw new Error("no such object");
        }
      },
      "/workspace/super"
    );
    expect(text).toBeUndefined();
  });

  /** The parse that turns the file into the repositories a session may work in. */
  it("names the repositories a superproject carries", () => {
    expect(
      submoduleRepos(
        [
          '[submodule "core"]',
          "\tpath = core",
          "\turl = https://github.com/acme/core.git",
          '[submodule "web"]',
          "\tpath = web",
          "\turl = ../web.git"
        ].join("\n"),
        "https://github.com/acme/super"
      )
    ).toEqual(["acme/core", "acme/web"]);
  });
});
