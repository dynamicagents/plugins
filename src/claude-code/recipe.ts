import type { ResolvedRecipe, SubtaskTypeSpec } from "@dynamicagents/core";
import { CLAUDE_CODE_PARAMS } from "./params.js";

/** The Subtask type a "make this change" request decomposes into. */
export const CLAUDE_CODE_TYPE = "claude-code";

/**
 * The Subtask type a "find out how this works" or "plan this" request decomposes
 * into.
 *
 * The same CLI, in the parent's container, in a throwaway copy of its checkout —
 * see {@link file://./copy.ts}. Two types rather than a param because the
 * difference is not a setting a model should pick: it decides whether the subtask
 * needs a container of its own, and a model choosing that would be choosing how
 * much the round costs.
 */
export const CLAUDE_CODE_READ_TYPE = "claude-code-read";

/**
 * The key this plugin writes the workspace name under, for the facet to read
 * back off `SubtaskRuntime`.
 *
 * **Deliberately a second declaration of `/computer`'s `WORKSPACE_RUNTIME_KEY`,
 * not an import of it.** Importing one string constant across the subpath
 * boundary would merge two realms `verify:exports` keeps apart, and pull the
 * whole computer plugin into the graph of every agent that installs this one.
 *
 * The two must stay equal, because a host that installs both on its subagent
 * gets them working off one runtime value — so `index.spec.ts` imports both and
 * asserts it, which is where a cross-realm import costs nothing.
 */
export const WORKSPACE_RUNTIME_KEY = "workspaceName";

/**
 * The recipe a Claude Code session runs under — and most of it is inert, which
 * is worth saying plainly rather than letting a reader assume otherwise.
 *
 * Every other recipe in this package configures core's resumable model/tool
 * loop: `soul` is the system prompt, `toolFamilies` names what the model may
 * call, `historyWindow` bounds its context. **None of that applies here.** The
 * host's subagent overrides `executeChunk` and never calls `runResumableChunk`
 * at all — the loop, the tools, the context management and the system prompt are
 * Claude Code's, inside the container.
 *
 * So the fields below exist because {@link ResolvedRecipe} requires them and
 * `validateRecipe` checks them on the parent, not because anything reads them at
 * runtime. They are set to the most honest values available:
 *
 * - `toolFamilies: []` — this plugin registers none. Claude Code brings its own
 *   tools and they are not core's to name.
 * - `soul` — required and never defaulted, so it says what this recipe *is*.
 *   Nothing sends it to a model.
 * - `limits.maxTurns` — the budget core would meter if it were driving. It is
 *   not, so what actually bounds a session is `timeoutMs`, enforced by the
 *   container runtime. Set to 1 to say so: one Dynamic Agents "turn" is one
 *   whole Claude Code session.
 */
export const CLAUDE_CODE_RECIPE: ResolvedRecipe = {
  key: CLAUDE_CODE_TYPE,
  version: 1,
  soul: [
    "This recipe does not drive a model loop.",
    "",
    "A subtask of this type runs the Claude Code CLI inside the agent's",
    "workspace container, against the durable working tree. The system prompt, the",
    "tool loop and the context management all belong to that process. Nothing",
    "reads this text — it exists because a recipe must declare a soul, and a",
    "placeholder that looked like a prompt would invite someone to tune it."
  ].join("\n"),
  toolFamilies: [],
  enabled: true,
  limits: { maxTurns: 1 },
  historyWindow: 1,
  reportMetrics: false
};

/**
 * What the main agent is told it can hand off.
 *
 * Sized deliberately. An invocation carries an 18.7-27k token cached prefix
 * before it does anything — a ten-call burst billed twenty raw input tokens
 * against 187,130 cache reads — so a session has to be worth starting. The
 * guidance says that in the terms the delegating model can act on: one coherent
 * change, not one file edit.
 */
export const CLAUDE_CODE_CAPABILITY = [
  "## Writing code",
  "",
  "You can hand a coding task to a Claude Code session running in your",
  "workspace container, in whatever you have open there — a repository you",
  "checked out, or a scratchpad. It has its own tools — it reads, edits, runs the",
  "test suite and iterates — and it reports back what it did.",
  "",
  "Give it **one coherent change**, described the way you would describe it to",
  "an engineer: what should be true when it is done, and how to tell. It is",
  "expensive to start and cheap to let run, so 'add the endpoint, its tests and",
  "wire it up' is one subtask, not three. A session that is only asked to edit",
  "a single line costs about what a substantial one costs.",
  "",
  "It cannot ask you anything mid-run. Anything it would need to ask, decide",
  "first — or ask the user yourself before delegating.",
  "",
  "To correct or extend work that is already on a branch — the one a previous",
  "session's report named, or an open pull request's head branch — delegate with",
  "param `continue` set to that branch: the new session starts from its tip and",
  "adds commits to it, so pushing the branch updates its pull request. Without it,",
  "a session starts a branch of its own, and changing an open pull request from",
  "there means moving commits between branches."
].join("\n");

