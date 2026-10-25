import { describe, it, expect, vi } from "vitest";
import type { SandboxAdvisory } from "../sandbox/advisory.js";
import { SANDBOX_RUNTIME_KEY } from "../sandbox/name.js";
import { testPluginContext } from "../../test/helpers.js";
import type { ComputerClient } from "./client.js";
import {
  buildComputerTools,
  computer,
  computerWorkspace,
  type SandboxComputerHost
} from "./index.js";
import { routedWorkspace, workspaceRoute } from "./proxy.js";

/**
 * The container's checkout as Think's `read`, `write` and `delete` see it.
 *
 * A fake route stands in for the sandbox: what is this plugin's own is which
 * sandbox a call reaches, what it refuses, and what it hands back — not the
 * filesystem. `./sandbox.spec.ts` runs the client against a fake container.
 */

interface Seen {
  /** Every sandbox name a call opened, in order. */
  opened: string[];
  finds: Array<{
    dir: string;
    pattern?: string;
    exclude?: string[];
    limit?: number;
  }>;
  readdirs: Array<{ dir: string; limit?: number; offset?: number }>;
  greps: Array<{ pattern: string; path: string; exclude?: string[] }>;
}

function fake(
  seed: Record<string, string> = {},
  advisories: readonly SandboxAdvisory[] = [],
  /**
   * Hold the first `writeFile` until this settles — an edit's write, caught
   * between its read and its landing, which is where the lock specs look.
   */
  holdFirstWrite?: Promise<void>
) {
  const files = new Map(Object.entries(seed));
  const seen: Seen = { opened: [], finds: [], readdirs: [], greps: [] };
  const writes = { held: false };
  const missing = (path: string) =>
    new Error(`ENOENT: no such file or directory, open '${path}'`);

  const fs = {
    readFile: async (path: string, encoding?: "utf8") => {
      const content = files.get(path);
      if (content === undefined) throw missing(path);
      return encoding === "utf8" ? content : new Blob([content]).stream();
    },
    stat: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw missing(path);
      return {
        name: path.slice(path.lastIndexOf("/") + 1),
        size: content.length,
        mtime: 1,
        mode: 0o100644,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false
      };
    },
    readdir: async (
      dir: string,
      opts?: { limit?: number; offset?: number }
    ) => {
      seen.readdirs.push({ dir, ...opts });
      return [
        { name: "src", isDirectory: true, isFile: false, size: 0, mtime: 1 },
        { name: "a.ts", isDirectory: false, isFile: true, size: 12, mtime: 1 }
      ];
    },
    find: async (
      dir: string,
      pattern?: string,
      opts?: { exclude?: string[]; limit?: number }
    ) => {
      seen.finds.push({
        dir,
        pattern,
        exclude: opts?.exclude,
        limit: opts?.limit
      });
      return [{ path: `${dir}/a.ts`, type: "file" as const }];
    },
    grep: async (
      pattern: string,
      path: string,
      opts?: { exclude?: string[] }
    ) => {
      seen.greps.push({ pattern, path, exclude: opts?.exclude });
      return [{ path: `${path}/a.ts`, line: 1, text: pattern }];
    },
    writeFile: async (path: string, content: string | Uint8Array) => {
      if (holdFirstWrite && !writes.held) {
        writes.held = true;
        await holdFirstWrite;
      }
      files.set(
        path,
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content)
      );
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    }
  };

  const name = () => "caller|owner/repo";
  const route = {
    name,
    open: async (opened: string) => {
      seen.opened.push(opened);
      return { fs, [Symbol.dispose]: () => {} } as unknown as ComputerClient;
    },
    advisories: async () => advisories
  };
  const workspace = routedWorkspace(route, "/workspace");
  return { route, workspace, files, seen, fs, writes };
}

