import { describe, expect, it } from "vitest";
import { claudeCode, claudeCodeRead, claudeCodeSession } from "./index.js";
import { DEFAULT_PERMISSION_MODE } from "./config.js";
import {
  CLAUDE_CODE_READ_TYPE,
  CLAUDE_CODE_SPEC,
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "./recipe.js";
// The one cross-realm import in this folder, and it exists to hold two
// declarations of the same string together — see the assertion below.
import { WORKSPACE_RUNTIME_KEY as COMPUTER_KEY } from "../computer/index.js";
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

/** What a spec's seams were asked, in order. */
const seamCalls: string[] = [];

const config = (over: Partial<Parameters<typeof claudeCode>[0]> = {}) => ({
  credentials: () => [CREDENTIAL],
  workspaceName: () => "caller|acme/api",
  // What a host does with these is its own — see the config's doc. What a spec
  // needs is that the ids reach them, and that the name is the same twice.
  subtaskWorkspace: async (ctx: {
    taskId: string;
    subtaskId: number;
    continue?: string;
  }) =>
    `caller|<subtask:${ctx.taskId}:${ctx.subtaskId}${ctx.continue ? `:${ctx.continue}` : ""}>`,
  releaseSubtaskWorkspace: async (ctx: {
    taskId: string;
    subtaskId: number;
  }) => {
    seamCalls.push(`release ${ctx.taskId}:${ctx.subtaskId}`);
  },
  abortSubtaskWorkspace: async (ctx: { taskId: string; subtaskId: number }) => {
    seamCalls.push(`abort ${ctx.taskId}:${ctx.subtaskId}`);
  },
  ...over
});

/** The shape core passes; only `type` is read here. */
const context = {
  taskId: "task-1",
  subtaskId: 3,
  type: CLAUDE_CODE_TYPE,
  params: {},
  toolFamilies: [] as readonly string[]
};

/**
 * The hook this plugin exists to have, and without which its own reference host
 * cannot use it.
 *
 * Core dispatches `resolveRuntime` to the plugin that **declared** the subtask
 * type. `claude-code` is declared here, so if this plugin does not carry the
 * hook, nothing else can: a facet receives `{}`, and has no way to address the
 * Durable Object holding the checkout it was told to work in.
 */
describe("resolveRuntime", () => {
  it("hands a writing subtask a workspace of its own", async () => {
    const plugin = claudeCode(config());
    await expect(plugin.resolveRuntime?.(context)).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|<subtask:task-1:3>"
    });
  });

  it("gives one subtask the same workspace on every chunk", async () => {
    const plugin = claudeCode(config());

    // Core calls this once per **chunk**, not once per run. A name that moved
    // between chunks would hand chunk two a different container than chunk one
    // and strand the work in the first.
    const first = await plugin.resolveRuntime?.(context);
    const second = await plugin.resolveRuntime?.(context);
    expect(second).toEqual(first);
  });

  it("passes the branch a subtask continues, and nothing for the default", async () => {
    const plugin = claudeCode(config());

    await expect(
      plugin.resolveRuntime?.({
        ...context,
        params: { continue: "claude-coder/task-0/2" }
      })
    ).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|<subtask:task-1:3:claude-coder/task-0/2>"
    });
    // The schema's default for an omitted param.
    await expect(
      plugin.resolveRuntime?.({ ...context, params: { continue: "" } })
    ).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|<subtask:task-1:3>"
    });
  });

  it("gives two subtasks of one task different workspaces", async () => {
    const plugin = claudeCode(config());

    const three = await plugin.resolveRuntime?.(context);
    const four = await plugin.resolveRuntime?.({ ...context, subtaskId: 4 });
    expect(three).not.toEqual(four);
  });

  it("hands a reading subtask the parent's workspace, to share its container", async () => {
    const plugin = claudeCodeRead(config());
    await expect(
      plugin.resolveRuntime?.({ ...context, type: CLAUDE_CODE_READ_TYPE })
    ).resolves.toEqual({ [WORKSPACE_RUNTIME_KEY]: "caller|acme/api" });
  });

  /**
   * Called per subtask rather than captured once, because the parent's active
   * repository changes mid-task: `repo_clone` picks it, and the workspace name
   * is derived from it. A memoised thunk would send every later subtask to the
   * first repository's container.
   */
  it("reads the thunk each time, so a repository switch is picked up", async () => {
    let repo = "acme/api";
    const plugin = claudeCodeRead(
      config({ workspaceName: () => `caller|${repo}` })
    );

    await plugin.resolveRuntime?.(context);
    repo = "acme/cli";

    await expect(plugin.resolveRuntime?.(context)).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|acme/cli"
    });
  });
});

describe("onAbort and onSettled", () => {
  it("releases the writing subtask's workspace, keyed on its ids", async () => {
    seamCalls.length = 0;
    const plugin = claudeCode(config());

    await plugin.onSettled?.({ ...context, subtaskId: 7 });
    expect(seamCalls).toEqual(["release task-1:7"]);
  });

  it("aborts the writing subtask's work, keyed on its ids", async () => {
    seamCalls.length = 0;
    const plugin = claudeCode(config());

    await plugin.onAbort?.({ ...context, subtaskId: 7 });
    expect(seamCalls).toEqual(["abort task-1:7"]);
  });

  /**
   * The reading type shares the **parent's** workspace, which outlives every
   * subtask that read in it, and its copy is the session driver's to delete.
   */
  it("is absent on the reading plugin, which owns no workspace", () => {
    const plugin = claudeCodeRead(config());
    expect(plugin.onSettled).toBeUndefined();
    expect(plugin.onAbort).toBeUndefined();
  });
});

