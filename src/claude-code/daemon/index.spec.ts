import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxCliTurn } from "../../sandbox/daemon/index.js";
import {
  ANTHROPIC_PLACEHOLDER_HOST,
  decodeNote,
  decodeRunEnd,
  decodeSessionId,
  decodeSkills
} from "../harness-wire.js";
import { CREDENTIAL_PLACEHOLDER } from "../placeholder.js";
import { claudeCodeDaemonCli } from "./index.js";

/**
 * Claude Code as the sandbox daemon's CLI: the launch a run header asks for,
 * and what the host is sent back — the CLI's stream as the harness stores it.
 */

const SCHEMA = { type: "object", properties: { plan: { type: "string" } } };
const cli = (over: Parameters<typeof claudeCodeDaemonCli>[0] | object = {}) =>
  claudeCodeDaemonCli({ id: "da-claude", schemas: { plan: SCHEMA }, ...over });

const turn = (over: Partial<SandboxCliTurn> = {}): SandboxCliTurn => ({
  operationId: "op-1",
  prompt: "do the thing",
  settings: {},
  state: {},
  header: { cwd: "/workspace/repo" },
  ...over
});

const line = (value: unknown) => JSON.stringify(value);

describe("the launch", () => {
  it("runs a plan as plan, resumed, with the named schema, model and effort", () => {
    const { argv, stdin } = cli().command(
      turn({
        state: { sessionId: "sess-1" },
        header: {
          cwd: "/workspace/repo",
          mode: "plan",
          schema: "plan",
          effort: "high",
          model: "opus"
        }
      })
    );
    expect(argv.slice(0, 7)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan"
    ]);
    expect(argv).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(argv).not.toContain("--fork-session");
    expect(argv.join(" ")).toContain("--model opus --effort high");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(SCHEMA)
    );
    expect(stdin).toBe("do the thing");
  });

  it("forks only a resumed session, and builds in the daemon's mode", () => {
    const fresh = cli().command(
      turn({ header: { cwd: "/workspace/repo", fork: true } })
    ).argv;
    expect(fresh).not.toContain("--fork-session");
    expect(fresh[fresh.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions"
    );
    expect(
      cli().command(
        turn({
          state: { sessionId: "sess-1" },
          header: { cwd: "/workspace/repo", fork: true }
        })
      ).argv
    ).toContain("--fork-session");
  });

  /**
   * A skill is selected by a first line of stdin, `/<name>`, because the pinned
   * CLI has no flag for one — `scripts/probe-claude-code.mjs` is where that is
   * established against the CLI itself, every dependency round.
   *
   * `cwd` is a real directory here and under `/tmp` rather than `/workspace`,
   * which is the only tree this pool's filesystem lets a spec write: the launch
   * reads the checkout, and a header that has already been read is not
   * re-validated here.
   */
  describe("a skill the run header names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-code-skill-"));
    const skill = "refactor-discovery";
    mkdirSync(join(cwd, ".claude", "skills", skill), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", skill, "SKILL.md"), "---\n");

    it("goes on the first line of stdin, with the prompt under it", () => {
      const { argv, stdin } = cli().command(
        turn({ header: { cwd, skill }, prompt: "find one" })
      );
      expect(stdin).toBe(`/${skill}\nfind one`);
      // A selected skill is not a flag, and changes nothing else about the launch.
      expect(argv).toEqual(cli().command(turn({ header: { cwd } })).argv);
    });

    it("is not sent again into a conversation that already has it", () => {
      const { stdin } = cli().command(
        turn({
          header: { cwd, skill },
          prompt: "carry on",
          state: { sessionId: "sess-1" }
        })
      );
      expect(stdin).toBe("carry on");
    });

    /**
     * The checkout is not fixed for a session's life — editing the skills is
     * work a session does — and a turn that injects nothing has no name to
     * spend. Checking one anyway would make a skill renamed mid-session the end
     * of the conversation that renamed it.
     */
    it("is not looked for on a turn carrying a conversation on", () => {
      const { stdin } = cli().command(
        turn({
          header: { cwd, skill: "renamed-since" },
          prompt: "carry on",
          state: { sessionId: "sess-1" }
        })
      );
      expect(stdin).toBe("carry on");
    });

    it("leaves a run that names none byte-identical to its prompt", () => {
      const prompt = "/not-a-skill-line\nand a prompt that starts with one";
      expect(cli().command(turn({ header: { cwd }, prompt })).stdin).toBe(
        prompt
      );
    });

    it("is refused before launch when the checkout has no such skill", () => {
      expect(() =>
        cli().command(turn({ header: { cwd, skill: "renamed-since" } }))
      ).toThrow(/no skill named renamed-since in this checkout/);
    });
  });

  it("refuses a schema the image was not built with", () => {
    expect(() =>
      cli().command(
        turn({
          header: { cwd: "/workspace/repo", mode: "plan", schema: "nope" }
        })
      )
    ).toThrow(/no schema named nope/);
  });

  it("gives the CLI placeholders only, and no env can swap in a credential", () => {
    const { env } = cli({
      author: { name: "Ada", email: "ada@example.invalid" },
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-REAL", EXTRA: "1" }
    }).command(turn());
    expect(env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL_PLACEHOLDER,
      ANTHROPIC_BASE_URL: `http://${ANTHROPIC_PLACEHOLDER_HOST}`,
      GIT_AUTHOR_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.invalid",
      DISABLE_AUTOUPDATER: "1",
      EXTRA: "1"
    });
    expect(env).not.toHaveProperty("IS_SANDBOX");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("refuses to move the conversations out of what the harness keeps", () => {
    expect(() => cli({ env: { CLAUDE_CONFIG_DIR: "/tmp/elsewhere" } })).toThrow(
      /CLAUDE_CONFIG_DIR/
    );
  });
});

