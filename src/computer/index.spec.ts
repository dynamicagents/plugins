import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { assemblePlugins, PluginSetupError } from "@dynamicagents/core";
import type { SandboxAdvisory } from "../sandbox/advisory.js";
import type { ComputerClient } from "./client.js";
import {
  buildComputerTools,
  computer,
  computerWorkspace,
  type ComputerToolsConfig,
  type SandboxComputerHost
} from "./index.js";
import { testPluginContext } from "../../test/helpers.js";

/** What the stub records off an `fs.grep` call. */
interface GrepOptions extends Page {
  include?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
  exclude?: string[];
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
 * Model the store's `exclude`: `**\/<name>` prunes the directory `<name>` and
 * everything beneath it, matched as a whole path segment — so a
 * `node_modules_old` survives a `**\/node_modules`.
 *
 * Pruning happens *before* paging, which is the half that matters: `offset` then
 * counts only matches a caller can be shown, and that is what lets the tool
 * forward an offset it got back without correcting it.
 *
 * A pattern this cannot model throws rather than being ignored. Silently
 * searching everything would let a tool that sends the wrong glob pass the very
 * tests written to catch it.
 */
const pruned = (exclude?: string[]): ((path: string) => boolean) => {
  const segments = (exclude ?? []).map((pattern) => {
    const segment = /^\*\*\/([A-Za-z0-9_.-]+)$/.exec(pattern)?.[1];
    if (!segment) throw new Error(`stub cannot model exclude: ${pattern}`);
    return segment;
  });
  return (path) => path.split("/").some((part) => segments.includes(part));
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
  workspace: () => Promise<ComputerClient>;
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
       * byte budget all need matches that look like matches. `limit`, `offset`
       * and `exclude` are honoured for the same reason `readFile` honours its
       * byte range: a stub that ignored them would let an unbounded, mis-paged or
       * unpruned search pass. See {@link pruned}.
       */
      grep: async (query: string, _path: string, options?: GrepOptions) => {
        greps.push({ query, path: _path, ...options });
        const context = options?.context ?? 0;
        const skip = pruned(options?.exclude);
        const out: Array<{
          path: string;
          line: number;
          text: string;
          context?: Array<{ line: number; text: string; isMatch: boolean }>;
        }> = [];
        for (const [file, content] of files) {
          if (skip(file)) continue;
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
          kill: async () => {},
          [Symbol.dispose]: () => {}
        };
      }
    },
    [Symbol.dispose]: () => {}
  } as unknown as ComputerClient;

  return {
    workspace: async () => client,
    execs,
    greps,
    files
  };
}

const config: ComputerToolsConfig = {};

const run = (tools: ToolSet, name: string, input: unknown) =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(
    input,
    {}
  );

/** One `exec` part, as Computer's tool yields it. */
type ExecPart = Record<string, unknown>;

/**
 * `exec`, drained to the part the model is handed.
 *
 * Computer's executor is an async generator: it yields a snapshot while the
 * command runs and a final part when it settles, so the last one is the answer.
 */
const execWith = async (
  tools: ToolSet,
  input: unknown,
  abortSignal?: AbortSignal
): Promise<ExecPart> => {
  const produced = (
    tools.exec!.execute as (
      i: unknown,
      o: unknown
    ) => AsyncIterable<ExecPart> | Promise<ExecPart>
  )(input, abortSignal ? { abortSignal } : {});
  if (Symbol.asyncIterator in produced) {
    let last: ExecPart = {};
    for await (const part of produced) last = part;
    return last;
  }
  return produced;
};

/** `exec` with no signal, which is how most of these call it. */
const exec = (tools: ToolSet, input: unknown) => execWith(tools, input);

/**
 * Everything one part says, for an assertion that does not care which field it
 * came back in. A command's own output is `stdout`/`stderr`; a refusal and a
 * failure are `error`.
 */
const execText = (part: ExecPart) =>
  [part.stdout, part.stderr, part.error]
    .filter((value) => typeof value === "string")
    .join("\n");

/**
 * What `exec` claims for itself, which is Computer's to say rather than this
 * plugin's.
 *
 * The description is generated from the backends and the output limits, so it
 * carries neither of the two guarantees a configured shell adds — the
 * interleaved transcript and first-failure reporting — and it promises a saved
 * file this workspace does not write. The plugin's own context block is where
 * the model is told what the description cannot say; the last case here holds
 * those two apart.
 */