describe("routedWorkspace", () => {
  it("reads a file whole, however large, as text or as bytes", async () => {
    // Think's `edit` writes back what it read, so a truncated read is a
    // truncated file.
    const body = "HEAD" + "x".repeat(200_000) + "TAIL";
    const { workspace: ws } = fake({ "/workspace/repo/big.js": body });

    expect(await ws.fs.readFile("/workspace/repo/big.js", "utf8")).toBe(body);
    const stream = await ws.fs.readFile("/workspace/repo/big.js");
    expect(await new Response(stream).text()).toBe(body);
  });

  it("throws for a file that is not there, as Computer's tools expect", async () => {
    const { workspace: ws } = fake();

    await expect(ws.fs.readFile("/workspace/repo/nope.ts")).rejects.toThrow(
      "ENOENT"
    );
    await expect(ws.fs.stat("/workspace/repo/nope.ts")).rejects.toThrow(
      "ENOENT"
    );
  });

  it("describes a file the way Computer's tools read one", async () => {
    const { workspace } = fake({ "/workspace/repo/a.ts": "const a = 1;" });
    const stat = await workspace.fs.stat("/workspace/repo/a.ts");

    // `mode` is the container's, because the write tools preserve one. `inode`
    // is the one field the sandbox cannot report.
    expect(stat).toEqual({
      name: "a.ts",
      size: 12,
      mtime: 1,
      mode: 0o100644,
      inode: 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false
    });
  });

  /**
   * Reads as well as writes — see `./paths.ts` — since Think's tools reach the
   * workspace without passing through this plugin's own.
   */
  it.each([
    ["/workspace/repo/.git/config", "repo_diff"],
    ["/workspace/repo/node_modules/zod/index.ts", "exec"]
  ])(
    "refuses %s for every call, without opening anything",
    async (path, route) => {
      const { workspace: ws, seen, files } = fake({ [path]: "x" });

      for (const call of [
        () => ws.fs.readFile(path),
        () => ws.fs.stat(path),
        () => ws.fs.readdir(path),
        () => ws.fs.find(path),
        () => ws.fs.grep("x", path),
        () => ws.fs.writeFile(path, "y"),
        () => ws.fs.mkdir(path),
        () => ws.fs.rm(path)
      ]) {
        await expect(call()).rejects.toThrow(route);
      }
      expect(seen.opened).toEqual([]);
      expect(files.get(path)).toBe("x");
    }
  );

  it("still writes while an install is broken, which does not lose writes", async () => {
    const { workspace, files } = fake({}, [
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: false
      }
    ]);

    await workspace.fs.writeFile("/workspace/repo/a.ts", "x");
    expect(files.get("/workspace/repo/a.ts")).toBe("x");
  });

  it("passes a listing's bounds through to the store", async () => {
    const { workspace, seen } = fake();
    const entries = await workspace.fs.readdir("/workspace/repo", {
      limit: 50,
      offset: 10
    });

    expect(seen.readdirs).toEqual([
      { dir: "/workspace/repo", limit: 50, offset: 10 }
    ]);
    // `parentPath` is the directory read, which is what joins onto a name.
    expect(entries.map((e) => [e.parentPath, e.name, e.isDirectory])).toEqual([
      ["/workspace/repo", "src", true],
      ["/workspace/repo", "a.ts", false]
    ]);
  });

  it("prunes .git and node_modules from every walk, and searches the rest", async () => {
    const { workspace: ws, seen } = fake();

    await ws.fs.find("/workspace/repo/src", "**/*.ts");
    await ws.fs.grep("marker", "/workspace/repo/src");

    expect(seen.finds).toEqual([
      {
        dir: "/workspace/repo/src",
        pattern: "**/*.ts",
        exclude: ["**/.git", "**/node_modules"],
        limit: undefined
      }
    ]);
    expect(seen.greps).toEqual([
      {
        pattern: "marker",
        path: "/workspace/repo/src",
        exclude: ["**/.git", "**/node_modules"]
      }
    ]);
  });

  /**
   * Think's own directories sit beside the checkouts at the root, so a walk of
   * the root reaches them and a walk inside a checkout cannot. The exclusion is
   * therefore a name *at the root*, which is what leaves a repository's own
   * `attachments/` searchable.
   */
  it("prunes Think's own directories from a walk of the root, and only there", async () => {
    const { workspace: ws, seen } = fake();

    await ws.fs.find("/workspace", "**/*.png");
    await ws.fs.find("/workspace/repo", "**/*.png");

    expect(seen.finds[0]?.exclude).toEqual([
      "**/.git",
      "**/node_modules",
      "attachments/**",
      "fetched/**",
      ".agents/**"
    ]);
    expect(seen.finds[1]?.exclude).toEqual(["**/.git", "**/node_modules"]);
  });

  /**
   * The directory is the model's to spell, and a trailing slash is a spelling
   * it produces. Compared verbatim it misses the root, and the walk hands back
   * the agent's own directories as if they were the repository's.
   */
  it("prunes them for the root however the path is spelled", async () => {
    const { workspace: ws, seen } = fake();

    await ws.fs.find("/workspace/", "**/*.png");

    expect(seen.finds[0]?.exclude).toContain("attachments/**");
  });

  /**
   * Think writes evicted media as bytes, and the marker it leaves in the
   * conversation names the path it wrote. A workspace that refused bytes would
   * make the marker point at nothing.
   */
  it("takes a byte write, which is how Think preserves evicted media", async () => {
    const { workspace, files } = fake();
    const path = "/workspace/attachments/evicted/msg-0.png";

    await workspace.fs.writeFile(path, new TextEncoder().encode("PNG"));
    expect(files.get(path)).toBe("PNG");

    await workspace.fs.writeFile(
      path,
      new Blob([new TextEncoder().encode("PNG2")]).stream()
    );
    expect(files.get(path)).toBe("PNG2");
  });

  /**
   * Computer's exec tool is built only for a workspace carrying a `runtime`, so
   * withholding one is what keeps a second shell from appearing over the same
   * container beside this package's own.
   */
  it("carries no runtime, so Think builds no exec tool of its own", () => {
    const { workspace } = fake();
    expect("runtime" in workspace).toBe(false);
  });

  /**
   * The `edit` tool holds the file's lock across its read and its write, and a
   * write or a delete through the workspace takes the same lock — so it lands
   * after the edit, never between the edit's read and its write, where the
   * edit's write would undo it and both would report success.
   *
   * The edit is caught with its write held, and the other call given time to
   * land: unlocked, it would, before the edit's write.
   */
  async function raceAnEdit(
    other: (workspace: ReturnType<typeof routedWorkspace>) => Promise<void>
  ) {
    const path = "/workspace/repo/a.ts";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { route, workspace, files, writes } = fake(
      { [path]: "const a = 1;\n" },
      [],
      held
    );
    const tools = buildComputerTools(
      () => route.open(route.name()),
      {},
      undefined,
      route.name
    );

    const editing = (
      tools.edit!.execute as (i: unknown, o: unknown) => Promise<string>
    )({ path, old_string: "1", new_string: "2" }, {});
    await vi.waitFor(() => expect(writes.held).toBe(true));
    const racing = other(workspace);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([editing, racing]);
    return files.get(path);
  }

  it("never lands a write inside an edit of the same file", async () => {
    expect(
      await raceAnEdit((ws) => ws.fs.writeFile("/workspace/repo/a.ts", "new\n"))
    ).toBe("new\n");
  });

  it("never lands a delete inside an edit of the same file", async () => {
    expect(
      await raceAnEdit((ws) => ws.fs.rm("/workspace/repo/a.ts"))
    ).toBeUndefined();
  });
});

