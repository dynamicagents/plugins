import { describe, it, expect } from "vitest";
import type { WorkspaceClient } from "@cloudflare/computer";
import {
  buildComputerTools,
  computerWorkspace,
  isComputerWorkspace,
  WORKSPACE_RUNTIME_KEY,
  type ComputerConfig,
  type WorkspaceAdvisory
} from "./index.js";

/**
 * The container's workspace as Think's `read`, `write` and `delete` see it.
 *
 * A fake binding stands in for the Durable Object: what is this plugin's own is
 * which workspace a call reaches, what it refuses, and what it hands back — not
 * the filesystem, which is Cloudflare's. The workspace-object spec runs the same
 * calls against a real one.
 */

interface Seen {
  /** Every workspace name a call opened, in order. */
  opened: string[];
  finds: Array<{ dir: string; pattern?: string; exclude?: string[] }>;
  readdirs: Array<{ dir: string; limit?: number; offset?: number }>;
}

function fake(
  seed: Record<string, string> = {},
  advisories: readonly WorkspaceAdvisory[] = [],
  /** Hold every `readFile` until this settles — for the lock spec. */
  readGate?: Promise<void>
) {
  const files = new Map(Object.entries(seed));
  const seen: Seen = { opened: [], finds: [], readdirs: [] };
  const missing = (path: string) =>
    new Error(`ENOENT: no such file or directory, open '${path}'`);

  const fs = {
    readFile: async (path: string, encoding?: "utf8") => {
      await readGate;
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
      opts?: { exclude?: string[] }
    ) => {
      seen.finds.push({ dir, pattern, exclude: opts?.exclude });
      return [{ path: `${dir}/a.ts`, type: "file" as const }];
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    }
  };

  const binding = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      __getWorkspaceFsStub: async () => {
        seen.opened.push(name);
        return {
          fs,
          runtime: {},
          useThink: false,
          [Symbol.dispose]: () => {}
        };
      },
      advisories: async () => advisories
    })
  } as unknown as ComputerConfig["binding"];

  const config: ComputerConfig = {
    binding,
    workspaceName: () => "caller|owner/repo"
  };
  return { config, files, seen, fs };
}

