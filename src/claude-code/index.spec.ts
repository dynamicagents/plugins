import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_AGENT,
  claudeCodeModel,
  claudeCodeSession
} from "./index.js";
import { DEFAULT_PERMISSION_MODE, type ClaudeCodeConfig } from "./config.js";
import type { CredentialState, CredentialStore } from "./credentials.js";

const CREDENTIAL = "sk-ant-oat01-REAL";

function memoryStore(): CredentialStore {
  let states: CredentialState[] = [];
  return {
    read: async () => states,
    write: async (next) => {
      states = next;
    }
  };
}

const config = (over: Partial<ClaudeCodeConfig> = {}): ClaudeCodeConfig => ({
  credentials: () => [CREDENTIAL],
  ...over
});

/**
 * The spec, as the parent's model sees it. `prepare` and `settle` are the
 * host's, so the spec carries neither.
 */
describe("the sub-agent spec", () => {
  it("offers the writer under its own name", () => {
    expect(CLAUDE_CODE_AGENT.name).toBe("claude_code");
  });

  /** A session runs for up to its `timeoutMs`, past a parent's turn. */
  it("runs detached", () => {
    expect(CLAUDE_CODE_AGENT.detached).toBe(true);
  });

  it("lets the writer name a branch to continue", () => {
    const write = CLAUDE_CODE_AGENT.inputSchema as unknown as {
      parse: (v: unknown) => unknown;
    };
    expect(write.parse({ task: "t" })).toEqual({ task: "t" });
    expect(
      write.parse({ task: "t", continue: "anthropic-coding/t/1" })
    ).toEqual({
      task: "t",
      continue: "anthropic-coding/t/1"
    });
  });

  /** The session reads the task; the branch is the host's `prepare`'s. */
  it("hands the session the task alone", () => {
    expect(
      CLAUDE_CODE_AGENT.formatInput!({ task: "add the flag", continue: "b" })
    ).toBe("add the flag");
  });
});

/**
 * Where and how a session actually runs, read off the calls `start` makes —
 * the launch boundary, which is the one place a mode or a directory a host did
 * not mean could still slip in.
 */
