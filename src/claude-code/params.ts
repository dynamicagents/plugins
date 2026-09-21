import { z } from "zod";

/**
 * The writing type's params, in a module of their own.
 *
 * `zod` costs a Worker bundle ~460 KiB, and the workspace Durable Object imports
 * this subpath for its egress gateway alone. A schema built at the top of
 * `./recipe.ts` would be a call in a module that object uses, so it would ship
 * there; here, in a module only the plugin factories reach, `sideEffects: false`
 * lets a bundler drop it wherever the factories are not used.
 *
 * Defaulted to `""` rather than optional, because core's params are strings; the
 * delegate tool still advertises it as optional.
 */
export const CLAUDE_CODE_PARAMS = z.object({
  continue: z
    .string()
    .default("")
    .describe(
      "The branch an earlier claude-code subtask's report named, to add to that work; omit to start a new branch"
    )
});
