import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { guardPath, WALK_SKIPS } from "./paths.js";
import { renderGrepMatches } from "./render.js";
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
 * the path looking for more, so an unbounded search of `/workspace` answers only
 * after streaming the whole tree through the isolate. The limit stops that walk
 * early; `exclude` keeps it out of `.git` and the dependency tree entirely.
 */
const DEFAULT_MAX_MATCHES = 200;

/**
 * The most `context` lines one `grep` shows around each match.
 *
 * Clamped rather than refused, since a refusal costs the model a step to retry.
 * The bound is {@link file://./render.ts packBlocks}: it ships the first match's
 * block whole, so a block has to stay well inside the output budget.
 */
const MAX_CONTEXT_LINES = 10;

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
          .optional()
          .describe(
            `Lines of surrounding context to include with each match, at most ${MAX_CONTEXT_LINES}`
          ),
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
        const around =
          context === undefined
            ? undefined
            : Math.min(context, MAX_CONTEXT_LINES);
        return inWorkspace("searching", target, async (fs) => {
          // Pruned in the store, not filtered here: an excluded directory is
          // never descended into, so `node_modules` costs nothing to skip and
          // `offset` counts only matches the model can actually be shown. A
          // filter on this side could not do either — it pages blind, so a
          // crowded page could hide every real match behind skipped ones.
          const matches = await fs.grep(query, target, {
            include,
            regex,
            ignoreCase,
            context: around,
            limit: DEFAULT_MAX_MATCHES + 1,
            offset: from,
            exclude: WALK_SKIPS.map((segment) => `**/${segment}`)
          });
          if (matches.length === 0)
            return `no matches for ${JSON.stringify(query)} in ${target}${
              include ? ` (${include})` : ""
            }${from > 0 ? ` past offset ${from}` : ""}`;

          const { body, shown, capped } = renderGrepMatches(
            matches.slice(0, DEFAULT_MAX_MATCHES),
            maxChars
          );
          return (
            body +
            // `shown` falls short of what came back either because the page was
            // capped or because the render budget ran out; both continue here.
            (shown < matches.length
              ? `\n\n… showed ${shown} matches; there are more. Continue with ` +
                `\`offset: ${from + shown}\`, or narrow with \`include\` — ` +
                `narrowing is cheaper, since an offset still walks everything ` +
                `it skips.`
              : "") +
            (capped
              ? `\n(Some lines were shortened. Read one in full with \`read\`, passing its line number as \`offset\`.)`
              : "") +
            (around !== context
              ? `\n(\`context\` is at most ${MAX_CONTEXT_LINES}, so ${context} was clamped to ${MAX_CONTEXT_LINES}. Read a wider region with \`read\`.)`
              : "")
          );
        });
      }
    })
  };
}