describe("where a session runs", () => {
  type Runtime = Parameters<ReturnType<typeof claudeCodeSession>["start"]>[0];

  /** Refuses the launch once it has recorded it — the launch is what is under test. */
  function launchRecorder() {
    const calls: {
      command: string;
      options: { id?: string; cwd?: string; env?: Record<string, string> };
    }[] = [];
    const killed: string[] = [];
    return {
      calls,
      killed,
      runtime: {
        exec: async (
          command: string,
          options: (typeof calls)[number]["options"]
        ) => {
          calls.push({ command, options });
          throw new Error("stop here — the launch is what is under test");
        },
        getExec: async () => {
          throw new Error("not called");
        },
        killExec: async (id: string) => {
          killed.push(id);
        }
      } as unknown as Runtime
    };
  }

  it("launches a session in its checkout, under the config's mode", async () => {
    const { calls, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, "1", {
        prompt: "change this",
        dir: "/workspace/r"
      })
      .catch(() => {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toMatch(/^claude -p /);
    expect(calls[0]?.command).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
    expect(calls[0]?.options.env?.IS_SANDBOX).toBe("1");
  });

  /**
   * A planning run is a writing session under `plan`. The run's mode wins over
   * the config's, and `IS_SANDBOX` goes with `bypassPermissions` alone.
   */
  it("launches a planning run under plan, over the config's mode", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config({ permissionMode: "acceptEdits" }))
      .start(runtime, "1", {
        prompt: "work out how",
        dir: "/workspace/r",
        permissionMode: "plan",
        jsonSchema: { type: "object" }
      })
      .catch(() => {});

    expect(calls[0]?.command).toContain("--permission-mode plan");
    expect(calls[0]?.command).not.toContain("acceptEdits");
    expect(calls[0]?.command).toContain("--json-schema");
    expect(calls[0]?.options.env?.IS_SANDBOX).toBeUndefined();
  });

  /**
   * A cancelled turn, caught in `startRun`'s fallback to an exec that is
   * already live. Both launches reach it, and both must give up the wait.
   */
  it("hands both launches the signal that stops a busy id's wait", async () => {
    let looks = 0;
    const runtime = {
      exec: async () => {
        throw Object.assign(new Error("execution is running"), {
          code: "EEXEC_BUSY"
        });
      },
      getExec: async () => {
        looks++;
        throw new Error("exec x already has a live subscriber");
      },
      killExec: async () => {}
    } as unknown as Runtime;
    const replaced = new AbortController();
    replaced.abort();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const session = claudeCodeSession(config());
      await expect(
        session.start(
          runtime,
          "1",
          { prompt: "work", dir: "/workspace/r" },
          { signal: replaced.signal }
        )
      ).rejects.toThrow(/live subscriber/);
      await expect(
        session.followUp(
          runtime,
          "1",
          { sessionId: "session-1", prompt: "more", dir: "/workspace/r" },
          { signal: replaced.signal }
        )
      ).rejects.toThrow(/live subscriber/);
      expect(looks).toBe(2);
    } finally {
      info.mockRestore();
    }
  });

  it("resumes a finished session under its own id, in the checkout", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .followUp(runtime, "1", {
        sessionId: "sess-1",
        prompt: "one more thing",
        dir: "/workspace/r"
      })
      .catch(() => {});

    expect(calls.map((c) => c.options.id)).toEqual([
      "claude-code-run:1:follow-up"
    ]);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toContain("--resume sess-1");
    expect(calls[0]?.command).toContain("'one more thing'");
  });

  /**
   * A run given a conversation to continue has no first session of its own, so
   * the continuation is its **own** exec — not the follow-up's, which exists to
   * follow a session this run ran.
   */
  it("continues a conversation on the run's own exec, in the checkout", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .start(runtime, "1", {
        prompt: "carry on",
        dir: "/workspace/r",
        resume: { sessionId: "sess-1", fork: true }
      })
      .catch(() => {});

    expect(calls.map((c) => c.options.id)).toEqual(["claude-code-run:1"]);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toContain("--resume sess-1 --fork-session");
    expect(calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(
      "/workspace/.claude-sessions"
    );
  });

  /** A follow-up finds the transcript where every session wrote its own. */
  it("gives a follow-up the directory the session's transcript is in", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .followUp(runtime, "1", {
        sessionId: "sess-1",
        prompt: "commit what you left",
        dir: "/workspace/r"
      })
      .catch(() => {});

    expect(calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(
      "/workspace/.claude-sessions"
    );
    expect(calls[0]?.command).toContain("--resume sess-1");
    // One more turn of the same conversation is the opposite of a fork.
    expect(calls[0]?.command).not.toContain("--fork-session");
  });

  /** One more turn of a planning session is still a turn of planning. */
  it("runs a follow-up under the session's own mode", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .followUp(runtime, "1", {
        sessionId: "sess-1",
        prompt: "and the tests?",
        dir: "/workspace/r",
        permissionMode: "plan"
      })
      .catch(() => {});

    expect(calls[0]?.command).toContain("--permission-mode plan");
  });

  it("refuses a follow-up with no session id rather than starting a new session", async () => {
    const { calls, runtime } = launchRecorder();

    await expect(
      claudeCodeSession(config()).followUp(runtime, "1", {
        sessionId: "",
        prompt: "more",
        dir: "/workspace/r"
      })
    ).rejects.toThrow(/needs the session id/);
    expect(calls).toEqual([]);
  });

  it("stops a session's follow-up with it", async () => {
    const { calls, killed, runtime } = launchRecorder();

    await claudeCodeSession(config()).stop(runtime, "1");

    // A follow-up turn runs under its own id, and is stopped with the session.
    expect(killed).toEqual([
      "claude-code-run:1:follow-up",
      "claude-code-run:1"
    ]);
    expect(calls).toEqual([]);
  });
});