/**
 * The reading recipe. Inert for the same reasons as {@link CLAUDE_CODE_RECIPE},
 * which carries the argument.
 *
 * A separate `key`, because a recipe key is what the execution fingerprint is
 * built from: sharing one would make a reading subtask and a writing subtask with
 * the same prompt look like the same work, and the second would be served the
 * first one's cached result.
 */
export const CLAUDE_CODE_READ_RECIPE: ResolvedRecipe = {
  ...CLAUDE_CODE_RECIPE,
  key: CLAUDE_CODE_READ_TYPE,
  soul: [
    "This recipe does not drive a model loop.",
    "",
    "A subtask of this type runs the Claude Code CLI inside the agent's",
    "workspace container, in a throwaway copy of the checkout. The system prompt,",
    "the tool loop and the context management all belong to that process. Nothing",
    "reads this text — it exists because a recipe must declare a soul, and a",
    "placeholder that looked like a prompt would invite someone to tune it."
  ].join("\n")
};

/**
 * What the main agent is told about reading, as against changing.
 *
 * The one thing it must land is that the answer comes back as *findings*: the
 * session's edits are discarded, so a change delegated here is a change that
 * never happens, reported as though it did.
 */
export const CLAUDE_CODE_READ_CAPABILITY = [
  "## Reading and planning",
  "",
  "You can hand a question about the code — or a plan to work out — to a Claude",
  "Code session running in your workspace container. It works in a throwaway copy",
  "of your checkout, so it can run anything a question needs: the test suite, a",
  "build, `npm outdated`, a registry query. **Nothing it changes reaches your",
  "checkout** — the copy is deleted when it ends, so asking it to make an edit",
  "wastes the whole session. What comes back is its report.",
  "",
  "Use it for what you would otherwise have to find out yourself: how something is",
  "wired, where a behaviour comes from, whether an approach fits the codebase, how",
  "a change should be made before anyone makes it. Ask for the findings you need,",
  "and say what you will do with them — a question with a purpose comes back",
  "usefully specific.",
  "",
  "These are cheap enough to run several at once against independent questions,",
  "and each still costs a session's startup — so one question per subtask, not",
  "one file per subtask.",
  "",
  "It cannot ask you anything mid-run."
].join("\n");

export const CLAUDE_CODE_READ_SPEC: SubtaskTypeSpec = {
  key: CLAUDE_CODE_READ_TYPE,
  description:
    "Investigate or plan against the checked-out code with a Claude Code session whose changes are discarded, and report findings.",
  /**
   * No params: the repository is not the model's to choose, for the reason
   * {@link CLAUDE_CODE_SPEC} gives, and a copy that is deleted has no branch.
   */
  params: null,
  capability: CLAUDE_CODE_READ_CAPABILITY,
  recipe: CLAUDE_CODE_READ_RECIPE
};

export const CLAUDE_CODE_SPEC: SubtaskTypeSpec = {
  key: CLAUDE_CODE_TYPE,
  description:
    "Run a coding task in the workspace with a Claude Code session — a checked-out repository, or a scratchpad.",
  /**
   * A branch, and nothing that names a workspace.
   *
   * *Which* repository is not the delegating model's to choose: the workspace is
   * one Durable Object, one container and one checkout, keyed by caller and
   * repository, and the parent already tracks which one is active. Letting a
   * model name a repository here would let it name somebody else's — the same
   * reasoning that keeps `workspaceName` out of model input in `/computer`.
   *
   * A branch is different: the model quotes it from an earlier report or a pull
   * request, and the host resolves it before anything runs — see
   * {@link file://./config.ts ClaudeCodeConfig.subtaskWorkspace}.
   *
   * The schema is in `./params.ts`, which says why it is a module of its own.
   */
  params: CLAUDE_CODE_PARAMS,
  paramsHelp:
    "optional param `continue` (a branch to keep working on: one an earlier claude-code report named, or an open pull request's head branch)",
  capability: CLAUDE_CODE_CAPABILITY,
  recipe: CLAUDE_CODE_RECIPE
};
