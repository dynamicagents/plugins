import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { guardPath, isSkipped, skipNames, WALK_SKIPS } from "./paths.js";
import { renderGrepMatches } from "./render.js";
import { collectVisible, listingNote } from "./read.js";
import type { ComputerContext } from "./context.js";

/**
 * Searching file contents, under Think's name so it replaces Think's `grep` —
 * which lists every file under the root and reads each one through the
 * workspace, one round trip per file. Think's `find` and `list` stay Think's:
 * over `computerWorkspace` they walk with `.git` and `node_modules` pruned.
 */

/**
 * How many matches one `grep` returns.
 *
 * Bounded at the source: without a `limit`, `fs.grep` reads *every* file under
 * the path looking for more. `.git` and the dependency tree are both in the workspace, so
 * an unbounded search of `/workspace` streams every loose object and every
 * vendored file through the isolate before answering. The limit is what stops
 * that walk early, and the skip list is what keeps the matches worth reading.
 */
const DEFAULT_MAX_MATCHES = 200;

export function grepTools(ctx: ComputerContext): ToolSet {
  const { cwd, maxChars, inWorkspace } = ctx;

  return {
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
