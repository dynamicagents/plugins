import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import type { WorkspaceClient } from "@cloudflare/computer";
import { assemblePlugins, PluginSetupError } from "@dynamicagents/core";
import {
  buildComputerTools,
  computer,
  computerWorkspace,
  withShell,
  withShellTranscript,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY,
  type ComputerConfig,
  type WorkspaceAdvisory
} from "./index.js";
import { testPluginContext } from "../../test/helpers.js";

/** What the stub records off an `fs.grep` call. `@cloudflare/computer` declares
 * these but does not re-export them, so the shape is restated here. */
interface GrepOptions extends Page {
  include?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
}

/** The paging pair every listing method on the workspace takes. */
interface Page {
  limit?: number;
  offset?: number;
}

/**
 * Page a canned array the way the real methods do.
 *
 * `offset` is honoured, not just `limit`, and that is deliberate: the whole point
 * of the raw-index bookkeeping under test is that a filtered page reports an offset
 * the *source* understands. A stub that ignored `offset` would return page one
 * forever and every paging assertion below would pass while paging was broken.
 */
const page = <T>(items: T[], options?: Page): T[] => {
  const from = options?.offset ?? 0;
  return items.slice(from, from + (options?.limit ?? items.length));
};

/**
 * The computer tools' behaviour under the conditions that actually bite: output
 * that would blow the context window, an edit whose target is ambiguous, and a
 * path the workspace structurally cannot see.
 *
 * A stub stands in for the workspace — these are mapping and policy decisions,
 * and running a real container to assert them would test Cloudflare's code
 * rather than this package's.
 */

function stub(
  seed: Record<string, string> = {},
  /** Make the container unreachable, for the paths that have to survive it. */
  execThrows?: string | Error
): {
  workspace: () => Promise<WorkspaceClient>;
  execs: Array<{ command: string; options?: unknown }>;
  greps: Array<{ query: string; path: string } & GrepOptions>;
  files: Map<string, string>;
} {
  const execs: Array<{ command: string; options?: unknown }> = [];
  const greps: Array<{ query: string; path: string } & GrepOptions> = [];
  const files = new Map(Object.entries(seed));

  const client = {
    fs: {
      /**
       * Honours the byte range, because that is the half of the contract worth
       * asserting. A stub that ignored `byteOffset`/`byteLength` and returned the
       * whole file would pass every test below while a read shipped more of the
       * file across the boundary than it asked for.
       */
      readFile: async (
        path: string,
        options?: string | { byteOffset?: number; byteLength?: number }
      ) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        if (typeof options !== "object" || !options) return content;
        const start = options.byteOffset ?? 0;
        const end =
          options.byteLength === undefined
            ? undefined
            : start + options.byteLength;
        return content.slice(start, end);
      },
      stat: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return { size: content.length, isFile: true, isDirectory: false };
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, String(content));
      },
      mkdir: async () => undefined,
      exists: async (path: string) => files.has(path),
      /**
       * A real line scan over the seeded files, because the rendering is what
       * these tests are about — grouping, line numbers, context markers and the
       * byte budget all need matches that look like matches. `limit` and `offset`
       * are honoured for the same reason `readFile` honours its byte range: a stub
       * that ignored them would let an unbounded or mis-paged search pass.
       */
      grep: async (query: string, _path: string, options?: GrepOptions) => {
        greps.push({ query, path: _path, ...options });
        const context = options?.context ?? 0;
        const out: Array<{
          path: string;
          line: number;
          text: string;
          context?: Array<{ line: number; text: string; isMatch: boolean }>;
        }> = [];
        for (const [file, content] of files) {
          const lines = content.split("\n");
          lines.forEach((text, i) => {
            if (!text.includes(query)) return;
            const match: (typeof out)[number] = {
              path: file,
              line: i + 1,
              text
            };
            if (context > 0) {
              const from = Math.max(0, i - context);
              match.context = lines
                .slice(from, i + context + 1)
                .map((line, k) => ({
                  line: from + k + 1,
                  text: line,
                  isMatch: from + k === i
                }));
            }
            out.push(match);
          });
        }
        return page(out, options);
      }
    },
    runtime: {
      exec: async (command: string, options?: unknown) => {
        if (execThrows)
          throw typeof execThrows === "string"
            ? new Error(execThrows)
            : execThrows;
        execs.push({ command, options });
        return {
          result: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          [Symbol.dispose]: () => {}
        };
      }
    },
    [Symbol.dispose]: () => {}
  } as unknown as WorkspaceClient;

  return {
    workspace: async () => client,
    execs,
    greps,
    files
  };
}

const config: ComputerConfig = {
  binding: undefined as unknown as ComputerConfig["binding"],
  workspaceName: () => "caller|owner/repo"
};

const run = (tools: ToolSet, name: string, input: unknown) =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(
    input,
    {}
  );

/**
 * The two shell wrappers, and the difference between them.
 *
 * Both pick the shell the model actually writes for and both ask for `pipefail`.
 * They differ on one thing — whether the result is a *transcript* or two separate
 * streams — and that difference is the output contract, which is why it is two
 * named functions rather than one with a flag. A flag put the choice at the call
 * site as a `true` nobody reads, and `computerExec` silently inherited the wrong
 * one for as long as it existed.
 */
/**
 * What `bash` promises the model, which depends on whether a shell was
 * configured.
 *
 * Two of the guarantees are the shell's, not this plugin's: the interleaved
 * transcript is `2>&1` on the wrapper process, and first-failure reporting is
 * `-o pipefail`. Without a shell there is no wrapper to carry either, and a
 * description that promised them anyway would be the exact failure `wrapped`
 * documents at length — a model that cannot trust a piped exit code re-runs the
 * whole gate to get one.
 */
