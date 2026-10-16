import { describe, expect, it } from "vitest";
import type { SandboxCliTurn } from "../../sandbox/daemon/index.js";
import {
  ANTHROPIC_PLACEHOLDER_HOST,
  decodeNote,
  decodeRunEnd,
  decodeSessionId
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
  it("sends the session id, then a note per event, then the result as the outcome", () => {
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
    const [session, initNote] = init.events ?? [];
    expect(session).toMatchObject({
      type: "message",
      message: { id: "op-1:session", operationId: "op-1" }
    });
    const text = (event: unknown) =>
      (event as { message: { parts: { text: string }[] } }).message.parts[0]!
        .text;
    expect(decodeSessionId(text(session))).toBe("sess-1");
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
    expect(ended.outcome?.status).toBe("done");
    const end = decodeRunEnd(
      (ended.outcome as { text: string } | undefined)?.text
    );
    expect(end?.result?.text).toBe("the answer");
    expect(end?.sessionId).toBe("sess-1");
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