/**
 * Fail when the model is built, with a sentence naming this plugin — not at
 * the first model call, inside a run somebody is already waiting on.
 *
 * Not `requires: { secrets: [...] }`: pool entries are host-named, so there is
 * no name this package could declare — and checking the value is stronger than
 * checking that a name is set.
 */
describe("construction", () => {
  const model = (over: Partial<ClaudeCodeConfig>) => () =>
    claudeCodeModel({
      config: config(over),
      workspace: async () => {
        throw new Error("not opened");
      },
      storage: {} as DurableObjectStorage,
      runId: "r",
      dir: "/workspace/r",
      note: async () => {},
      report: async () => ""
    });

  it("refuses a pool with no credentials in it", () => {
    expect(model({ credentials: () => [] })).toThrow(/no credentials/);
  });

  it("refuses a pool of empty strings", () => {
    // `[env.TOKEN_1, env.TOKEN_2]` with neither secret set. The array is not
    // empty, and every entry in it is useless.
    expect(model({ credentials: () => ["", ""] })).toThrow(/no credentials/);
  });

  it("accepts a single credential, which is the ordinary deployment", () => {
    expect(model({})).not.toThrow();
  });
});

describe("the session's egress", () => {
  /**
   * `store` is an argument rather than a config field because the pool's state
   * belongs to whichever object has storage. The same config is also held by the
   * agents that run sessions, which have none of their own for it — making it a
   * field would force them to invent one.
   */
  it("takes the store at the point storage actually exists", () => {
    const session = claudeCodeSession(config());
    expect(typeof session.egress(memoryStore()).fetch).toBe("function");
  });
});

/**
 * The container holding a session can be replaced under it — a deploy, an
 * eviction, a relaunch the runtime decided on — and the attachment is the first
 * thing to find out.
 *
 * The caller is a recovered turn holding a cursor it will keep presenting, so a
 * throw here is retried against the same dead id until the recoveries run out,
 * ending the run on a stack trace that names neither the session nor the cause.
 * Reported as a terminal outcome, it ends at the first attempt with something
 * the run's report can say.
 */
describe("a session whose container was replaced", () => {
  const lost = () =>
    Object.assign(
      new Error(
        'Execution "e1" was lost when its container runtime was replaced.'
      ),
      { name: "WorkspaceExecutionLostError", code: "EEXEC_LOST" }
    );

  const runtime = (err: unknown) =>
    ({
      exec: async () => {
        throw new Error("not called");
      },
      getExec: async () => {
        throw err;
      },
      killExec: async () => {}
    }) as unknown as Parameters<
      ReturnType<typeof claudeCodeSession>["resume"]
    >[0];

  const cursor = {
    execId: "claude-code-run:3",
    seq: 4,
    carry: "",
    emitted: 2
  };

  it("ends the run instead of throwing at the caller", async () => {
    const session = claudeCodeSession(config());

    const outcome = await session.resume(runtime(lost()), cursor);

    expect(outcome.done).toBe(true);
    // The cursor comes back untouched: the caller records where it got to, and
    // nothing about this outcome invites another attempt at the same id.
    expect(outcome.cursor).toEqual(cursor);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.stderr).toContain("container");
    // What it must not do is promise a rerun is safe: a session that got far
    // enough to commit or push did that before its container went.
    expect(outcome.stderr).toContain("Check the workspace");
    expect(outcome.stderr).not.toMatch(/is safe/);
  });

  /**
   * Only that one code. Every other failure to attach — a transport that
   * dropped, a runtime that is simply unreachable — is transient, and a retry is
   * the right answer to it. Swallowing those would turn a recoverable turn into
   * a run that reports itself finished having done nothing.
   */
  it("still throws anything that is not a lost execution", async () => {
    const session = claudeCodeSession(config());

    await expect(
      session.resume(runtime(new Error("container unreachable")), cursor)
    ).rejects.toThrow(/unreachable/);
  });
});