describe("what bash claims for itself", () => {
  const describeOf = (shell?: string) =>
    buildComputerTools(stub().workspace, { ...config, shell }).bash!
      .description!;

  it("promises a transcript and first-failure only with a shell", () => {
    const withShell = describeOf("bash");
    expect(withShell).toContain("interleaved in the order they were written");
    expect(withShell).toContain("report the first failing stage");
  });

  it("promises neither without one, and says what happens instead", () => {
    const bare = describeOf(undefined);
    expect(bare).not.toContain("interleaved in the order they were written");
    expect(bare).not.toContain("report the first failing stage");
    // The honest replacements: labelled blocks, and the pipe's own status.
    expect(bare).toContain("--- stderr ---");
    expect(bare).toContain("reports its **last** stage");
  });

  it("still promises the exit line either way, because that one is ours", () => {
    for (const shell of ["bash", undefined]) {
      expect(describeOf(shell)).toContain("--- exit 0 ---");
    }
  });
});

describe("withShell", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShell("npm test", undefined)).toBe("npm test");
  });

  /**
   * The property `/repo` depends on. It asks git questions whose answer is the
   * whole of stdout — a URL to compare, a sha to push, a count to test against
   * "0" — so a diagnostic merged into that channel is a wrong answer, not noise.
   */
  it("leaves the two streams alone, so stdout carries the answer only", () => {
    const command = withShell("git rev-list --count origin/main..HEAD", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    expect(command).not.toContain("2>&1");
  });

  /**
   * The regression this guards is a *silent* one, and it is the worst kind this
   * tool can produce. Without `pipefail`, a pipeline reports its last stage's
   * status — so `npm run check | tail -100` came back `exit 0` from a gate that
   * had failed in 1.3 seconds on a missing `node_modules`. A build that failed
   * and said it passed is worse than no answer at all.
   */
  it("asks the shell to report the first failing stage of a pipeline", () => {
    expect(withShell("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  /**
   * The command is model-authored and routinely carries its own quoting. If the
   * wrapper re-parsed it, `git commit -m "a message"` would arrive as two
   * arguments and the commit would be made with the wrong message — a silent
   * corruption, not an error.
   */
  it("survives a command that contains its own quotes", () => {
    expect(withShell(`git commit -m "add a line"`, "bash")).toContain(
      "add a line"
    );
  });
});

describe("withShellTranscript", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShellTranscript("npm test", undefined)).toBe("npm test");
  });

  it("merges stderr into stdout on the wrapper process", () => {
    const command = withShellTranscript("npm run check", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    // Bound to the wrapper, not nested inside it — so it applies to everything
    // the command spawns, however deep, with no brace group to mis-parse.
    expect(command.endsWith(" 2>&1")).toBe(true);
  });

  it("keeps pipefail, which is not the half that differs", () => {
    expect(withShellTranscript("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  it("survives a command that contains its own quotes", () => {
    const command = withShellTranscript(`git commit -m "add a line"`, "bash");
    expect(command).toContain("add a line");
    expect(command.endsWith(" 2>&1")).toBe(true);
  });
});

describe("the dependency tree", () => {
  const dep = "/workspace/repo/node_modules/zod/index.ts";

  /**
   * The tree is on the container's disk, so the workspace these tools read has
   * nothing there. Each file tool refuses it and names `bash`, which reaches
   * it; a write would land in the workspace, where nothing would ever read it.
   * The workspace's own methods refuse it too — see `./proxy.spec.ts`.
   */
  it("refuses it in every file tool, routing to bash", async () => {
    const { workspace, files } = stub({ [dep]: "export const z = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    for (const [name, input] of [
      ["edit", { path: dep, old_string: "z", new_string: "y" }],
      ["grep", { query: "z", path: "/workspace/repo/node_modules" }]
    ] as const) {
      expect(await run(tools, name, input)).toContain("bash");
    }
    expect(files.get(dep)).toBe("export const z = 1;\n");
  });

  it("steps over it in a search", async () => {
    const { workspace } = stub({
      "/workspace/repo/src/a.ts": "const marker = 1;\n",
      [dep]: "const marker = 2;\n"
    });
    const out = await run(buildComputerTools(workspace, config), "grep", {
      query: "marker"
    });
    expect(out).toContain("/workspace/repo/src/a.ts");
    expect(out).not.toContain("node_modules");
  });
});

describe("edit", () => {
  const path = "/workspace/repo/a.ts";

  it("replaces a unique string", async () => {
    const { workspace, files } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(
      await run(tools, "edit", { path, old_string: "1", new_string: "2" })
    ).toBe(`edited ${path}`);
    expect(files.get(path)).toBe("const a = 2;\n");
  });

  /** The AI SDK runs one step's tool calls concurrently. */
  it("keeps both of two edits made to one file at once", async () => {
    const { workspace, files } = stub({
      [path]: "const a = 1;\nconst b = 1;\n"
    });
    const tools = buildComputerTools(workspace, config);

    await Promise.all([
      run(tools, "edit", { path, old_string: "a = 1", new_string: "a = 2" }),
      run(tools, "edit", { path, old_string: "b = 1", new_string: "b = 2" })
    ]);
    expect(files.get(path)).toBe("const a = 2;\nconst b = 2;\n");
  });

  /** A parent and a sub-agent hold separate tool sets over one workspace. */
  it("keeps both edits across tool sets that share a workspace", async () => {
    const { workspace, files } = stub({
      [path]: "const a = 1;\nconst b = 1;\n"
    });
    const scope = () => "caller|owner/repo";
    const parent = buildComputerTools(
      workspace,
      config,
      undefined,
      workspace,
      scope
    );
    const child = buildComputerTools(
      workspace,
      config,
      undefined,
      workspace,
      scope
    );

    await Promise.all([
      run(parent, "edit", { path, old_string: "a = 1", new_string: "a = 2" }),
      run(child, "edit", { path, old_string: "b = 1", new_string: "b = 2" })
    ]);
    expect(files.get(path)).toBe("const a = 2;\nconst b = 2;\n");
  });

  /**
   * The replacement is written byte-for-byte, `$` and all.
   *
   * `String.replace` interprets `$$`, `$&`, `` $` `` and `$'` in a *string*
   * replacement even when the pattern is a plain string, so the naive call writes
   * something other than what the model sent — and reports success while doing
   * it. None of these is exotic: `$$` escapes a dollar in a Makefile and reads a
   * PID in shell, and `$'…'` is bash ANSI-C quoting.
   */
  it.each([
    ["a PID, or a Makefile's escaped dollar", "echo $$"],
    ["the whole-match pattern", "a$&b"],
    ["the before-match pattern", "x$`y"],
    ["the after-match pattern", "x$'y"],
    ["bash ANSI-C quoting", "printf '%s' $'\\t'"]
  ])("writes %s literally", async (_why, replace) => {
    const { workspace, files } = stub({ [path]: "const a = MARK;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(
      await run(tools, "edit", {
        path,
        old_string: "MARK",
        new_string: replace
      })
    ).toBe(`edited ${path}`);
    // The file's bytes, not the tool's answer: the defect this guards returns
    // "edited" either way.
    expect(files.get(path)).toBe(`const a = ${replace};\n`);
  });

  /**
   * Refusing an ambiguous edit is the whole value of this tool over `write`:
   * a silent first-match replace corrupts the file in a way that surfaces much
   * later, usually as a confusing test failure.
   */
  it("refuses an ambiguous edit and leaves the file alone", async () => {
    const original = "let x = 1;\nlet y = 1;\n";
    const { workspace, files } = stub({ [path]: original });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "edit", {
      path,
      old_string: "1",
      new_string: "2"
    });
    expect(out).toContain("appears 2 times");
    expect(files.get(path)).toBe(original);
  });

  it("says so when there is no match", async () => {
    const { workspace } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(
      await run(tools, "edit", { path, old_string: "nope", new_string: "x" })
    ).toContain("no match");
  });

  /**
   * Asserted on the schema rather than through `run`, because the schema is
   * where the refusal lives — `run` calls `execute` directly, the way nothing in
   * production does.
   *
   * The body cannot defend itself here: `split("")` counts no occurrences of the
   * empty string, so on an empty file `occurrences` is -1, both guards miss, and
   * `"".replace("", replace)` writes `replace` into the file and reports a
   * successful edit. The other two cases are merely wrong rather than
   * destructive — one character reports "no match", more than one reports one
   * occurrence per character.
   */
  it("refuses an empty old_string at the schema, before any of that can happen", () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);
    const schema = tools.edit!.inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };

    expect(
      schema.safeParse({ path, old_string: "", new_string: "x" }).success
    ).toBe(false);
    expect(
      schema.safeParse({ path, old_string: "a", new_string: "x" }).success
    ).toBe(true);
  });
});

