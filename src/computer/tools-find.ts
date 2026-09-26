import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { guardPath, isSkipped, skipNames, WALK_SKIPS } from "./paths.js";
import { humanBytes, packBlocks, renderGrepMatches } from "./render.js";
import { collectVisible, listingNote } from "./read.js";
import type { ComputerContext } from "./context.js";

/**
 * Finding things: what is in a directory, where a file is, what a file
 * contains. Under Think's names, so they replace its built-ins — whose `find`
 * and `grep` walk every file under the root through the workspace.
 */

/**
 * How many directory entries one `list` or `find` returns.
 *
 * A bound on the *listing*, not on the rendered text — `maxOutputChars` still
 * applies on top, and the order matters. Bounding only the text means `readdir`
 * returns every entry and the isolate holds all of them before the ceiling
 * discards the tail; a dependency tree is 22,470 files, and a misbehaving build
 * is exactly when someone lists one. `readdir` takes a `limit`, so the bound is
 * applied where the entries are read.
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * How many matches one `grep` returns.
 *
 * Bounded at the source like {@link DEFAULT_MAX_ENTRIES}, and for a sharper reason
 * than a listing: without a `limit`, `fs.grep` reads *every* file under the path
 * looking for more. `.git` and the dependency tree are both in the workspace, so
 * an unbounded search of `/workspace` streams every loose object and every
 * vendored file through the isolate before answering. The limit is what stops
 * that walk early, and the skip list is what keeps the matches worth reading.
 */
const DEFAULT_MAX_MATCHES = 200;