describe("what exec claims for itself", () => {
  const descriptionOf = (shell?: string) =>
    buildComputerTools(stub().workspace, { ...config, shell }).exec!
      .description!;

  it("describes the one backend, so the model never names one", async () => {
    const tools = buildComputerTools(stub().workspace, config);
    expect(descriptionOf()).toContain("Linux container");
    // One backend and no choice to make: the schema is the command and a cwd.
    const schema = JSON.stringify(tools.exec!.inputSchema);
    expect(schema).toContain("command");
    expect(schema).not.toContain("backend");
  });

  it("is the same description with a shell and without, because it is upstream's", () => {
    expect(descriptionOf("bash")).toBe(descriptionOf(undefined));
  });

  /**
   * The costs of taking the tool as it comes, each stated where a reader will
   * meet it. The promise of a saved path is upstream's and cannot be turned
   * off; the reply never names one, which is why the context block tells the
   * model what truncation actually does.
   */
  it("promises a saved output file that this workspace does not write", async () => {
    expect(descriptionOf()).toContain("saved to a file");

    const tools = buildComputerTools(stub().workspace, config);
    const part = await exec(tools, { command: "npm test" });
    expect(execText(part)).not.toContain("Full output:");

    const [block] = computer(config).context!;
    const context = String(await block.provider!.get());
    expect(context).toContain("cut to its last lines");
    expect(context).toContain("Do not pipe into `head` or `tail`");
  });
});