/**
 * Search that does not need the container.
 *
 * That is the reason this tool exists rather than leaving the model on
 * `bash("grep -rn …")`: it reads the durable workspace, so it answers during
 * exactly the window — container being replaced, install still running — when the
 * shell cannot. The bound at the source is the other half, since `.git` is in the
 * workspace and an unbounded search reads every loose object before answering.
 */
describe("grep", () => {
  const path = "/workspace/repo/a.ts";
  const seed = {
    [path]: "import { z } from 'zod';\nconst a = 1;\nconst b = 2;\n"
  };

  it("bounds the search at the source", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    await run(tools, "grep", { query: "const" });
    // One over the ceiling, so a cut result is detected without searching twice.
    expect(greps[0]?.limit).toBe(201);
  });

  it("searches the configured cwd unless told otherwise", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, {
      ...config,
      cwd: "/workspace"
    });

    await run(tools, "grep", { query: "const" });
    expect(greps[0]?.path).toBe("/workspace");

    await run(tools, "grep", { query: "const", path: "/workspace/repo" });
    expect(greps[1]?.path).toBe("/workspace/repo");
  });

  it("returns the hits with their line numbers", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "grep", { query: "const" });
    expect(out).toContain(path);
    expect(out).toContain("  2: const a = 1;");
    expect(out).toContain("  3: const b = 2;");
  });

  /**
   * The query is a value here, not a fragment of a shell command — which is the
   * quieter reason to prefer this over `bash`. Through a shell it would pass
   * `shellQuote` and be re-parsed on the way to `grep`.
   */
  it("forwards the search options rather than reinterpreting them", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    await run(tools, "grep", {
      query: "^const",
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2
    });

    expect(greps[0]).toMatchObject({
      query: "^const",
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2
    });
  });

  it("says it found nothing, and what it looked for", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "grep", {
      query: "nowhere",
      include: "**/*.ts"
    });
    expect(out).toContain("no matches");
    expect(out).toContain("nowhere");
    expect(out).toContain("**/*.ts");
  });

  /**
   * The gate holds `bash` while dependencies install. Holding this too would
   * defeat the point — searching is precisely what an agent can usefully do in
   * that window, and it needs no container to do it.
   */
  it("still searches while a dependency install is in flight", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => [
        {
          kind: "deps-building" as const,
          command: "npm ci",
          startedAt: Date.now()
        }
      ]
    );

    const out = await run(tools, "grep", { query: "const" });
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("still installing");
  });
});

