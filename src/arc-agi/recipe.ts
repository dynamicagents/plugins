import { z } from "zod";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@dynamicagents/core";
import { ARC_GAME_SOUL } from "./soul.js";
import { ARC_CAPABILITY, arcDelegationGuidance } from "./main-agent.js";

/** Semantic Subtask type the decomposer emits for a "play this game" request. */
export const ARC_GAME_TYPE = "arc-game";

/**
 * Recipe for playing an ARC-AGI-3 game. Names no model, so it runs on whatever
 * pair its host agent is configured with; what distinguishes it is its tool
 * family, its soul, its context discipline, and
 * a turn budget twice the baseline — a play is a long sequence of cheap decisions,
 * and 20 turns bought roughly ten game actions once inspection was paid for.
 *
 * **Budget the turns, never the chunks.** A turn here is a reasoning model plus
 * an ARC HTTP round trip, nothing like the sub-ten-second turn a chunk count is
 * implicitly sized against: 1,000 turns sliced 25 to a chunk is 40 chunks on
 * paper and 70-100 in a real run, which blows the per-branch cap and *fails* a
 * play after hours rather than asking it to report. Time and turns are both
 * enforced directly, and a play ends through the graceful summary — a terminal
 * report with the metrics footer.
 *
 * - `historyWindow` bounds context, and it is the model's *only* memory: with no
 *   workspace tools (see below) a plan that scrolls out of it is gone. Note it
 *   counts *assistant messages* — one per tool call, not one per game action —
 *   so a play spends it several times faster than the number suggests.
 * - `reportMetrics` appends the turns/model-calls/wall-clock footer the user
 *   asked to see.
 *
 * Tool family: `arc-game` alone (act/inspect against the ARC REST API, session
 * state kept in the workspace), code-validated by
 * `validateRecipe`/`buildRecipeTools`.
 *
 * **No `workspace` family, despite the small history window.** Across two logged
 * plays `ws_read` was never called and the three `ws_write` calls were a
 * scratchpad for arithmetic — a note costing a turn apiece, which `arc_act`'s
 * `note` field carries for free and keeps in the model's own history. The
 * session file is unaffected: the family reaches the workspace through the
 * `ToolFamilyContext` core hands it, not through tools the model can see.
 */
export const ARC_GAME_RECIPE: ResolvedRecipe = {
  key: ARC_GAME_TYPE,
  version: 1,
  // A recipe states no model, and `ResolvedRecipe` has no field to state one
  // with. Every recipe runs on the agent's own configured pair, which
  // `validateRecipe` stamps onto the `ValidatedRecipe` a runner consumes.
  soul: ARC_GAME_SOUL,
  toolFamilies: ["arc-game"],
  enabled: true,
  // Twice the baseline turns, and the largest number that keeps
  // `MAX_CHUNKS_PER_BRANCH` unreachable: a yielding chunk always advanced at least
  // one turn, so a run takes at most `maxTurns` chunks and the cap is 40. Asserted
  // in `test/agent/subtasks/subtask-types.spec.ts` — raising this past 39 is a
  // platform change, not a recipe one.
  //
  // `maxWallMs` deliberately stays at the 30-minute baseline. Measured turns run
  // ~15s but reach 165s, so time may well end a play before turn 39 does; both
  // ceilings end it the same way, through the graceful summary, so the cost of
  // guessing wrong here is a shorter play rather than lost work.
  limits: { maxTurns: 39 },
  // Counts assistant messages (tool calls), so an inspect + act cycle spends two
  // or three of these per game action; 12 left the model unable to see more than a
  // couple of moves back, which it answered by re-inspecting.
  //
  // Lowered from 32 because `elideToolOutputs` changed what a slot *costs*, not
  // how many there are: a turn that has aged past the detail window now carries
  // its reasoning and its `note` but not the board render that was nearly all of
  // its tokens. 32 was the compensation for losing the workspace tools, and the
  // thing it was compensating for — reach — is unaffected by the elision.
  historyWindow: 24,
  reportMetrics: true
};

/**
 * The arc-game type. Its one param is an id the model quotes back from a tool
 * result it already saw, so the contract is checkable before anything runs: a
 * play with no game cannot succeed, and refusing it here costs no model call.
 *
 * There is deliberately no `card_id`. Which scorecard a play runs on is not a
 * choice — the API auto-closes an idle card, so the live card is whichever one
 * was used recently — and the parent leases it per chunk (see
 * {@link file://./scorecard.ts}), handing it to the execution as runtime state.
 */
export const ARC_GAME_SPEC: SubtaskTypeSpec = {
  key: ARC_GAME_TYPE,
  description: "Play one ARC-AGI-3 game.",
  params: z.object({
    game_id: z.string().min(1).describe("An exact game id from arc_list_games")
  }),
  paramsHelp: "requires param `game_id` (an exact id from `arc_list_games`)",
  // Everything the main agent is told about ARC is declared here, never written
  // inside a runtime — see {@link file://./main-agent.ts}. Both blocks live on
  // the *type* rather than on the plugin, because a plugin that declares a
  // subtask type has two places it could put a capability block and they are
  // rendered by different call sites: setting both makes the main agent read the
  // same advice twice per round, which is the exact drift these fields ended.
  capability: ARC_CAPABILITY,
  delegationGuidance: arcDelegationGuidance,
  recipe: ARC_GAME_RECIPE
};