describe("computerWorkspace", () => {
  it("reads a file whole, however large", async () => {
    // Think's `edit` writes back what it read, so a truncated read is a
    // truncated file.
    const body = "HEAD" + "x".repeat(200_000) + "TAIL";
    const { config } = fake({ "/workspace/repo/big.js": body });
    const ws = computerWorkspace(config);

    expect(await ws.readFile("/workspace/repo/big.js")).toBe(body);
    expect(
      new TextDecoder().decode(
        (await ws.readFileBytes("/workspace/repo/big.js"))!
      )
    ).toBe(body);
  });

  it("answers null for a file that is not there, as Think's tools expect", async () => {
    const { config } = fake();
    const ws = computerWorkspace(config);

    expect(await ws.readFile("/workspace/repo/nope.ts")).toBeNull();
    expect(await ws.readFileBytes("/workspace/repo/nope.ts")).toBeNull();
    expect(await ws.stat("/workspace/repo/nope.ts")).toBeNull();
  });

  it("describes a file the way Think's tools read one", async () => {
    const { config } = fake({ "/workspace/repo/a.ts": "const a = 1;" });
    const stat = await computerWorkspace(config).stat("/workspace/repo/a.ts");

    expect(stat).toMatchObject({
      path: "/workspace/repo/a.ts",
      name: "a.ts",
      type: "file",
      size: 12
    });
  });

  /**
   * Reads as well as writes. `.git` is policy and `node_modules` is a fact —
   * see `./paths.ts` — and Think's tools reach the workspace without passing
   * through this plugin's own.
   */
  it.each([
    ["/workspace/repo/.git/config", "repo_diff"],
    ["/workspace/repo/node_modules/zod/index.ts", "bash"]
  ])(
    "refuses %s for every call, without opening anything",
    async (path, route) => {
      const { config, seen, files } = fake({ [path]: "x" });
      const ws = computerWorkspace(config);

      for (const call of [
        () => ws.readFile(path),
        () => ws.readFileBytes(path),
        () => ws.stat(path),
        () => ws.readDir(path),
        () => ws.writeFile(path, "y"),
        () => ws.mkdir(path),
        () => ws.rm(path)
      ]) {
        await expect(call()).rejects.toThrow(route);
      }
      expect(seen.opened).toEqual([]);
      expect(files.get(path)).toBe("x");
    }
  );

  /**
   * Thrown, not returned: Think's `write` reports a thrown error to the model,
   * and a write that returned would read as one that landed.
   */
  it("refuses a write the workspace cannot keep", async () => {
    const { config, files } = fake({}, [
      { kind: "storage-exhausted", bytes: 8.6e9, capBytes: 8e9 }
    ]);
    const ws = computerWorkspace(config);

    for (const call of [
      () => ws.writeFile("/workspace/repo/a.ts", "x"),
      () => ws.mkdir("/workspace/repo/src", { recursive: true }),
      () => ws.rm("/workspace/repo/a.ts")
    ]) {
      await expect(call()).rejects.toThrow("Nothing was written");
    }
    expect(files.has("/workspace/repo/a.ts")).toBe(false);
  });

  it("still writes while an install is broken, which does not lose writes", async () => {
    const { config, files } = fake({}, [
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: false
      }
    ]);

    await computerWorkspace(config).writeFile("/workspace/repo/a.ts", "x");
    expect(files.get("/workspace/repo/a.ts")).toBe("x");
  });

  it("passes a listing's bounds through to the store", async () => {
    const { config, seen } = fake();
    const entries = await computerWorkspace(config).readDir("/workspace/repo", {
      limit: 50,
      offset: 10
    });

    expect(seen.readdirs).toEqual([
      { dir: "/workspace/repo", limit: 50, offset: 10 }
    ]);
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ["/workspace/repo/src", "directory"],
      ["/workspace/repo/a.ts", "file"]
    ]);
  });

  it("walks a glob from its fixed prefix, with .git and node_modules pruned", async () => {
    const { config, seen } = fake();
    const ws = computerWorkspace(config);

    await ws.glob("/workspace/repo/src/**/*.ts");
    await ws.glob("*.md");

    expect(seen.finds).toEqual([
      {
        dir: "/workspace/repo/src",
        pattern: "**/*.ts",
        exclude: ["**/.git", "**/node_modules"]
      },
      {
        dir: "/workspace",
        pattern: "*.md",
        exclude: ["**/.git", "**/node_modules"]
      }
    ]);
  });

  it("offers no byte writes, so Think writes nothing of its own into a checkout", () => {
    const { config } = fake();
    expect("writeFileBytes" in computerWorkspace(config)).toBe(false);
  });

  /**
   * A parent names its workspace from config; a sub-agent reads the one its
   * parent prepared out of `runtime()`. Read per call, because the runtime
   * belongs to the turn.
   */
  it("reaches the workspace the running turn names", async () => {
    const { config, seen } = fake({ "/workspace/repo/a.ts": "x" });
    let runtime: Record<string, unknown> | undefined = undefined;
    const ws = computerWorkspace(config, () => runtime);

    await ws.readFile("/workspace/repo/a.ts");
    runtime = { [WORKSPACE_RUNTIME_KEY]: "caller|owner/repo#w1" };
    await ws.readFile("/workspace/repo/a.ts");

    expect(seen.opened).toEqual(["caller|owner/repo", "caller|owner/repo#w1"]);
  });

  /**
   * The `edit` tool holds the file's lock across its read and its write, and a
   * `write` through the workspace takes the same lock — so it lands after the
   * edit rather than between the edit's read and the edit's write, where the
   * edit would overwrite it.
   */
  it("never lands a write inside an edit of the same file", async () => {
    const path = "/workspace/repo/a.ts";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { config, files, fs } = fake({ [path]: "const a = 1;\n" }, [], held);
    const client = async () =>
      ({ fs, [Symbol.dispose]: () => {} }) as unknown as WorkspaceClient;
    const tools = buildComputerTools(client, config, undefined, client, () =>
      config.workspaceName()
    );

    const editing = (
      tools.edit!.execute as (i: unknown, o: unknown) => Promise<string>
    )({ path, old_string: "1", new_string: "2" }, {});
    const writing = computerWorkspace(config).writeFile(path, "rewritten\n");
    release();
    await Promise.all([editing, writing]);

    expect(files.get(path)).toBe("rewritten\n");
  });
});

describe("isComputerWorkspace", () => {
  it("knows its own and nothing else", () => {
    const { config } = fake();
    expect(isComputerWorkspace(computerWorkspace(config))).toBe(true);
    expect(isComputerWorkspace({})).toBe(false);
    expect(isComputerWorkspace(undefined)).toBe(false);
    // A copy of the methods is not the workspace: the brand does not spread.
    expect(isComputerWorkspace({ ...computerWorkspace(config) })).toBe(false);
  });
});