/**
 * `.git` is off limits, and the reason differs from `node_modules`.
 *
 * `node_modules` is *absent* — physics, decided by `computerd`. `.git` is present,
 * readable, and refused anyway — policy, because a model that edits `.git/HEAD` or
 * `.git/config` corrupts a checkout in a way that surfaces much later as an
 * inexplicable git failure. Repository work belongs to the repo tools.
 */
describe("paths inside .git", () => {
  it("refuses every file tool, and points at the repo tools", async () => {
    const { workspace, files } = stub();
    const tools = buildComputerTools(workspace, config);
    const path = "/workspace/repo/.git/config";

    for (const name of ["grep", "edit"]) {
      const out = await run(tools, name, {
        path,
        query: "x",
        old_string: "a",
        new_string: "b"
      });
      expect(out).toContain(".git");
      // A refusal with no destination gets worked around; this one has one.
      expect(out).toContain("repo_diff");
    }
    // The half that matters: nothing landed where a later read would find it.
    expect(files.has(path)).toBe(false);
  });

  /**
   * The property the guard bought when it stopped resolving symlinks: it is two
   * string comparisons, so it runs *before* the workspace is opened and a refused
   * path costs no round trip at all. Asserted on the workspace factory rather than
   * on a timing, because "did not open the workspace" is the observable fact and a
   * duration is not.
   */
  it("refuses without opening the workspace", async () => {
    const { workspace } = stub();
    let opened = 0;
    const counted = () => {
      opened += 1;
      return workspace();
    };
    const tools = buildComputerTools(counted, config);

    for (const name of ["grep", "edit"]) {
      await run(tools, name, {
        path: "/workspace/repo/.git/config",
        query: "x",
        old_string: "a",
        new_string: "b"
      });
    }
    expect(opened).toBe(0);

    // The same tools do open it for a path they allow — otherwise this would
    // pass just as well against a build that never reached the workspace.
    await run(tools, "grep", { query: "x", path: "/workspace/repo/src" });
    expect(opened).toBe(1);
  });

  /**
   * The one prohibition this plugin must never soften. Naming `bash` beside git
   * would hand back the exact capability the refusal withholds, in the one place
   * the model is already looking for a way around it — and with the tool's own
   * authority behind it. Asserted against the rendered strings so a later
   * well-meaning rewording fails here rather than shipping.
   */
  it("never offers bash as a way to reach git", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const refusal = await run(tools, "grep", {
      query: "x",
      path: "/workspace/repo/.git"
    });
    expect(refusal).not.toContain("bash");

    const [block] = computer(config).context!;
    const context = String(await block.provider!.get());
    const gitLine = context
      .split("\n")
      .find((line) => line.includes("`.git`"))!;
    expect(gitLine).toBeDefined();
    expect(gitLine).not.toContain("bash");
    // And it still says where to go instead.
    expect(gitLine).toContain("repo_commit");
  });

  it("keeps .git out of a search", async () => {
    const { workspace } = stub({
      "/workspace/repo/.git/COMMIT_EDITMSG": "fix the parser\n",
      "/workspace/repo/src/a.ts": "// fix the parser later\n"
    });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "grep", { query: "fix the parser" });
    expect(out).toContain("/workspace/repo/src/a.ts");
    expect(out).not.toContain("COMMIT_EDITMSG");
  });

  /**
   * `/repo` runs its git CLI through `computerExec`, not through the tools. A
   * guard there would break clone and commit outright.
   */
  it("does not guard computerExec, which is how /repo runs git", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, config);
    // The tool refuses…
    expect(
      await run(tools, "grep", { query: "x", path: "/workspace/repo/.git" })
    ).toContain("repo_diff");
    // …while the shell path stays open, which is what /repo depends on.
    await run(tools, "bash", { command: "git rev-parse --git-dir" });
    expect(execs).toHaveLength(1);
  });
});

/**
 * Paging, and the bookkeeping that keeps it honest.
 *
 * `grep` filters after the fetch, so its offset has to stay a source coordinate —
 * `offset + shown` would repeat or skip exactly when something was dropped, and
 * silently.
 */
describe("offsets that survive filtering", () => {
  const root = "/workspace/repo";

  it("forwards an offset to the search and reports the next one", async () => {
    const seed = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `${root}/f${i}.ts`,
        "const hit = 1;\n"
      ])
    );
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "grep", { query: "hit", offset: 50 });
    expect(greps[0]?.offset).toBe(50);
    expect(out).toContain("offset:");
  });
});

