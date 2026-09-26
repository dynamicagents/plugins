import type { SubAgentSpec } from "@dynamicagents/core";
import { z } from "zod";

/**
 * The two Claude Code sub-agents, as data: what the parent's model is offered.
 * The host binds each to a `SubAgent` class whose model is
 * {@link file://./model.ts claudeCodeModel}, and adds the `prepare` and
 * `settle` that claim and release its workspace.
 *
 * A module of its own for its `zod` schemas. `zod` costs a Worker bundle
 * ~460 KiB, and the workspace Durable Object imports this subpath for its
 * egress gateway alone; with `sideEffects: false`, a module nothing it uses
 * reaches is dropped from that bundle whole.
 *
 * Both run **detached**: a session runs for up to its `timeoutMs`, past the
 * point a parent's turn is cut.
 */

/**
 * The writer's input: the task, and optionally the branch to add to.
 *
 * *Which* repository is not the parent model's to choose: the workspace is one
 * Durable Object, one container and one checkout, keyed by caller and
 * repository, and the parent already tracks which one is active. A repository
 * named here would let a model name somebody else's — the same reasoning that
 * keeps the workspace name out of model input in `/computer`.
 *
 * A branch is different: the model quotes it from an earlier report or a pull
 * request, and the host's `prepare` resolves it before anything runs.
 */
const WRITE_INPUT = z.object({
  task: z
    .string()
    .describe(
      "The change to make, described as you would to an engineer: what should be true when it is done, and how to tell"
    ),
  continue: z
    .string()
    .optional()
    .describe(
      "The branch to add to — one an earlier claude_code report named, or an open pull request's head branch; omit to start a new branch"
    )
});

/** The reader's input. No branch: its copy is deleted when it ends. */
const READ_INPUT = z.object({
  task: z
    .string()
    .describe(
      "The question to answer or the plan to work out, and what you will do with the findings"
    )
});

export type ClaudeCodeInput = z.infer<typeof WRITE_INPUT>;
export type ClaudeCodeReadInput = z.infer<typeof READ_INPUT>;

/**
 * Nothing reads it: the model is the CLI, whose system prompt is its own. It
 * exists because a spec must declare a soul, and says so, so nobody tunes it.
 */
const SOUL =
  "Not a prompt: this sub-agent's model is a Claude Code session, which brings its own.";

/**
 * Sized deliberately. An invocation carries an 18.7-27k token cached prefix
 * before it does anything — a ten-call burst billed twenty raw input tokens
 * against 187,130 cache reads — so a session has to be worth starting. The
 * description says that in the terms the parent's model can act on: one
 * coherent change, not one file edit.
 */
export const CLAUDE_CODE_AGENT: SubAgentSpec<ClaudeCodeInput> = {
  name: "claude_code",
  description: [
    "Hand a coding task to a Claude Code session running in your workspace",
    "container, in whatever you have open there — a repository you checked out,",
    "or a scratchpad. It has its own tools — it reads, edits, runs the test suite",
    "and iterates — and it reports back what it did. It runs in the background:",
    "the call returns at once, and its report arrives in a later turn.",
    "",
    "Give it **one coherent change**, described the way you would describe it to",
    "an engineer: what should be true when it is done, and how to tell. It is",
    "expensive to start and cheap to let run, so 'add the endpoint, its tests and",
    "wire it up' is one session, not three. A session that is only asked to edit",
    "a single line costs about what a substantial one costs.",
    "",
    "It cannot ask you anything mid-run. Anything it would need to ask, decide",
    "first — or ask the user yourself before delegating.",
    "",
    "To correct or extend work that is already on a branch — the one a previous",
    "session's report named, or an open pull request's head branch — set",
    "`continue` to that branch: the new session starts from its tip and adds",
    "commits to it, so pushing the branch updates its pull request. Without it, a",
    "session starts a branch of its own, and changing an open pull request from",
    "there means moving commits between branches."
  ].join("\n"),
  inputSchema: WRITE_INPUT,
  soul: SOUL,
  detached: true,
  formatInput: (input) => input.task
};

/**
 * The same CLI, in the parent's container, in a throwaway copy of its checkout
 * — see {@link file://./copy.ts}. Two sub-agents rather than an input flag,
 * because the difference is not a setting a model should pick: it decides
 * whether the run needs a container of its own, and a model choosing that would
 * be choosing what the turn costs.
 *
 * The one thing the description must land is that the answer comes back as
 * *findings*: the session's edits are discarded, so a change delegated here is
 * a change that never happens, reported as though it did.
 */
export const CLAUDE_CODE_READER_AGENT: SubAgentSpec<ClaudeCodeReadInput> = {
  name: "claude_code_read",
  description: [
    "Hand a question about the code — or a plan to work out — to a Claude Code",
    "session running in your workspace container. It works in a throwaway copy of",
    "your checkout, so it can run anything a question needs: the test suite, a",
    "build, `npm outdated`, a registry query. **Nothing it changes reaches your",
    "checkout** — the copy is deleted when it ends, so asking it to make an edit",
    "wastes the whole session. What comes back is its report, in a later turn.",
    "",
    "Use it for what you would otherwise have to find out yourself: how something",
    "is wired, where a behaviour comes from, whether an approach fits the",
    "codebase, how a change should be made before anyone makes it. Ask for the",
    "findings you need, and say what you will do with them — a question with a",
    "purpose comes back usefully specific.",
    "",
    "These are cheap enough to run several at once against independent",
    "questions, and each still costs a session's startup — so one question per",
    "session, not one file per session.",
    "",
    "It cannot ask you anything mid-run."
  ].join("\n"),
  inputSchema: READ_INPUT,
  soul: SOUL,
  detached: true,
  formatInput: (input) => input.task
};
