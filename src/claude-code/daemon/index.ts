/**
 * `@dynamicagents/plugins/claude-code/daemon` — Claude Code as a sandbox
 * daemon's CLI. Node-only, like the daemon it plugs into.
 *
 * The launch is this package's: permission mode, effort, model, a named JSON
 * schema, resume and fork, per turn from the run header. The parse is this package's too
 * (`../events.ts`), not the harness preset's, because a transcript card reads
 * a tool's own record of what it did and the preset keeps only the text.
 *
 * What a turn produced reaches the host as the harness stores it: a message
 * per transcript note, never emitted twice, then one outcome. Both are encoded
 * by `../harness-wire.ts`.
 *
 * A bundler marks `cloudflare:*` external. The cards reach core's `/artifacts`,
 * whose other modules import `cloudflare:workers`; core is `sideEffects: false`,
 * so they are dropped, but only once the import resolves (measured: a 70 KB
 * bundle with no `cloudflare:` import left).
 */
import type {
  ContainerEvent,
  ContainerOutcome
} from "agents/harness/container/daemon";
import type { CliCommand } from "agents/harness/container/runtime";
import { existsSync } from "node:fs";
import type {
  SandboxCliTurn,
  SandboxDaemonOptions
} from "../../sandbox/daemon/index.js";
import type { EffortLevel, PermissionMode } from "../config.js";
import {
  parseStream,
  toProgress,
  type ClaudeCodeResult,
  type RateLimitInfo
} from "../events.js";
import {
  ANTHROPIC_PLACEHOLDER_HOST,
  encodeNote,
  encodeRunEnd,
  encodeSessionId,
  encodeSkills
} from "../harness-wire.js";
import { CREDENTIAL_PLACEHOLDER } from "../placeholder.js";

export interface ClaudeCodeDaemonOptions {
  /** Reported in the daemon's `hello`, and what the sandbox object names as its adapter. */
  id: string;
  /** The JSON schemas a run header may name, by name. */
  schemas: Readonly<Record<string, Record<string, unknown>>>;
  /** For a run whose header names none. */
  model?: string;
  effort?: EffortLevel;
  /** A `build` run's mode. A `plan` run is always `plan`. */
  permissionMode?: PermissionMode;
  /** Who the session's own commits are attributed to — every git it starts, a submodule's and an amend's included. */
  author?: { name: string; email: string };
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;
  /** More environment for the session. Never a credential: it is the container's. */
  env?: Readonly<Record<string, string>>;
}

/** What the end of stderr is kept to, when a process leaves with no result. */
const STDERR_KEPT = 2_000;

/** Claude Code, as `serveSandboxDaemon`'s `cli`. */
export function claudeCodeDaemonCli(
  options: ClaudeCodeDaemonOptions
): SandboxDaemonOptions["cli"] {
  // Moved, the conversations land outside `.claude/projects`, which is all the
  // harness mirrors, and a lost container could not resume one.
  if (options.env && "CLAUDE_CONFIG_DIR" in options.env) {
    throw new Error(
      "claude-code: CLAUDE_CONFIG_DIR cannot be set through `env`: each session " +
        "keeps its conversations under its own home's .claude/projects, which " +
        "is what the harness keeps for a lost container to resume from"
    );
  }
  return {
    id: options.id,
    // Where the CLI keeps its conversations, under the session's home: the
    // daemon mirrors them to the object, so a lost container resumes them.
    stateDirs: [".claude/projects"],
    command: (turn) => command(options, turn),
    parser: (turn) => parser(turn.operationId)
  };
}

/**
 * Where a checkout keeps the skills the CLI discovers in it, and the file that
 * makes one. Joined onto a run's `cwd`, which is where the CLI is launched.
 */
const SKILL_FILE = (cwd: string, skill: string) =>
  `${cwd}/.claude/skills/${skill}/SKILL.md`;