describe("bash", () => {
  it("passes the configured cwd and timeout, and lets the model override cwd", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, {
      ...config,
      cwd: "/workspace",
      timeoutMs: 1234
    });

    await run(tools, "bash", { command: "npm test" });
    await run(tools, "bash", { command: "ls", cwd: "/workspace/repo" });

    expect(execs[0]).toMatchObject({
      command: "npm test",
      options: { cwd: "/workspace", timeoutMs: 1234, encoding: "utf8" }
    });
    expect(execs[1]!.options).toMatchObject({ cwd: "/workspace/repo" });
  });

  /**
   * The seam, asserted where it actually is.
   *
   * `withShell` and `withShellTranscript` are tested above in isolation, which
   * proves they differ but not that each caller picked the right one — and
   * picking the wrong one is the whole defect. `bash` writes for a model, so
   * it wants the transcript; `computerExec` hands its result to `/repo`, which
   * compares `stdout` against a URL, tests it for emptiness to call a tree clean,
   * and reads a sha out of it to push. Merging there turns every one of those
   * into a question git's diagnostics can answer wrongly.
   */
  it("sends a transcript, while computerExec sends two streams", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, { ...config, shell: "bash" });

    await run(tools, "bash", { command: "npm run check" });

    expect(execs[0]!.command).toContain("bash -o pipefail -c ");
    expect(execs[0]!.command.endsWith(" 2>&1")).toBe(true);
    // The other half of the seam. `computerExec` builds its command with the
    // same `config.shell` and must not come back with the redirect on it.
    expect(withShell("git rev-list --count main..HEAD", "bash")).not.toContain(
      "2>&1"
    );
  });

  /**
   * A config thunk that reads straight off `env` hands back `undefined` for
   * anything unset, and `RuntimeExecOptions.env` is `Record<string, string>` —
   * so an unfiltered pass-through arrives in the container as the literal
   * string "undefined", which is worse than absent.
   */
  it("drops undefined environment entries rather than stringifying them", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, {
      ...config,
      env: () => ({ SET: "yes", UNSET: undefined })
    });

    await run(tools, "bash", { command: "printenv" });

    expect((execs[0]!.options as { env: Record<string, string> }).env).toEqual({
      SET: "yes"
    });
  });

  /**
   * The thunk is the host's, and it is a thunk precisely so a rotated value is
   * picked up per command. Calling it twice while building *one* command's
   * options is two reads that can disagree — the one that decides whether `env`
   * is set, and the one that becomes its value.
   */
  it("reads the host's env thunk once per command", async () => {
    const { workspace } = stub();
    let reads = 0;
    const tools = buildComputerTools(workspace, {
      ...config,
      env: () => {
        reads += 1;
        return { SET: "yes" };
      }
    });

    await run(tools, "bash", { command: "printenv" });

    expect(reads).toBe(1);
  });

  /**
   * The runtime separates "the container was swapped underneath you" from "your
   * command failed". The raw error reads like the latter, and a model that
   * believes it goes debugging a command that never ran — so the facts it needs
   * are stated instead: nothing completed, and the workspace survived, because
   * the filesystem is the Durable Object's rather than the container's.
   */
  it("tells the model a lost execution was the container, not the command", async () => {
    const lost = Object.assign(
      new Error(
        'Execution "e1" was lost when its container runtime was replaced.'
      ),
      { name: "WorkspaceExecutionLostError", code: "EEXEC_LOST" }
    );
    const { workspace } = stub({}, lost);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "bash", { command: "npm test" });
    expect(out).toContain("container was replaced");
    expect(out).toContain("re-run it");
    expect(out).toContain("workspace is durable");
    // Named as infrastructure, not dressed up as a command failure.
    expect(out).not.toContain("error running command");
  });

  it("still reports an ordinary exec failure as one", async () => {
    const { workspace } = stub({}, "container unreachable");
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "bash", { command: "npm test" });
    expect(out).toContain("error running command");
    expect(out).toContain("container unreachable");
  });
});

