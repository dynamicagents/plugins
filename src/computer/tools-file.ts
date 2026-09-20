import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { guardPath } from "./paths.js";
import { withFileLock } from "./file-lock.js";
import { readBounded, readWindow } from "./read.js";
import type { ComputerContext } from "./context.js";

/** One file at a time: reading it, replacing it, editing it in place. */
export function fileTools(ctx: ComputerContext): ToolSet {
  const { maxChars, inWorkspace, refuseWrite, scope } = ctx;

  return {
    sb_read: tool({
      description:
        "Read a file from the workspace. Returns the file's text, or a note if it does not exist. " +
        "A large file comes back with its middle removed and a marker giving the `offset` that reaches the missing part. " +
        "Pass `offset` (and optionally `length`) to read a specific byte window instead — the result states the window it returned and how many bytes follow, so you can page through a file. Byte offsets, not lines: to see the lines around a match, use sb_grep with `context`. " +
        "Files under node_modules are not in the workspace — read them with sb_exec.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, e.g. '/workspace/repo/src/a.ts'"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Byte offset to start reading from"),
        length: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum bytes to return from `offset`")
      }),
      execute: async ({ path, offset, length }) => {
        const refusal = guardPath(path, "sb_read");
        if (refusal) return refusal;
        return inWorkspace("reading", path, async (fs) => {
          // Either knob means the model chose a region; only an unqualified read
          // gets the middle-out guess.
          return offset === undefined && length === undefined
            ? await readBounded(fs, path, maxChars)
            : await readWindow(
                fs,
                path,
                offset ?? 0,
                length ?? maxChars,
                maxChars
              );
        });
      }
    }),

    sb_write: tool({
      description:
        "Create or overwrite a file in the workspace. Parent directories are created for you. For a small change to a large file prefer sb_edit, which does not require sending the whole file back.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        content: z
          .string()
          .describe("Full file content (overwrites any existing file)")
      }),
      execute: async ({ path, content }) => {
        const refusal = guardPath(path, "sb_write");
        if (refusal) return refusal;
        // Before the write, not after: the point is to not report a success that
        // did not happen.
        const lost = await refuseWrite();
        if (lost) return lost;
        return inWorkspace("writing", path, (fs) =>
          withFileLock(scope(), path, async () => {
            const dir = path.slice(0, path.lastIndexOf("/"));
            if (dir) await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path, content);
            // Characters, not bytes. `String.length` counts UTF-16 code units — the
            // distinction `readBounded` documents at length — so calling them bytes
            // was simply wrong for anything outside ASCII. The exact byte count
            // would cost a `TextEncoder` pass over the whole content for a number
            // nobody does arithmetic with, and "characters" is already this module's
            // word for the same count in `truncateOutput`'s omission marker.
            const written = content.length;
            return `wrote ${path} (${written} character${written === 1 ? "" : "s"})`;
          })
        );
      }
    }),

    sb_edit: tool({
      description:
        "Replace an exact string in a file. The string must be non-empty and must appear exactly once — if it appears zero times or more than once the edit is refused, so include enough surrounding context to make it unique.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        find: z
          .string()
          // Empty is refused at the schema rather than in the body, because
          // `split("")` does not count empty-string occurrences: on a file of
          // one character it reports none, on a longer one it reports one per
          // character, and on an *empty* file it reports -1 — which slips past
          // both guards below and writes `replace` into the file as if an edit
          // had been found. A write tool must not write what nobody asked for.
          .min(1)
          .describe("Exact text to replace, unique within the file"),
        replace: z.string().describe("Replacement text")
      }),
      execute: async ({ path, find, replace }) => {
        const refusal = guardPath(path, "sb_edit");
        if (refusal) return refusal;
        const lost = await refuseWrite();
        if (lost) return lost;
        return inWorkspace("editing", path, (fs) =>
          withFileLock(scope(), path, async () => {
            const content = await fs.readFile(path, "utf8");
            const occurrences = content.split(find).length - 1;
            // Refusing an ambiguous edit is the whole value of this tool over
            // sb_write: a silent first-match replace corrupts the file in a way
            // that surfaces much later, usually as a confusing test failure.
            if (occurrences === 0) return `no match for that text in ${path}`;
            if (occurrences > 1)
              return `that text appears ${occurrences} times in ${path} — add surrounding context to make it unique`;
            // A replacer function, not the string itself. `String.replace`
            // interprets `$$`, `$&`, `` $` `` and `$'` in a *string* replacement
            // even when the pattern is a plain string, so the text written is not
            // the text the model sent: `echo $$` becomes `echo $`, and `$'` splices
            // in everything before the match. Those two are not exotic — `$$`
            // escapes a dollar in a Makefile and reads a PID in shell, and `$'…'`
            // is bash ANSI-C quoting. A function's return value is used verbatim.
            await fs.writeFile(
              path,
              content.replace(find, () => replace)
            );
            return `edited ${path}`;
          })
        );
      }
    })
  };
}