describe("the writing type's params", () => {
  it("defaults continue to empty, so a delegation may omit it", () => {
    expect(CLAUDE_CODE_SPEC.params?.parse({})).toEqual({ continue: "" });
    expect(
      CLAUDE_CODE_SPEC.params?.parse({ continue: "claude-coder/t/1" })
    ).toEqual({ continue: "claude-coder/t/1" });
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
      .start(runtime, 1, CLAUDE_CODE_READ_TYPE, "look at this", "/workspace/r")
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
      .start(runtime, 1, CLAUDE_CODE_READ_TYPE, "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls[1]?.command).toMatch(
      /^unshare --mount --propagation private -- sh -c '.*' sh claude -p /
    );
    expect(calls[1]?.options.env?.CLAUDE_READ_ONLY).toBe("/workspace");
  });

  it("launches it in the copy alone where the container refuses the namespace", async () => {
    const { calls, runtime } = launchRecorder(false);

    await claudeCodeSession(config())
      .start(runtime, 1, CLAUDE_CODE_READ_TYPE, "look at this", "/workspace/r")
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
      .start(runtime, 1, CLAUDE_CODE_READ_TYPE, "look at this", "/workspace/r")
      .catch(() => {});

    expect(calls[1]?.command).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
  });

  it("launches a writing session in its own checkout, with no copy", async () => {
    const { calls, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, 1, CLAUDE_CODE_TYPE, "change this", "/workspace/r")
      .catch(() => {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.cwd).toBe("/workspace/r");
    expect(calls[0]?.command).toMatch(/^claude -p /);
    expect(calls[0]?.command).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
    expect(calls[0]?.command).not.toContain("throwaway copy");
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
        1,
        CLAUDE_CODE_READ_TYPE,
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
      .followUp(runtime, 1, "sess-1", "one more thing", "/workspace/r")
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
        1,
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

    await claudeCodeSession(config()).stop(runtime, 1);

    // A follow-up turn runs under its own id, and is stopped with the session.
    expect(killed).toEqual([
      "claude-code-run:1:follow-up",
      "claude-code-run:1"
    ]);
    expect(calls.map((c) => c.options.id)).toEqual([
      "claude-code-run:1:uncopy"
    ]);
  });

  /**
   * `WORKSPACE_RUNTIME_KEY` is declared twice on purpose — see `./recipe.ts` —
   * and the two must stay equal. A spec is the one place a cross-realm import
   * costs nothing, so the drift is caught here.
   */
  it("writes under the same key `/computer` reads", () => {
    expect(WORKSPACE_RUNTIME_KEY).toBe(COMPUTER_KEY);
  });
});

/**
 * Fail at Durable Object start, with a sentence naming this plugin — not at the
 * first model call, inside a subtask somebody is already waiting on.
 *
 * Not `requires: { secrets: [...] }`: pool entries are host-named, so there is
 * no name this package could declare — and checking the value is stronger than
 * checking that a name is set.
 */
describe("construction", () => {
  it("refuses a pool with no credentials in it", () => {
    expect(() => claudeCode(config({ credentials: () => [] }))).toThrow(
      /no credentials/
    );
  });

  it("refuses a pool of empty strings", () => {
    // `[env.TOKEN_1, env.TOKEN_2]` with neither secret set. The array is not
    // empty, and every entry in it is useless.
    expect(() => claudeCode(config({ credentials: () => ["", ""] }))).toThrow(
      /no credentials/
    );
  });

  it("accepts a single credential, which is the ordinary deployment", () => {
    expect(() => claudeCode(config())).not.toThrow();
  });

  /**
   * A plugin that declares a subtask type puts its capability block on the
   * *type*. Declaring both makes the main agent read the same advice twice per
   * round — the exact failure the type's own prompt fields were introduced to
   * end.
   */
  it("declares one subtask type, no tool families and no capability", () => {
    const plugin = claudeCode(config());
    expect(plugin.subtaskType?.key).toBe(CLAUDE_CODE_TYPE);
    expect(plugin.subtaskType?.recipe.toolFamilies).toEqual([]);
    expect(plugin.toolFamilies).toBeUndefined();
    expect(plugin.capability).toBeUndefined();
  });
});

describe("the session's egress", () => {
  /**
   * `store` is an argument rather than a config field because the pool's state
   * belongs to whichever object has storage. The same config is also held by the
   * parent's plugin list and by the subagent facet, and neither has any — making
   * it a field would force both of them to invent one.
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
 * The caller is a chunk loop holding a cursor it will keep presenting, so a
 * throw here is retried against the same dead id until the chunk allowance runs
 * out, ending the run on a stack trace that names neither the session nor the
 * cause. Reported as a terminal outcome, it ends at the first attempt with
 * something the subtask can act on.
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
   * the right answer to it. Swallowing those would turn a recoverable chunk into
   * a subtask that reports itself finished having done nothing.
   */
  it("still throws anything that is not a lost execution", async () => {
    const session = claudeCodeSession(config());

    await expect(
      session.resume(runtime(new Error("container unreachable")), cursor)
    ).rejects.toThrow(/unreachable/);
  });
});
