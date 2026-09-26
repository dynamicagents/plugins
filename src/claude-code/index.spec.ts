import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_AGENT,
  CLAUDE_CODE_READER_AGENT,
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
 * The two specs, as the parent's model sees them. `prepare` and `settle` are
 * the host's, so a spec here carries neither.
 */
describe("the sub-agent specs", () => {
  it("offers the writer and the reader under their own names", () => {
    expect(CLAUDE_CODE_AGENT.name).toBe("claude_code");
    expect(CLAUDE_CODE_READER_AGENT.name).toBe("claude_code_read");
  });

  /** A session runs for up to its `timeoutMs`, past a parent's turn. */
  it("runs both detached", () => {
    expect(CLAUDE_CODE_AGENT.detached).toBe(true);
    expect(CLAUDE_CODE_READER_AGENT.detached).toBe(true);
  });

  it("lets the writer name a branch to continue, and the reader not", () => {
    const write = CLAUDE_CODE_AGENT.inputSchema as unknown as {
      parse: (v: unknown) => unknown;
    };
    const read = CLAUDE_CODE_READER_AGENT.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(write.parse({ task: "t" })).toEqual({ task: "t" });
    expect(write.parse({ task: "t", continue: "claude-coder/t/1" })).toEqual({
      task: "t",
      continue: "claude-coder/t/1"
    });
    expect(Object.keys(read.shape)).toEqual(["task"]);
  });

  /** The session reads the task; the branch is the host's `prepare`'s. */
  it("hands the session the task alone", () => {
    expect(
      CLAUDE_CODE_AGENT.formatInput!({ task: "add the flag", continue: "b" })
    ).toBe("add the flag");
    expect(CLAUDE_CODE_READER_AGENT.formatInput!({ task: "why?" })).toBe(
      "why?"
    );
  });

  it("tells the parent a reader's edits are discarded", () => {
    expect(CLAUDE_CODE_READER_AGENT.description).toContain(
      "Nothing it changes reaches your"
    );
  });
});

/**
 * Where a session actually runs, read off the calls `start` makes.
 *
 * Asserted at the launch boundary rather than on a helper, because "a host could
 * leave it out" is the failure that matters and only this boundary can rule it
 * out: a reading session launched in the parent's tree would write where its
 * parent and every other reader are reading, and report that as success.
 */