/** A sandbox whose files are all `content`, recording each name it is reached by. */
function sandboxHolding(content: string) {
  const reached: string[] = [];
  const binding = {
    getByName: (name: string) => {
      reached.push(name);
      return {
        readFile: async () => new TextEncoder().encode(content),
        writeFile: async () => undefined,
        stat: async () => ({
          type: "file",
          size: content.length,
          modifiedAt: 1,
          mode: 0o100644
        }),
        advisories: async () => []
      };
    }
  } as unknown as DurableObjectNamespace<SandboxComputerHost>;
  return { binding, reached };
}

describe("computerWorkspace", () => {
  /**
   * A parent names its sandbox from config; a sub-agent reads the one its
   * parent prepared out of `runtime()`. Read per call, because the runtime
   * belongs to the turn.
   */
  it("reaches the sandbox the running turn names", async () => {
    const { binding, reached } = sandboxHolding("x");
    let runtime: Record<string, unknown> | undefined = undefined;
    const ws = computerWorkspace(
      { binding, sandboxName: () => "caller|owner/repo" },
      () => runtime
    );

    await ws.fs.readFile("/workspace/repo/a.ts");
    runtime = { [SANDBOX_RUNTIME_KEY]: "caller|owner/repo#w1" };
    await ws.fs.readFile("/workspace/repo/a.ts");

    expect(reached).toEqual(["caller|owner/repo", "caller|owner/repo#w1"]);
  });
});

/**
 * The tools reach the sandbox through the agent's own workspace, not their own
 * config. A workspace built without the runtime a sub-agent needs is then the
 * wrong sandbox for both — never one tree for `exec` and another for Think's
 * `write`.
 */
describe("the tools and the workspace", () => {
  it("reach the one sandbox the agent's workspace names", async () => {
    const { binding, reached } = sandboxHolding("const a = 1;\n");
    const runtime = { [SANDBOX_RUNTIME_KEY]: "caller|owner/repo#w1" };
    const workspace = computerWorkspace(
      { binding, sandboxName: () => "caller|owner/repo" },
      () => runtime
    );
    const tools = computer({}).tools!(
      testPluginContext({ workspace: () => workspace })
    );

    await (tools.edit!.execute as (i: unknown, o: unknown) => Promise<string>)(
      { path: "/workspace/repo/a.ts", old_string: "1", new_string: "2" },
      {}
    );
    await workspace.fs.readFile("/workspace/repo/a.ts");

    expect(new Set(reached)).toEqual(new Set(["caller|owner/repo#w1"]));
  });
});

describe("workspaceRoute", () => {
  it("knows its own and nothing else", () => {
    const { workspace } = fake();
    expect(workspaceRoute(workspace)).toBeDefined();
    expect(workspaceRoute({})).toBeUndefined();
    expect(workspaceRoute(undefined)).toBeUndefined();
    // A copy of the methods is not the workspace: the brand does not spread.
    expect(workspaceRoute({ ...workspace })).toBeUndefined();
  });
});