describe("the dependency tree", () => {
  const dep = "/workspace/repo/node_modules/zod/index.ts";

  /**
   * Installed output, not source: each file tool refuses it and names `bash`,
   * which reaches it. The workspace's own methods refuse it too — see
   * `./proxy.spec.ts`.
   */
  it("refuses it in every file tool, routing to exec", async () => {
    const { workspace, files } = stub({ [dep]: "export const z = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    for (const [name, input] of [
      ["edit", { path: dep, old_string: "z", new_string: "y" }],
      ["grep", { query: "z", path: "/workspace/repo/node_modules" }]
    ] as const) {
      expect(await run(tools, name, input)).toContain("exec");
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
    const parent = buildComputerTools(workspace, config, undefined, scope);
    const child = buildComputerTools(workspace, config, undefined, scope);

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

  /** Why it clamps: {@link file://./tools-grep.ts MAX_CONTEXT_LINES}. */
  it("clamps a context over the ceiling rather than refusing it", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);
    const schema = tools.grep!.inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };

    expect(schema.safeParse({ query: "const", context: 50 }).success).toBe(
      true
    );
    const out = await run(tools, "grep", { query: "const", context: 50 });
    expect(greps[0]?.context).toBe(10);
    expect(out).toContain("50 was clamped to 10");
  });

  it("says nothing of the ceiling for a context within it", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "grep", { query: "const", context: 10 });
    expect(greps[0]?.context).toBe(10);
    expect(out).not.toContain("at most");
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
 * Skipped directories are pruned by the store, not filtered out here.
 *
 * Filtering on this side had to page blind: it asked for a page, dropped what
 * was skipped, and could not tell a genuinely short page from one the skips had
 * emptied — so it searched again, and still gave up while `node_modules`
 * crowded the result. Pruning answers both. The walk never descends into either
 * directory, and because nothing is dropped after paging, `offset` counts only
 * matches the model can be shown, which is what makes a reported offset one the
 * store understands.
 *
 * The stub prunes the way the store documents it — {@link pruned}.
 */
describe("grep pruning", () => {
  const src = "/workspace/repo/src/a.ts";

  it("asks the store to prune, in one search rather than two", async () => {
    const { workspace, greps } = stub({ [src]: "const marker = 1;\n" });

    const out = await run(buildComputerTools(workspace, config), "grep", {
      query: "marker"
    });

    expect(greps[0]?.exclude).toEqual(["**/.git", "**/node_modules"]);
    // The point of the retirement: one round trip. A filter here needed a second
    // to refill a page its own skips had emptied, and a retry re-scanned every
    // file the first round had already read.
    expect(greps).toHaveLength(1);
    expect(out).toContain("const marker = 1;");
  });

  it("keeps every skipped directory out of the results", async () => {
    const { workspace } = stub({
      "/workspace/repo/node_modules/zod/index.ts": "const marker = 1;\n",
      "/workspace/repo/.git/COMMIT_EDITMSG": "const marker = 2;\n",
      [src]: "const marker = 3;\n"
    });

    const out = await run(buildComputerTools(workspace, config), "grep", {
      query: "marker"
    });

    expect(out).toContain(src);
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("COMMIT_EDITMSG");
  });

  /**
   * A glob of `**\/node_modules` matches a path *segment*, so the directories
   * whose names merely contain one stay searchable. Asserted through the tool
   * because the matching is the store's now, and the only thing this package
   * still decides is the shape of the pattern it sends.
   */
  it("prunes a whole segment, sparing the names that merely contain it", async () => {
    const { workspace } = stub({
      "/workspace/repo/src/node_modules_old/a.ts": "const marker = 1;\n",
      "/workspace/repo/src/my_node_modules.ts": "const marker = 2;\n",
      "/workspace/repo/node_modules/zod/index.ts": "const marker = 3;\n"
    });

    const out = await run(buildComputerTools(workspace, config), "grep", {
      query: "marker"
    });

    expect(out).toContain("node_modules_old/a.ts");
    expect(out).toContain("my_node_modules.ts");
    expect(out).not.toContain("/node_modules/zod");
  });

  /**
   * Paging a pruned search end to end shows every visible match exactly once,
   * because `offset` counts only the matches that survive the prune.
   *
   * The skipped files are seeded *first*, so they hold the low source offsets,
   * which is what makes the assertion discriminating: a tool that paged before
   * pruning would spend its offsets on them and lose real matches off the front
   * of page two.
   */
  it("pages to the end without repeating or losing a match", async () => {
    const seed: Record<string, string> = {
      "/workspace/repo/node_modules/zod/index.ts": "const marker = 0;\n",
      "/workspace/repo/.git/COMMIT_EDITMSG": "const marker = 0;\n"
    };
    for (const n of [1, 2, 3, 4])
      seed[`/workspace/repo/src/a${n}.ts`] = `const marker = ${n};\n`;

    const { workspace, greps } = stub(seed);
    // A budget that fits some matches but not all, so a page has to report where
    // to resume.
    const tools = buildComputerTools(workspace, {
      ...config,
      maxOutputChars: 120
    });

    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const out = await run(tools, "grep", { query: "marker", offset });
      seen.push(...[...out.matchAll(/\/src\/(a\d)\.ts/g)].map((m) => m[1]!));
      pages += 1;
      const next = /`offset: (\d+)`/.exec(out);
      if (!next) break;
      offset = Number(next[1]);
      // A page that advertised an offset it had already reached would loop here.
      expect(pages).toBeLessThan(6);
    }

    expect(seen).toEqual(["a1", "a2", "a3", "a4"]);
    // Otherwise the budget fit everything and the paging was never exercised.
    expect(pages).toBeGreaterThan(1);
    // Every page asked the store to prune, not just the first.
    for (const call of greps)
      expect(call.exclude).toEqual(["**/.git", "**/node_modules"]);
  });
});

/**
 * `.git` is off limits, and the reason differs from `node_modules`.
 *
 * `node_modules` is installed output. `.git` is present, readable, and refused
 * anyway — policy, because a model that edits `.git/HEAD` or
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
  it("never offers exec as a way to reach git", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const refusal = await run(tools, "grep", {
      query: "x",
      path: "/workspace/repo/.git"
    });
    expect(refusal).not.toContain("exec");

    const [block] = computer(config).context!;
    const context = String(await block.provider!.get());
    const gitLine = context
      .split("\n")
      .find((line) => line.includes("`.git`"))!;
    expect(gitLine).toBeDefined();
    expect(gitLine).not.toContain("exec");
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

  /** `exec` is unguarded: `./paths.ts` says why. */
  it("does not guard exec, which runs git", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, config);
    // The tool refuses…
    expect(
      await run(tools, "grep", { query: "x", path: "/workspace/repo/.git" })
    ).toContain("repo_diff");
    // …while the shell path stays open.
    await exec(tools, { command: "git rev-parse --git-dir" });
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

describe("exec", () => {
  it("passes the configured cwd and timeout, and lets the model override cwd", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, {
      ...config,
      cwd: "/workspace",
      timeoutMs: 1234
    });

    await exec(tools, { command: "npm test" });
    await exec(tools, { command: "ls", cwd: "/workspace/repo" });

    expect(execs[0]).toMatchObject({
      command: "npm test",
      options: { cwd: "/workspace", timeoutMs: 1234, encoding: "utf8" }
    });
    expect(execs[1]!.options).toMatchObject({ cwd: "/workspace/repo" });
  });

  /** The shell writes for a model, so it wants the transcript — see `./shell.ts`. */
  it("sends a transcript", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, { ...config, shell: "bash" });

    await exec(tools, { command: "npm run check" });

    expect(execs[0]!.command).toContain("bash -o pipefail -c ");
    expect(execs[0]!.command.endsWith(" 2>&1")).toBe(true);
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

    await exec(tools, { command: "printenv" });

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

    await exec(tools, { command: "printenv" });

    expect(reads).toBe(1);
  });

  it("reports an exec failure as one", async () => {
    const { workspace } = stub({}, "container unreachable");
    const tools = buildComputerTools(workspace, config);

    const part = await exec(tools, { command: "npm test" });
    // Upstream's failure member: no exit code, and the reason as `error`.
    expect(part).not.toHaveProperty("exitCode");
    expect(execText(part)).toContain("container unreachable");
  });

  /**
   * The result the model reads is Computer's, and nothing here reshapes it.
   * Asserted on the whole part rather than on a rendered string, because the
   * shape is the thing this release changed.
   */
  it("hands back Computer's own result, not a rendered transcript", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const part = await exec(tools, { command: "npm test" });
    expect(part).toMatchObject({
      command: "npm test",
      backend: "container",
      exitCode: 0,
      stdout: "ok"
    });
    // The verdict line and the labelled stderr block were this plugin's.
    expect(execText(part)).not.toContain("--- exit 0 ---");
    expect(execText(part)).not.toContain("--- stderr ---");
  });
});