describe("the parse", () => {
  it("sends the session id, then a note per event, then the result and the exit code as the outcome", () => {
    const parse = cli().parser(turn());
    const init = parse.line(
      line({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "opus"
      })
    );
    expect(init.state).toEqual({ sessionId: "sess-1" });
    // What the line said about the session comes before what it said the model
    // did: a host reads the id and the skills off the first poll either way,
    // and only the notes are positional.
    const [session, loaded, initNote] = init.events ?? [];
    expect(session).toMatchObject({
      type: "message",
      message: { id: "op-1:session", operationId: "op-1" }
    });
    const text = (event: unknown) =>
      (event as { message: { parts: { text: string }[] } }).message.parts[0]!
        .text;
    expect(decodeSessionId(text(session))).toBe("sess-1");
    expect(decodeSkills(text(loaded))).toBeNull();
    expect(decodeNote(text(initNote))?.key).toBe("claude:0");

    const said = parse.line(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "found it" }] }
      })
    );
    const note = decodeNote(text(said.events?.[0]));
    expect(note).toEqual({ key: "claude:1", text: "found it" });
    expect(said.outcome).toBeUndefined();

    const ended = parse.line(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "the answer",
        session_id: "sess-1",
        total_cost_usd: 0.1,
        usage: {}
      })
    );
    // Nothing settles before the process exits, which is when its code is known.
    expect(ended.outcome).toBeUndefined();
    const outcome = parse.end({ code: 0, stderr: "" });
    expect(outcome.status).toBe("done");
    const end = decodeRunEnd((outcome as { text: string }).text);
    expect(end?.result?.text).toBe("the answer");
    expect(end?.exitCode).toBe(0);
    expect(end?.sessionId).toBe("sess-1");
  });

  /**
   * What the CLI loaded, as its own answer rather than as a guess from disk —
   * the host compares it with the skill it asked for and stops a session that
   * is about to do generic work (`../model.ts`). Reported for every `init`,
   * `null` included: a host left waiting for a message that never comes would
   * read silence as confirmation, which is the one answer it must not give.
   */
  it("sends the skills the CLI reported loading, and null when it named none", () => {
    const text = (event: unknown) =>
      (event as { message: { parts: { text: string }[] } }).message.parts[0]!
        .text;
    const reported = (over: Record<string, unknown>) => {
      const update = cli()
        .parser(turn())
        .line(
          line({
            type: "system",
            subtype: "init",
            session_id: "sess-1",
            ...over
          })
        );
      const message = update.events?.find(
        (event) => decodeSkills(text(event)) !== undefined
      );
      return message === undefined ? "no message" : decodeSkills(text(message));
    };

    expect(reported({ skills: ["refactor-discovery", "simplify"] })).toEqual([
      "refactor-discovery",
      "simplify"
    ]);
    // Loaded nothing, and did not say — two answers, and the host stops on
    // both, so what matters is that neither arrives as silence.
    expect(reported({ skills: [] })).toEqual([]);
    for (const over of [{}, { skills: "refactor-discovery" }]) {
      expect(reported(over)).toBeNull();
    }
  });

  /** No `init` line at all is the one turn with nothing to report. */
  it("sends no skills message for a line that starts no conversation", () => {
    const text = (event: unknown) =>
      (event as { message: { parts: { text: string }[] } }).message.parts[0]!
        .text;
    const update = cli()
      .parser(turn())
      .line(line({ type: "system", subtype: "compact_boundary" }));
    expect(
      update.events?.some((event) => decodeSkills(text(event)) !== undefined)
    ).toBe(false);
  });

  it("keeps the code a CLI exits with after an error result", () => {
    const parse = cli().parser(turn());
    parse.line(
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-1",
        usage: {}
      })
    );
    const outcome = parse.end({ code: 1, stderr: "" });
    expect(outcome.status).toBe("done");
    const end = decodeRunEnd((outcome as { text: string }).text);
    expect(end?.exitCode).toBe(1);
    expect(end?.result?.isError).toBe(true);
  });

  it("ends a process that printed no result with its exit and the end of its stderr", () => {
    const parse = cli().parser(turn());
    const outcome = parse.end({ code: 1, stderr: `${"x".repeat(5000)}boom` });
    expect(outcome.status).toBe("unanswered");
    const end = decodeRunEnd((outcome as { reason?: string }).reason);
    expect(end?.exitCode).toBe(1);
    expect(end?.stderr?.endsWith("boom")).toBe(true);
    expect(end?.stderr?.length).toBe(2000);
    expect(end?.result).toBeUndefined();
  });
});