/**
 * One turn's command.
 *
 * `stream-json` with `--verbose`, because the stream is the only way to report
 * progress before a run of minutes ends, and without `--verbose` the CLI emits
 * only the final result even in stream mode. The mode is always passed, never
 * left to the CLI's own — see `../config.ts` `ClaudeCodeConfig.permissionMode`.
 *
 * A run header's `skill` is a **first line of stdin**, `/<name>`, and not a
 * flag: the pinned CLI has none, and its own rule for `-p` is that a prompt
 * beginning `/name` loads that skill and hands it the rest as its arguments.
 * Measured against the pinned version, offline (`scripts/probe-claude-code.mjs`
 * runs it every round): the `init` line then names the skill, its body is in
 * the first message, and a brief of several paragraphs arrives whole.
 *
 * **Only on a turn that starts a conversation.** The line is a slash command,
 * so sending it into a resumed or forked conversation would re-run the skill
 * and re-inject its whole text mid-session. A skill is chosen once, where the
 * session is chosen.
 *
 * A resumed turn's prompt is the next user turn. An id whose conversation is
 * not there is not a failed session: the CLI emits a `result` naming it, with
 * no model call and nothing billed. A fork continues the conversation under a
 * new id, which is what a change of mode wants — a plan's conversation stays
 * whole for an edit afterwards.
 *
 * What is absent: no `--bare` and no `--settings` override. A cloned
 * repository's `CLAUDE.md`, skills and hooks are what make the agent good at
 * it, and the container already runs that repository's `postinstall` and test
 * suite by design.
 */
function command(
  options: ClaudeCodeDaemonOptions,
  turn: SandboxCliTurn
): CliCommand {
  const header = turn.header;
  const mode: PermissionMode =
    header?.mode === "plan"
      ? "plan"
      : (options.permissionMode ?? "bypassPermissions");
  const argv = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    mode
  ];
  const sessionId = turn.state.sessionId;
  if (sessionId) {
    argv.push("--resume", sessionId);
    if (header?.fork) argv.push("--fork-session");
  }
  const model = header?.model ?? turn.settings.model ?? options.model;
  if (model) argv.push("--model", model);
  const effort = header?.effort ?? options.effort;
  if (effort) argv.push("--effort", effort);
  if (header?.schema !== undefined) {
    const schema = options.schemas[header.schema];
    if (!schema)
      throw new Error(`no schema named ${header.schema} in this image`);
    argv.push("--json-schema", JSON.stringify(schema));
  }
  let stdin = turn.prompt;
  if (header?.skill !== undefined && !sessionId) {
    // A stat, on the one launch that spends the name: it catches the drift that
    // costs the most — a skill renamed where the caller's name for it was not.
    // Not on a turn carrying a conversation on, which injects nothing: that
    // session is already running the process it started under, and the skills
    // in the checkout may have moved since, a session editing them being one of
    // the things a session does. Whether the CLI then *loaded* it is the CLI's
    // own answer, on the `init` line's `skills`, which the host checks
    // (`../model.ts`).
    const file = SKILL_FILE(header.cwd, header.skill);
    if (!existsSync(file))
      throw new Error(
        `no skill named ${header.skill} in this checkout: ${file} is not there`
      );
    stdin = `/${header.skill}\n${turn.prompt}`;
  }
  return { argv, stdin, env: sessionEnv(options) };
}

/**
 * The session's environment. No autoupdate: the image is pinned, and an update
 * would move the wire shape the egress and the parser are written against,
 * mid-run. No nonessential traffic: telemetry and feature-flag fetches, off at
 * the source. The CLI runs as the agent rather than root, so no `IS_SANDBOX`,
 * and each session has its own home, so no `CLAUDE_CONFIG_DIR`.
 *
 * Git's identity is an environment, not a `git config`: every git the session
 * starts inherits it — a superproject's submodules, a scratch clone — and it
 * outranks every config level. Both pairs, because an amend or a rebase keeps
 * the author and stamps a fresh committer. Applied after `env`, so the four
 * keys are one answer.
 *
 * The credential and its base URL are applied last, so a deployment's `env`
 * cannot point the CLI at a real one. What other hosts need — git's and `gh`'s
 * placeholders — the CLI inherits from the daemon, whose environment the
 * sandbox fills from its egress rules.
 */