describe("the advisory gate on exec", () => {
  const gated = (
    advisories: SandboxAdvisory[],
    extra: Partial<ComputerToolsConfig> = {}
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
    expect(await exec(tools, { command: "npm test" })).toMatchObject({
      exitCode: 0,
      stdout: "ok"
    });
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

    const out = execText(await exec(tools, { command: "npm test" }));
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

    const out = execText(await exec(tools, { command: "npm test" }));
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

    await exec(tools, { command: "npm ci --force" });
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

    const out = execText(await exec(tools, { command: "cat README.md" }));
    expect(out).not.toContain("ERESOLVE");
    expect(execs).toHaveLength(1);
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

    const out = execText(await exec(tools, { command: "npm test" }));
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
    const out = execText(await exec(tools, { command: "npm test" }));
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
    await expect(exec(tools, { command: "npm test" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok"
    });
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
  const sandboxed = computerWorkspace({
    binding: {
      getByName: () => ({})
    } as unknown as DurableObjectNamespace<SandboxComputerHost>,
    sandboxName: () => "caller|owner/repo"
  });

  it("offers its tools under Think's names, so they replace the built-ins", () => {
    const tools = computer(config).tools!(onWorkspace(sandboxed));
    // Think's `find` and `list` stay Think's, walking the workspace.
    expect(Object.keys(tools).sort()).toEqual(["edit", "exec", "grep"]);
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
    expect(() => assembled.check(onWorkspace(sandboxed))).not.toThrow();
  });

  it("tells the model about its tools in a block the model cannot rewrite", async () => {
    const [block] = computer(config).context!;
    expect(block.provider && "set" in block.provider).toBe(false);
    expect(await block.provider!.get()).toContain("`exec`");
  });
});

/**
 * Cancellation, and what survives it now the tool is Computer's.
 *
 * Upstream kills the command when the call's signal fires, which is the part
 * that matters: a container otherwise goes on running a command nobody is
 * waiting for. What it has nowhere to say is *why* the call ended, so a command
 * stopped at the time limit, one whose call was cancelled and one that simply
 * failed all read alike to the model. The difference survives only in the log
 * line {@link file://./tools-exec.ts} writes.
 */
describe("a cancelled command", () => {
  function hungContainer() {
    const kills: Array<string | undefined> = [];
    const execs: string[] = [];
    const client = {
      runtime: {
        exec: async (command: string) => {
          execs.push(command);
          let signalled: (() => void) | undefined;
          // Settles when it is killed, as a signalled process does. A stub that
          // never settled would hang the call rather than end it, which is the
          // sequencing this tool now has: the result is awaited after the kill.
          const ended = new Promise<void>((resolve) => {
            signalled = resolve;
          });
          return {
            result: async () => {
              await ended;
              return {
                exitCode: 143,
                stdout: "",
                stderr: "",
                status: "cancelled" as const
              };
            },
            kill: async (signal?: string) => {
              kills.push(signal);
              signalled?.();
            },
            [Symbol.dispose]: () => {}
          };
        }
      },
      [Symbol.dispose]: () => {}
    } as unknown as ComputerClient;
    return { workspace: async () => client, kills, execs };
  }

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
    const part = await pending;

    // Disposing the handle only detaches this side. Without the kill the command
    // goes on running in the container after the call has given up on it.
    expect(kills).toHaveLength(1);
    // And the call ends on the killed command's own result, not on a sentence
    // of this plugin's.
    expect(part).toMatchObject({ exitCode: 143 });
  });

  /**
   * The cost of taking the tool as it comes, pinned so it cannot be mistaken
   * for an oversight: the result has somewhere for an exit code and somewhere
   * for an error, and nowhere for the reason the command stopped.
   */
  it("says nothing about why it stopped", async () => {
    const { workspace } = hungContainer();
    const controller = new AbortController();
    const pending = execWith(
      buildComputerTools(workspace, config),
      { command: "npm test" },
      controller.signal
    );

    await started();
    controller.abort(new DOMException("tool deadline", "TimeoutError"));
    const part = await pending;

    expect(part).not.toHaveProperty("status");
    const text = execText(part);
    expect(text).not.toContain("cancelled");
    expect(text).not.toContain("time limit");
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
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops waiting on an advisory read that never answers, without running the command", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 60_000 },
      () => new Promise<readonly SandboxAdvisory[]>(() => {})
    );
    const controller = new AbortController();

    const pending = execWith(tools, { command: "npm test" }, controller.signal);
    await tick();
    controller.abort();

    // Failing the gate open on a cancel would run the very command given up on.
    expect(execText(await pending)).toContain("cancelled");
    expect(execs).toHaveLength(0);
  });

  it("disposes a workspace that opens only after the call gave up", async () => {
    let arrive: ((client: ComputerClient) => void) | undefined;
    const tools = buildComputerTools(
      () =>
        new Promise<ComputerClient>((resolve) => {
          arrive = resolve;
        }),
      config
    );
    const controller = new AbortController();

    const pending = execWith(tools, { command: "npm test" }, controller.signal);
    await tick();
    controller.abort();

    let disposed = false;
    arrive?.({
      [Symbol.dispose]: () => {
        disposed = true;
      }
    } as unknown as ComputerClient);

    // The call is waiting on the workspace, not on the signal, so it ends only
    // once one turns up — and whatever it then fails on, nobody is left holding
    // the client.
    expect(execText(await pending)).not.toBe("");
    expect(disposed).toBe(true);
  });

  it("kills a process whose handle arrives only after the call gave up", async () => {
    let start: ((handle: unknown) => void) | undefined;
    let disposed = false;
    const client = {
      runtime: {
        exec: () =>
          new Promise((resolve) => {
            start = resolve;
          })
      },
      [Symbol.dispose]: () => {
        disposed = true;
      }
    } as unknown as ComputerClient;
    const tools = buildComputerTools(async () => client, config);
    const controller = new AbortController();

    const pending = execWith(tools, { command: "npm test" }, controller.signal);
    await tick();
    controller.abort();

    const kills: Array<string | undefined> = [];
    let signalled: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      signalled = resolve;
    });
    start?.({
      result: async () => {
        await ended;
        return { exitCode: 143, stdout: "", stderr: "" };
      },
      kill: async (signal?: string) => {
        kills.push(signal);
        signalled?.();
      },
      [Symbol.dispose]: () => {}
    });

    // Upstream reads the signal once the handle is in hand, so a process that
    // started while the call was being abandoned is still stopped, and the
    // client it came from is released with it.
    expect(await pending).toMatchObject({ exitCode: 143 });
    expect(kills).toHaveLength(1);
    expect(disposed).toBe(true);
  });
});
