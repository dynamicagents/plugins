import { describe, expect, it } from "vitest";
import { claudeCode, claudeCodeRead, claudeCodeSession } from "./index.js";
import {
  DEFAULT_PERMISSION_MODE,
  READ_ONLY_PERMISSION_MODE
} from "./config.js";
import {
  CLAUDE_CODE_READ_TYPE,
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

/** Every workspace a spec's `subtaskWorkspace` was asked to make, then reclaim. */
const reclaimed: string[] = [];

const config = (over: Partial<Parameters<typeof claudeCode>[0]> = {}) => ({
  credentials: () => [CREDENTIAL],
  workspaceName: () => "caller|acme/api",
  // What a host does with these is its own — see the config's doc. What a spec
  // needs is that the ids reach them, and that the name is the same twice.
  subtaskWorkspace: async (ctx: { taskId: string; subtaskId: number }) =>
    `caller|<subtask:${ctx.taskId}:${ctx.subtaskId}>`,
  reclaimSubtaskWorkspace: async (ctx: {
    taskId: string;
    subtaskId: number;
  }) => {
    reclaimed.push(`${ctx.taskId}:${ctx.subtaskId}`);
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

describe("onSettled", () => {
  it("reclaims the writing subtask's own workspace, keyed on its ids", async () => {
    reclaimed.length = 0;
    const plugin = claudeCode(config());

    await plugin.onSettled?.({ ...context, subtaskId: 7 });
    expect(reclaimed).toEqual(["task-1:7"]);
  });

  /**
   * The reading type shares the **parent's** workspace, which outlives every
   * subtask that read in it. A hook here would reclaim the checkout and the
   * dependency tree the next task is counting on.
   */
  it("is absent on the reading plugin, which owns no workspace", () => {
    expect(claudeCodeRead(config()).onSettled).toBeUndefined();
  });
});

/**
 * The mode a session actually launches under, read off the command line it builds.
 *
 * Asserted here rather than on a helper, because "a host could pass the wrong one"
 * is the failure that matters and only the launch boundary can rule it out: a
 * reading session that got the writing mode would edit the checkout it shares with
 * its parent, and would report that as success.
 */
describe("the permission mode a session starts under", () => {
  /** Captures the argv `start` builds, then refuses to go further. */
  function launchRecorder() {
    const commands: string[] = [];
    return {
      commands,
      runtime: {
        exec: async (command: unknown) => {
          commands.push(
            typeof command === "string" ? command : JSON.stringify(command)
          );
          throw new Error("stop here — the launch is what is under test");
        },
        getExec: async () => {
          throw new Error("not called");
        },
        killExec: async () => {}
      } as unknown as Parameters<
        ReturnType<typeof claudeCodeSession>["start"]
      >[0]
    };
  }

  it("gives a reading subtask a mode that cannot edit", async () => {
    const { commands, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, 1, CLAUDE_CODE_READ_TYPE, "look at this", "/workspace/r")
      .catch(() => {});

    expect(commands[0]).toContain(
      `--permission-mode ${READ_ONLY_PERMISSION_MODE}`
    );
  });

  it("leaves a writing subtask on the mode that can", async () => {
    const { commands, runtime } = launchRecorder();
    const session = claudeCodeSession(config());

    await session
      .start(runtime, 1, CLAUDE_CODE_TYPE, "change this", "/workspace/r")
      .catch(() => {});

    expect(commands[0]).toContain(
      `--permission-mode ${DEFAULT_PERMISSION_MODE}`
    );
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