describe("the advisory gate on bash", () => {
  const gated = (
    advisories: WorkspaceAdvisory[],
    extra: Partial<ComputerConfig> = {}
  ) => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0, ...extra },
      async () => advisories
    );
    return { tools, execs };
  };

  it("runs the command when there is nothing to say", async () => {
    const { tools, execs } = gated([]);
    // The verdict line rides along on every result now, including this one.
    expect(await run(tools, "bash", { command: "npm test" })).toBe(
      "ok\n--- exit 0 ---"
    );
    expect(execs).toHaveLength(1);
  });

  /**
   * The point of the whole mechanism. A shell command against a half-built
   * `node_modules` fails in ways that look like the code's fault, so the tool
   * runs nothing and tells the model to come back — which costs one cheap turn
   * instead of a misdiagnosis.
   */
  it("runs nothing while an install is in flight, and says why", async () => {
    const { tools, execs } = gated([
      {
        kind: "deps-building",
        command: "npm ci",
        startedAt: Date.now() - 65_000,
        tail: "added 200 packages"
      }
    ]);

    const out = await run(tools, "bash", { command: "npm test" });
    expect(out).toContain("still installing");
    expect(out).toContain("npm ci");
    expect(out).toContain("1m05s");
    expect(out).toContain("call again");
    expect(execs).toHaveLength(0);
  });

  /**
   * A broken install **warns and runs**, unlike the building case above, and the
   * asymmetry is what stops a deadlock. Building resolves on its own; broken
   * does not, since nothing clears that record except another checkout — so
   * refusing on it disables the shell for the rest of the session, `echo hello`
   * included, while the refusal tells the model to re-run the install with the
   * tool that is refusing.
   *
   * Read off `shapeOf().transient` rather than off a state name, which is what
   * makes the rule hold for every advisory rather than for the two somebody
   * remembered.
   */
  it("warns about a broken install but still runs the command", async () => {
    const { tools, execs } = gated([
      {
        kind: "deps-broken",
        command: "npm ci",
        exitCode: 1,
        error: "ERESOLVE could not resolve",
        treePresent: false
      }
    ]);

    const out = await run(tools, "bash", { command: "npm test" });
    expect(execs).toHaveLength(1);
    // The real output is there...
    expect(out).toContain("ok");
    // ...and so is the reason it might not mean what it looks like.
    expect(out).toContain("dependency install `npm ci` **failed**");
    expect(out).toContain("exit 1");
    expect(out).toContain("ERESOLVE");
  });

  /** The escape hatch has to actually work — it is what the warning advises. */
  it("lets the model re-run the install itself after a failure", async () => {
    const { tools, execs } = gated([
      {
        kind: "deps-broken",
        command: "npm ci",
        exitCode: 1,
        error: "ERESOLVE could not resolve",
        treePresent: false
      }
    ]);

    await run(tools, "bash", { command: "npm ci --force" });
    expect(execs).toHaveLength(1);
    expect(execs[0]!.command).toBe("npm ci --force");
  });

  /**
   * A dependency advisory reaches only commands that read `node_modules`. This
   * is the behaviour `needsDependencies` exists for, and the reason the filter
   * cannot simply be applied to every advisory — see the next case.
   */
  it("says nothing about dependencies to a command that needs none", async () => {
    const { tools, execs } = gated([
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: false
      }
    ]);

    const out = await run(tools, "bash", { command: "cat README.md" });
    expect(out).not.toContain("ERESOLVE");
    expect(execs).toHaveLength(1);
  });

  /**
   * **The case that was silent.** A workspace over its ceiling accepts no
   * further writes, and the write being lost is almost never a dependency's —
   * so an advisory filtered by `needsDependencies` reached every command except
   * the ones that mattered. `universal` is what exempts it from that filter.
   */
  it("warns a plain file write that its writes are being dropped", async () => {
    const { tools, execs } = gated([
      { kind: "storage-exhausted", bytes: 8.6e9, capBytes: 8e9 }
    ]);

    const out = await run(tools, "bash", { command: "echo hi > /tmp/f" });
    // It ran — permanent things never block, for the deadlock reason above.
    expect(execs).toHaveLength(1);
    expect(out).toContain("nothing further can be written");
    expect(out).toContain("8.6 GB");
  });

  /**
   * **The file tools are where the writes are.**
   *
   * `bash` is not how a coding agent edits source — `write` and `edit` are.
   * Against a workspace that accepts no more writes, a success report is a
   * fabrication the model has no way to doubt, which is the same silent data
   * loss this whole mechanism is about, at the entry point where most of it
   * happens. `write` goes through the workspace, and is held there — see
   * `./proxy.spec.ts`.
   */
  it("refuses an edit when the workspace cannot keep it, leaving the file alone", async () => {
    const path = "/workspace/repo/a.ts";
    const { workspace, files } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, { ...config }, async () => [
      { kind: "storage-exhausted", bytes: 8.6e9, capBytes: 8e9 }
    ]);

    const out = await run(tools, "edit", {
      path,
      old_string: "1",
      new_string: "2"
    });
    expect(out).toContain("Nothing was written");
    expect(files.get(path)).toBe("const a = 1;\n");
  });

  /**
   * A dependency advisory must not reach a write. Source is not `node_modules`,
   * the write will persist perfectly well, and refusing it would take away the
   * one thing an agent can still usefully do while an install is broken.
   */
  it("still edits when the only trouble is dependencies", async () => {
    const path = "/workspace/repo/a.ts";
    const { workspace, files } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, { ...config }, async () => [
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: false
      }
    ]);

    expect(
      await run(tools, "edit", { path, old_string: "1", new_string: "2" })
    ).toBe(`edited ${path}`);
    expect(files.get(path)).toBe("const a = 2;\n");
  });

  /**
   * Both true at once, which a single slot cannot represent: it keeps whichever
   * was written last and silently drops the other, so a command that waits out
   * the install and never hears about the ceiling comes back to a workspace that
   * still cannot keep its work.
   */
  it("reports a full workspace and an install together", async () => {
    const { tools, execs } = gated([
      { kind: "storage-exhausted", bytes: 8.6e9, capBytes: 8e9 },
      { kind: "deps-building", command: "npm ci", startedAt: Date.now() }
    ]);

    const out = await run(tools, "bash", { command: "npm test" });
    expect(execs).toHaveLength(0);
    expect(out).toContain("still installing");
    expect(out).toContain("nothing further can be written");
    // The verdict is stated once, by the only thing that knows it. Rendering it
    // per advisory produced a message that blocked the command and then told the
    // model it had run.
    expect(out).toContain("Nothing was run");
    expect(out).not.toContain("still ran");
  });

  /** A command that throws still carries the warning — it explains the throw. */
  it("keeps the warning when the command itself fails", async () => {
    const { workspace, execs } = stub({}, "container unreachable");
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => [
        {
          kind: "deps-broken" as const,
          command: "npm ci",
          error: "boom",
          treePresent: false
        }
      ]
    );

    const out = await run(tools, "bash", { command: "npm test" });
    expect(out).toContain("dependency install `npm ci` **failed**");
    expect(out).toContain("container unreachable");
    expect(execs).toHaveLength(0);
  });

  /**
   * `installGateMs` is a ceiling, and a fixed sleep would make it a floor: a flat
   * three-second poll blocks a 100 ms gate for about three seconds, overshooting
   * the one knob a host has by 30×. The sleep is clamped to whatever remains.
   */
  it("gives the turn back within the gate, not within a poll interval", async () => {
    const { tools, execs } = gated(
      [{ kind: "deps-building", command: "npm ci", startedAt: Date.now() }],
      { installGateMs: 100 }
    );

    const started = Date.now();
    const out = await run(tools, "bash", { command: "npm test" });
    const elapsed = Date.now() - started;

    expect(out).toContain("still installing");
    expect(execs).toHaveLength(0);
    // The poll interval is three seconds and the gate is a tenth of one. Before
    // the clamp this waited for the former.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("runs the command when the status cannot be read", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, config, async () => {
      throw new Error("stub broken");
    });
    await expect(run(tools, "bash", { command: "npm test" })).resolves.toBe(
      "ok\n--- exit 0 ---"
    );
    expect(execs).toHaveLength(1);
  });

  it("does not gate the file tools, which read source rather than deps", async () => {
    const path = "/workspace/repo/a.ts";
    const { workspace } = stub({ [path]: "x" });
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => [
        {
          kind: "deps-building" as const,
          command: "npm ci",
          startedAt: Date.now()
        }
      ]
    );
    expect(await run(tools, "grep", { query: "x" })).toContain(path);
  });
});