function sessionEnv(options: ClaudeCodeDaemonOptions): Record<string, string> {
  const author = options.author;
  return {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(options.maxSubagentDepth === undefined
      ? {}
      : {
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(options.maxSubagentDepth)
        }),
    ...(options.maxConcurrentSubagents === undefined
      ? {}
      : {
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(
            options.maxConcurrentSubagents
          )
        }),
    ...options.env,
    ...(author
      ? {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email
        }
      : {}),
    ANTHROPIC_BASE_URL: `http://${ANTHROPIC_PLACEHOLDER_HOST}`,
    CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL_PLACEHOLDER
  };
}

function parser(operationId: string) {
  let thinkingFrom: number | undefined;
  /** Notes so far, which positions each note's key. */
  let n = 0;
  let result: ClaudeCodeResult | undefined;
  let rateLimit: RateLimitInfo | undefined;
  let sessionId: string | undefined;

  return {
    line(line: string) {
      const at = Date.now();
      const parsed = parseStream(`${line}\n`, {
        now: at,
        ...(thinkingFrom === undefined ? {} : { thinkingFrom })
      });
      thinkingFrom = parsed.thinkingFrom;
      // The resume state the harness hands the next turn of this session.
      let state: { sessionId: string } | undefined;
      /**
       * The CLI's own list of what it loaded, or `null` where its `init` line
       * carried none. Reported on every `init` rather than only on the lines
       * that carry a list, so a host that asked for a skill is never left
       * inferring confirmation from a message that did not arrive.
       */
      let skills: readonly string[] | null | undefined;
      for (const event of parsed.events) {
        if (event.kind === "init") {
          sessionId = event.sessionId;
          state = { sessionId };
          skills = event.skills ?? null;
        } else if (event.kind === "rateLimit") rateLimit = event.info;
        else if (event.kind === "result") result = event.result;
      }
      const message = (id: string, text: string): ContainerEvent => ({
        type: "message",
        message: {
          id: `${operationId}:${id}`,
          role: "assistant",
          parts: [{ type: "text", text }],
          operationId,
          createdAt: at
        }
      });
      const events: ContainerEvent[] = [];
      if (state)
        events.push(message("session", encodeSessionId(state.sessionId)));
      if (skills !== undefined)
        events.push(message("skills", encodeSkills(skills)));
      const notes = toProgress(parsed.events, n);
      n += notes.length;
      for (const note of notes)
        events.push(message(note.key, encodeNote(note)));
      if (parsed.skipped > 0) {
        console.warn("[claude-code] a stream line was not recognised", {
          operationId,
          sample: parsed.sample
        });
      }
      return { events, ...(state ? { state } : {}) };
    },
    /**
     * The outcome, once the process has exited — the harness settles nothing
     * before that either. A result with the code the CLI exited with, since a
     * result can be an error it exits non-zero on; with no result, its stderr.
     */
    end(exit: {
      readonly code: number | null;
      readonly stderr: string;
    }): ContainerOutcome {
      if (result) {
        return {
          status: "done",
          text: encodeRunEnd({
            result,
            exitCode: exit.code,
            ...(rateLimit ? { rateLimit } : {}),
            ...(sessionId ? { sessionId } : {})
          })
        };
      }
      return {
        status: "unanswered",
        reason: encodeRunEnd({
          exitCode: exit.code,
          stderr: exit.stderr.slice(-STDERR_KEPT),
          ...(rateLimit ? { rateLimit } : {}),
          ...(sessionId ? { sessionId } : {})
        })
      };
    }
  };
}
