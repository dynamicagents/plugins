import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { guardPath } from "./paths.js";
import { withFileLock } from "./file-lock.js";
import type { ComputerContext } from "./context.js";

/**
 * Editing a file in place — the one file tool this plugin keeps. Think's
 * `read`, `write` and `delete` reach the workspace through the agent's own
 * `this.workspace`, which is `computerWorkspace` (`./proxy.ts`).
 *
 * Not Think's `edit`, because that one is two calls through the workspace — a
 * `readFile`, then a `writeFile` — and a lock inside the workspace cannot span
 * the pair. See `./file-lock.ts`.
 */
export function fileTools(ctx: ComputerContext): ToolSet {
  const { inWorkspace, refuseWrite, scope } = ctx;

  return {
    edit: tool({
      description:
        "Replace an exact string in a file. old_string must be non-empty and must appear exactly once — if it appears zero times or more than once the edit is refused, so include enough surrounding context to make it unique. To create a file, use write.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        old_string: z
          .string()
          // Empty is refused at the schema rather than in the body, because
          // `split("")` does not count empty-string occurrences: on a file of
          // one character it reports none, on a longer one it reports one per
          // character, and on an *empty* file it reports -1 — which slips past
          // both guards below and writes `new_string` into the file as if an
          // edit had been found. A write tool must not write what nobody asked
          // for.
          .min(1)
          .describe("Exact text to replace, unique within the file"),
        new_string: z.string().describe("Replacement text")
      }),
      execute: async ({ path, old_string, new_string }) => {
        const refusal = guardPath(path, "edit");
        if (refusal) return refusal;
        const lost = await refuseWrite();
        if (lost) return lost;
        return inWorkspace("editing", path, (fs) =>
          withFileLock(scope(), path, async () => {
            const content = await fs.readFile(path, "utf8");
            const occurrences = content.split(old_string).length - 1;
            // Refusing an ambiguous edit is the whole value of this tool over
            // `write`: a silent first-match replace corrupts the file in a way
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
              content.replace(old_string, () => new_string)
            );
            return `edited ${path}`;
          })
        );
      }
    })
  };
}