describe("the workspace a sub-agent reaches", () => {
  /**
   * A sub-agent cannot compute the name: its parent chose the checkout. The
   * spec's `prepare` puts it in `runtime()`, and reading it back is what makes
   * a sub-agent land in the checkout its parent cloned.
   */
  it("comes from the runtime when a parent supplied one", () => {
    expect(
      workspaceNameFromRuntime({ [WORKSPACE_RUNTIME_KEY]: "caller|o/r" })
    ).toBe("caller|o/r");
  });

  it("falls back rather than throwing on anything else", () => {
    for (const runtime of [undefined, null, {}, { workspaceName: "" }, 7]) {
      expect(workspaceNameFromRuntime(runtime)).toBeUndefined();
    }
  });
});

/**
 * The plugin as an agent installs it.
 *
 * Its tools take Think's names so they replace Think's built-ins, and Think's
 * `read` and `write` go through the agent's own workspace — so an agent whose
 * workspace is not this container's would read and write one tree and run
 * commands in another. That fails the start, not a turn.
 */
describe("computer()", () => {
  const onWorkspace = (workspace: unknown) =>
    testPluginContext({ workspace: () => workspace as never });

  it("offers its tools under Think's names, so they replace the built-ins", () => {
    const tools = computer(config).tools!(
      onWorkspace(computerWorkspace(config))
    );
    // Think's `find` and `list` stay Think's, walking the workspace.
    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "grep"]);
  });

  it("refuses to start on any other workspace, and says what to set", () => {
    const plugin = computer(config);
    expect(() => plugin.tools!(onWorkspace({}))).toThrow(PluginSetupError);
    expect(() => plugin.tools!(onWorkspace({}))).toThrow(
      /computerWorkspace\(config/
    );
  });

  it("fails the start check core runs, not a turn", () => {
    const assembled = assemblePlugins([computer(config)], {});
    expect(() => assembled.check(onWorkspace({}))).toThrow(PluginSetupError);
    expect(() =>
      assembled.check(onWorkspace(computerWorkspace(config)))
    ).not.toThrow();
  });

  it("tells the model about its tools in a block the model cannot rewrite", async () => {
    const [block] = computer(config).context!;
    expect(block.provider && "set" in block.provider).toBe(false);
    expect(await block.provider!.get()).toContain("`bash`");
  });
});

/**
 * Cancellation, and the two acts it takes when the container runtime has no
 * signal of its own: stop waiting for the command, and stop the command.
 */
describe("a cancelled command", () => {
  function hungContainer() {
    const kills: Array<string | undefined> = [];
    const execs: string[] = [];
    const client = {
      runtime: {
        exec: async (command: string) => {
          execs.push(command);
          return {
            // Never settles: the command is still running when the call ends.
            result: () => new Promise(() => {}),
            kill: async (signal?: string) => void kills.push(signal),
            [Symbol.dispose]: () => {}
          };
        }
      },
      [Symbol.dispose]: () => {}
    } as unknown as WorkspaceClient;
    return { workspace: async () => client, kills, execs };
  }

  const execWith = (tools: ToolSet, input: unknown, abortSignal: AbortSignal) =>
    (tools.bash!.execute as (i: unknown, o: unknown) => Promise<string>)(
      input,
      { abortSignal }
    );

  /** Long enough for every microtask ahead of the exec to drain. */
  const started = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("kills the process rather than abandoning it", async () => {
    const { workspace, kills } = hungContainer();
    const controller = new AbortController();
    const pending = execWith(
      buildComputerTools(workspace, config),
      { command: "npm test" },
      controller.signal
    );

    await started();
    controller.abort();
    const out = await pending;

    // Disposing the handle only detaches this side. Without the kill the command
    // goes on running in the container after the call has given up on it.
    expect(kills).toEqual(["SIGTERM"]);
    expect(out).toContain("cancelled");
  });

  it("says the time limit stopped it when that is what happened", async () => {
    const { workspace } = hungContainer();
    const controller = new AbortController();
    const pending = execWith(
      buildComputerTools(workspace, config),
      { command: "npm test" },
      controller.signal
    );

    await started();
    controller.abort(new DOMException("tool deadline", "TimeoutError"));

    // A model told only that something failed runs the same command again; one
    // told it ran out of time can narrow it.
    expect(await pending).toContain("it ran past this call's time limit");
  });

  it("says nothing ran when the time limit came before the command started", async () => {
    const controller = new AbortController();
    const pending = execWith(
      buildComputerTools(() => new Promise<WorkspaceClient>(() => {}), config),
      { command: "npm test" },
      controller.signal
    );

    await started();
    controller.abort(new DOMException("tool deadline", "TimeoutError"));

    // Not "try something narrower": the command was never the problem, and a
    // narrower one waits on the same workspace.
    const out = await pending;
    expect(out).toContain("did not run");
    expect(out).toContain("nothing was changed");
  });

  it("does not start a command on a call that is already cancelled", async () => {
    const { workspace, execs } = hungContainer();
    const controller = new AbortController();
    controller.abort();

    await execWith(
      buildComputerTools(workspace, config),
      { command: "rm -rf build" },
      controller.signal
    );

    expect(execs).toHaveLength(0);
  });
});