export function findTools(ctx: ComputerContext): ToolSet {
  const { cwd, maxChars, inWorkspace } = ctx;

  return {
    list: tool({
      description:
        "List one level of a workspace directory: directories with a trailing slash, files with their size — check that before reading a large one. " +
        "A cut listing reports the `offset` that continues it. To search a subtree, use find.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(`Absolute directory path (default: ${cwd})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Entries to skip — use the offset a cut listing reports")
      }),
      execute: async ({ path, offset }) => {
        const target = path ?? cwd;
        const refusal = guardPath(target, "list");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace("listing", target, async (fs) => {
          // One over the ceiling: enough to know the listing was cut without a
          // second round trip to find out, and the extra entry is not shown.
          // Unfiltered on purpose — one line naming a directory that is really
          // there is honest, and costs a line rather than a page. It is the
          // *subtree* walk in `find` that cannot afford to descend into them.
          const entries = await fs.readdir(target, {
            limit: DEFAULT_MAX_ENTRIES + 1,
            offset: from
          });
          if (entries.length === 0)
            return from > 0
              ? `(no entries in ${target} past offset ${from})`
              : `(${target} is empty)`;
          const blocks = entries
            .slice(0, DEFAULT_MAX_ENTRIES)
            .map((e) => [
              e.isDirectory ? `${e.name}/` : `${e.name}\t${humanBytes(e.size)}`
            ]);
          const { body, shown } = packBlocks(blocks, maxChars);
          const more = entries.length > shown;
          return (
            body +
            (more
              ? `\n… showed ${shown} entries; there are more. Continue with \`offset: ${from + shown}\`, or search with find.`
              : "")
          );
        });
      }
    }),

    find: tool({
      description:
        "Find files and directories under a workspace directory, by glob. `pattern` is matched against paths relative to `path`: `*` stays within one path segment, `**/` crosses directories, `?` matches one character. So `*.ts` finds top-level TypeScript files and `**/*.ts` finds them at any depth; without `pattern` the whole subtree is listed. " +
        "A cut listing reports the `offset` that continues it. `.git` and `node_modules` are left out.",
      inputSchema: z.object({
        pattern: z
          .string()
          .optional()
          .describe("Glob relative to path, e.g. '**/*.spec.ts'"),
        path: z
          .string()
          .optional()
          .describe(`Absolute directory to search from (default: ${cwd})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Entries to skip — use the offset a cut listing reports")
      }),
      execute: async ({ pattern, path, offset }) => {
        const target = path ?? cwd;
        const refusal = guardPath(target, "find");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace("searching", target, async (fs) => {
          // Bounded at the source: the store walks only as far as the page, so
          // a listing that would be cut never reads the rest of the tree.
          // `.git` and `node_modules` are pruned by the store, not filtered
          // here: at a repo root either one outnumbers a page on its own.
          const entries = await fs.find(target, pattern, {
            limit: DEFAULT_MAX_ENTRIES + 1,
            offset: from,
            exclude: WALK_SKIPS.map((segment) => `**/${segment}`)
          });
          if (entries.length === 0)
            return pattern
              ? `(nothing under ${target} matches ${pattern})`
              : `(${target} is empty)`;

          const blocks = entries
            .slice(0, DEFAULT_MAX_ENTRIES)
            .map((e) => [e.type === "dir" ? `${e.path}/` : e.path]);
          const { body, shown } = packBlocks(blocks, maxChars);
          const page = {
            rawIndex: entries.map((_, i) => from + i),
            rawEnd: from + entries.length,
            exhausted: entries.length <= DEFAULT_MAX_ENTRIES,
            crowded: false
          };
          return body + listingNote(page, shown, "entries", "`pattern`");
        });
      }
    }),

    /**
     * Search, without the container.
     *
     * The alternative is `bash("grep -rn …")`, and the case for a native one is
     * not that shelling out fails — it is where the search runs. `fs.grep` reads
     * the Durable Object's SQLite, so it answers while the container is being
     * replaced or an install is still running, which is exactly the window the
     * install gate leaves an agent with nothing to do. It is also why this tool
     * is not gated: see {@link file://./context.ts awaitAdvisories}.
     *
     * And not Think's `grep`, which globs every file under the root and reads
     * each one through the workspace.
     *
     * Two lesser reasons that still matter. The query arrives as a value rather
     * than through `shellQuote` and a shell that would re-parse it. And the result
     * is bounded by a `limit` at the source instead of being middle-truncated
     * afterwards, which for a match list means losing whole files silently.
     */
    grep: tool({
      description:
        "Search file contents across the workspace. Returns matching lines grouped by file, each with its line number. " +
        "The query is matched literally — set `regex` to interpret it as a regular expression. " +
        "Pass `include` to limit which files are searched, e.g. '**/*.ts' — without it every file under `path` is read, which is slower and rarely what you meant. " +
        "A cut result reports the `offset` that continues it. Use `context` to see the lines around a match. " +
        "Results from `.git` and `node_modules` are left out — search node_modules with bash.",
      inputSchema: z.object({
        query: z.string().describe("Text to find, e.g. 'buildComputerTools'"),
        path: z
          .string()
          .optional()
          .describe(`Absolute file or directory to search (default: ${cwd})`),
        include: z
          .string()
          .optional()
          .describe(
            "Glob relative to path limiting which files are searched, e.g. '**/*.ts'"
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Interpret query as a regular expression"),
        ignoreCase: z.boolean().optional().describe("Ignore letter case"),
        context: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe("Lines of surrounding context to include with each match"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Matches to skip — use the offset a cut result reports")
      }),
      execute: async ({
        query,
        path,
        include,
        regex,
        ignoreCase,
        context,
        offset
      }) => {
        const target = path ?? cwd;
        const refusal = guardPath(target, "grep");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace("searching", target, async (fs) => {
          // Two rounds, because a `grep` retry re-reads and re-scans every file
          // it already looked at. `.git` rarely floods a page here — its bulk is
          // compressed objects, which a text query does not match — where a
          // `node_modules` left in the workspace is source and matches.
          const skips = WALK_SKIPS;
          const page = await collectVisible(
            (at, limit) =>
              fs.grep(query, target, {
                include,
                regex,
                ignoreCase,
                context,
                limit,
                offset: at
              }),
            (m) => m.path,
            (p) => isSkipped(skips, p),
            DEFAULT_MAX_MATCHES,
            from,
            2
          );
          if (page.items.length === 0)
            return page.crowded
              ? `every match for ${JSON.stringify(query)} from offset ${from} is inside ${skipNames(skips)}, which ${skips.length > 1 ? "are" : "is"} not searched. Add \`include\` (e.g. '**/*.ts') to search the working tree instead, or use bash to search \`node_modules\`.`
              : `no matches for ${JSON.stringify(query)} in ${target}${
                  include ? ` (${include})` : ""
                }${from > 0 ? ` past offset ${from}` : ""}`;

          const { body, shown, capped } = renderGrepMatches(
            page.items.slice(0, DEFAULT_MAX_MATCHES),
            maxChars
          );
          return (
            body +
            listingNote(page, shown, "matches", "`include`") +
            (capped
              ? `\n(Some lines were shortened. Read one in full with \`read\`, passing its line number as \`offset\`.)`
              : "")
          );
        });
      }
    })
  };
}