describe("where a session runs", () => {
  type Runtime = Parameters<ReturnType<typeof claudeCodeSession>["start"]>[0];

  const COPIED = "/var/tmp/claude-read/claude-code-run_1/tree";

  /** A finished exec that printed `out`. */
  function finished(id: string, out: string, code = 0) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ id, seq: 1, name: "stdout", value: out });
        controller.enqueue({ id, seq: 2, name: "exit", code });
        controller.close();
      }
    });
    return Object.assign(stream, { id, [Symbol.dispose]: () => {} });
  }

  /**
   * Answers the copy scripts, and refuses the launch once it has recorded it —
   * the launch is what is under test.
   */
  function launchRecorder(isolated = true) {
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
          if (options.id?.endsWith(":copy"))
            return finished(
              options.id,
              `tree=${COPIED}\ndeps=1/1\nupper=disk\nisolated=${isolated ? "yes" : "no"}\n`
            );
          if (options.id?.endsWith(":uncopy")) return finished(options.id, "");
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

  it("puts a reading session in a copy of the checkout, never the checkout", async () => {
    const { calls, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, "1", "read", "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls.map((c) => c.options.id)).toEqual([
      "claude-code-run:1:copy",
      "claude-code-run:1"
    ]);
    expect(calls[0]?.options.env?.SRC).toBe("/workspace/r");
    // An exec's cwd is resolved against the workspace's filesystem, where the
    // copy — on container disk — does not exist. It starts in the original and
    // the command moves into the copy before it becomes claude.
    expect(calls[1]?.options.cwd).toBe("/workspace/r");
    expect(calls[1]?.options.env?.CLAUDE_WORKDIR).toBe(COPIED);
    // Told where it is, since its edits are discarded and its report is not.
    expect(calls[1]?.command).toContain("throwaway copy");
  });

  /**
   * A working directory is not a boundary: the session runs as root, and its
   * brief may name the original by absolute path.
   */
  it("launches a reading session where the workspace is read-only", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .start(runtime, "1", "read", "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls[1]?.command).toMatch(
      /^unshare --mount --propagation private -- sh -c '.*' sh claude -p /
    );
    expect(calls[1]?.options.env?.CLAUDE_READ_ONLY).toBe("/workspace");
  });

  it("launches it in the copy alone where the container refuses the namespace", async () => {
    const { calls, runtime } = launchRecorder(false);

    await claudeCodeSession(config())
      .start(runtime, "1", "read", "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls[1]?.command).toMatch(
      /^cd "\$CLAUDE_WORKDIR" && exec claude -p /
    );
    expect(calls[1]?.options.env?.CLAUDE_WORKDIR).toBe(COPIED);
    expect(calls[1]?.command).toContain("Do not write under");
  });

  /**
   * The copy and the read-only namespace are the isolation, so a reading session
   * needs no mode that refuses edits — and every such mode refuses the suite and
   * the build too.
   */
  it("launches a reading session under the same mode as a writing one", async () => {
    const { calls, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, "1", "read", "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls[1]?.command).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
  });

  it("launches a writing session in its own checkout, with no copy", async () => {
    const { calls, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, "1", "write", "change this", "/workspace/r")
      .catch(() => {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toMatch(/^claude -p /);
    expect(calls[0]?.command).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
    expect(calls[0]?.command).not.toContain("throwaway copy");
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
        session.start(runtime, "1", "write", "work", "/workspace/r", {
          signal: replaced.signal
        })
      ).rejects.toThrow(/live subscriber/);
      await expect(
        session.followUp(runtime, "1", "session-1", "more", "/workspace/r", {
          signal: replaced.signal
        })
      ).rejects.toThrow(/live subscriber/);
      expect(looks).toBe(2);
    } finally {
      info.mockRestore();
    }
  });

  /** Falling back to the checkout is the one thing it must never do. */
  it("fails a reading session whose copy could not be made, without launching", async () => {
    const calls: string[] = [];
    const runtime = {
      exec: async (_command: string, options: { id: string }) => {
        calls.push(options.id);
        return finished(options.id, "", 1);
      },
      getExec: async () => {
        throw new Error("not called");
      },
      killExec: async () => {}
    } as unknown as Runtime;

    await expect(
      claudeCodeSession(config()).start(
        runtime,
        "1",
        "read",
        "look",
        "/workspace/r"
      )
    ).rejects.toThrow(/could not make a copy/);
    expect(calls).toEqual(["claude-code-run:1:copy"]);
  });

  it("deletes the copy when a resumed reading session ends", async () => {
    const calls: string[] = [];
    const runtime = {
      exec: async (_command: string, options: { id: string }) => {
        calls.push(options.id);
        return finished(options.id, "");
      },
      getExec: async (id: string) => finished(id, ""),
      killExec: async () => {}
    } as unknown as Runtime;

    const outcome = await claudeCodeSession(config()).resume(runtime, {
      execId: "claude-code-run:1",
      seq: 0,
      carry: "",
      emitted: 0,
      copy: true
    });

    expect(outcome.done).toBe(true);
    expect(calls).toEqual(["claude-code-run:1:uncopy"]);
  });

  it("leaves a writing session's checkout alone when it ends", async () => {
    const calls: string[] = [];
    const runtime = {
      exec: async (_command: string, options: { id: string }) => {
        calls.push(options.id);
        return finished(options.id, "");
      },
      getExec: async (id: string) => finished(id, ""),
      killExec: async () => {}
    } as unknown as Runtime;

    await claudeCodeSession(config()).resume(runtime, {
      execId: "claude-code-run:1",
      seq: 0,
      carry: "",
      emitted: 0
    });

    expect(calls).toEqual([]);
  });

  it("resumes a finished session under its own id, in the checkout", async () => {
    const { calls, runtime } = launchRecorder();

    await claudeCodeSession(config())
      .followUp(runtime, "1", "sess-1", "one more thing", "/workspace/r")
      .catch(() => {});

    expect(calls.map((c) => c.options.id)).toEqual([
      "claude-code-run:1:follow-up"
    ]);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toContain("--resume sess-1");
    expect(calls[0]?.command).toContain("'one more thing'");
  });

  it("refuses a follow-up with no session id rather than starting a new session", async () => {
    const { calls, runtime } = launchRecorder();

    await expect(
      claudeCodeSession(config()).followUp(
        runtime,
        "1",
        "",
        "more",
        "/workspace/r"
      )
    ).rejects.toThrow(/needs the session id/);
    expect(calls).toEqual([]);
  });

  /** A session stopped with no drain attached has nobody else to close it. */
  it("deletes the copy when a session is stopped", async () => {
    const { calls, killed, runtime } = launchRecorder();

    await claudeCodeSession(config()).stop(runtime, "1");

    // A follow-up turn runs under its own id, and is stopped with the session.
    expect(killed).toEqual([
      "claude-code-run:1:follow-up",
      "claude-code-run:1"
    ]);
    expect(calls.map((c) => c.options.id)).toEqual([
      "claude-code-run:1:uncopy"
    ]);
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
      kind: "write",
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