/**
 * Everything in front of the command: the checks that keep it from starting, and
 * the waits a cancel has to reach before it does.
 */
describe("cancellation before the command runs", () => {
  const call = (
    tools: ToolSet,
    name: string,
    input: unknown,
    abortSignal: AbortSignal
  ) =>
    (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(
      input,
      { abortSignal }
    );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops waiting on an advisory read that never answers, without running the command", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 60_000 },
      () => new Promise<readonly WorkspaceAdvisory[]>(() => {})
    );
    const controller = new AbortController();

    const pending = call(
      tools,
      "bash",
      { command: "npm test" },
      controller.signal
    );
    await tick();
    controller.abort();

    // Failing the gate open on a cancel would run the very command given up on.
    expect(await pending).toContain("cancelled");
    expect(execs).toHaveLength(0);
  });

  it("disposes a workspace that opens only after the call gave up", async () => {
    let arrive: ((client: WorkspaceClient) => void) | undefined;
    const tools = buildComputerTools(
      () =>
        new Promise<WorkspaceClient>((resolve) => {
          arrive = resolve;
        }),
      config
    );
    const controller = new AbortController();

    const pending = call(
      tools,
      "bash",
      { command: "npm test" },
      controller.signal
    );
    await tick();
    controller.abort();
    expect(await pending).toContain("cancelled");

    let disposed = false;
    arrive?.({
      [Symbol.dispose]: () => {
        disposed = true;
      }
    } as unknown as WorkspaceClient);
    await tick();
    // Nobody is left holding it, so it is released the moment it turns up.
    expect(disposed).toBe(true);
  });

  it("kills a process whose handle arrives only after the call gave up", async () => {
    let started: ((handle: unknown) => void) | undefined;
    const client = {
      runtime: {
        exec: () =>
          new Promise((resolve) => {
            started = resolve;
          })
      },
      [Symbol.dispose]: () => {}
    } as unknown as WorkspaceClient;
    const tools = buildComputerTools(async () => client, config);
    const controller = new AbortController();

    const pending = call(
      tools,
      "bash",
      { command: "npm test" },
      controller.signal
    );
    await tick();
    controller.abort();
    expect(await pending).toContain("cancelled");

    const kills: Array<string | undefined> = [];
    let disposed = false;
    started?.({
      result: () => new Promise(() => {}),
      kill: async (signal?: string) => void kills.push(signal),
      [Symbol.dispose]: () => {
        disposed = true;
      }
    });
    await tick();
    // Disposing alone detaches this side and leaves the process running.
    expect(kills).toEqual(["SIGTERM"]);
    expect(disposed).toBe(true);
  });
});

/**
 * Which way each tool opens the workspace — `WorkspaceHost.__getWorkspaceFsStub`
 * in `./index.ts` holds why the two openers exist.
 *
 * Asserted per tool, because one that reached for the wrong opener would
 * compile, pass everything else here, and be slow only on a cold container.
 */
describe("which way the workspace is opened", () => {
  /** The two openers, counted apart. Both hand back the same client. */
  function openers(seed: Record<string, string> = {}) {
    const inner = stub(seed);
    const opens = { exec: 0, fs: 0 };
    return {
      ...inner,
      opens,
      tools: buildComputerTools(
        () => {
          opens.exec++;
          return inner.workspace();
        },
        config,
        undefined,
        () => {
          opens.fs++;
          return inner.workspace();
        }
      )
    };
  }

  it("serves every file tool from the filesystem opener", async () => {
    const path = "/workspace/repo/src/a.ts";
    const { tools, opens } = openers({ [path]: "const a = 1;\n" });

    await run(tools, "grep", { query: "const" });
    await run(tools, "edit", {
      path,
      old_string: "const a = 1;",
      new_string: "const a = 2;"
    });

    expect(opens).toEqual({ exec: 0, fs: 2 });
  });

  it("serves a command from the opener that readies the container", async () => {
    const { tools, opens, execs } = openers();

    await run(tools, "bash", { command: "npm test" });

    expect(opens.exec).toBe(1);
    expect(opens.fs).toBe(0);
    expect(execs).toHaveLength(1);
  });

  /**
   * The **fourth argument** is what is optional, not the host method:
   * `WorkspaceHost.__getWorkspaceFsStub` is required. A caller passing one
   * opener gets that opener everywhere, not a file tool with nothing to open.
   */
  it("falls back to the one opener when a host passes only one", async () => {
    const inner = stub();
    let opens = 0;
    const tools = buildComputerTools(() => {
      opens++;
      return inner.workspace();
    }, config);

    await run(tools, "grep", { query: "const" });

    expect(opens).toBe(1);
  });
});
