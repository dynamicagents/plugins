import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRuntimeEvent } from "@cloudflare/computer";
import {
  claudeCodeModel,
  type ClaudeCodeModelOptions,
  type SessionOutcome
} from "./model.js";
import { execIdFor, followUpExecIdFor, type SessionRuntime } from "./run.js";

/**
 * The session as a sub-agent's model, against a scripted container.
 *
 * What is this module's own is the order of the steps and what survives a
 * restart between them: a continued turn calls `doStream` again, and every step
 * already taken has to be found in storage rather than taken again.
 */

type Event = WorkspaceRuntimeEvent<"utf8">;
type CallOptions = Parameters<
  ReturnType<typeof claudeCodeModel>["doStream"]
>[0];

const RUN = "run-1";
const SESSION = execIdFor(RUN);
const FOLLOW_UP = followUpExecIdFor(RUN);

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const say = (id: string, seq: number, text: string): Event => ({
  id,
  seq,
  name: "stdout",
  value: line({
    type: "assistant",
    message: { content: [{ type: "text", text }] }
  })
});
const result = (id: string, seq: number, text = "done"): Event => ({
  id,
  seq,
  name: "stdout",
  value: line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "sess-1",
    total_cost_usd: 0.5,
    usage: {}
  })
});
const exit = (id: string, seq: number, code = 0): Event => ({
  id,
  seq,
  name: "exit",
  code
});

/** How a script ends once its events are read. */
type Ending = "close" | "hang" | "break";

/**
 * A container that runs each exec id's script. `getExec` replays from the
 * cursor's `seq`, as the runtime does; `busy` ids refuse a second spawn, which
 * is what a session still running after a lost isolate looks like.
 */
function container(
  scripts: Record<string, { events: Event[]; ending?: Ending }>
) {
  const calls = {
    exec: [] as { id: string; command: string }[],
    getExec: [] as { id: string; resume: unknown }[],
    killed: [] as string[]
  };
  const busy = new Set<string>();
  const handle = (id: string, events: Event[], ending: Ending) =>
    Object.assign(
      new ReadableStream<Event>({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          if (ending === "close") controller.close();
          if (ending === "break")
            controller.error(new Error("the isolate went away"));
        }
      }),
      { id, [Symbol.dispose]: () => {} }
    );
  const script = (id: string) => scripts[id] ?? { events: [] };

  const runtime = {
    exec: async (command: string, options: { id: string }) => {
      calls.exec.push({ id: options.id, command });
      if (busy.has(options.id))
        throw Object.assign(new Error("execution is running"), {
          code: "EEXEC_BUSY"
        });
      busy.add(options.id);
      const { events, ending = "close" } = script(options.id);
      return handle(options.id, events, ending);
    },
    getExec: async (id: string, options: { resume?: unknown }) => {
      calls.getExec.push({ id, resume: options.resume });
      const { events, ending = "close" } = script(id);
      const from = typeof options.resume === "number" ? options.resume : 0;
      return handle(
        id,
        events.filter((e) => e.seq > from),
        ending
      );
    },
    killExec: async (id: string) => {
      calls.killed.push(id);
    }
  } as unknown as SessionRuntime;

  return { runtime, calls, busy, scripts };
}

function memoryStorage() {
  const map = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
    },
    delete: async (key: string) => map.delete(key)
  } as unknown as DurableObjectStorage;
  return { map, storage };
}

function harness(
  box: ReturnType<typeof container>,
  over: Partial<ClaudeCodeModelOptions> = {}
) {
  const notes: { key: string; text: string }[] = [];
  const reports: SessionOutcome[] = [];
  const { map, storage } = memoryStorage();
  const options: ClaudeCodeModelOptions = {
    config: { credentials: () => ["sk-ant-oat01-REAL"] },
    workspace: async () => ({
      runtime: box.runtime,
      [Symbol.dispose]: () => {}
    }),
    storage,
    runId: RUN,
    kind: "write",
    dir: "/workspace/repo",
    note: async (key, text) => {
      notes.push({ key, text });
    },
    report: async (outcome) => {
      reports.push(outcome);
      return `report ${reports.length}`;
    },
    ...over
  };
  return { model: claudeCodeModel(options), notes, reports, map };
}

const call = (
  prompt: CallOptions["prompt"] = [
    { role: "system", content: "soul" },
    { role: "user", content: [{ type: "text", text: "fix the parser" }] }
  ],
  abortSignal?: AbortSignal
): CallOptions => ({ prompt, ...(abortSignal ? { abortSignal } : {}) });

async function streamed(
  model: ReturnType<typeof claudeCodeModel>,
  options: CallOptions = call()
) {
  const { stream } = await model.doStream(options);
  const parts: { type: string; delta?: string }[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value as { type: string; delta?: string });
  }
  return parts;
}

const textOf = (parts: { type: string; delta?: string }[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

describe("claudeCodeModel", () => {
  it("files each note as it goes, and streams the report as the only text", async () => {
    const box = container({
      [SESSION]: {
        events: [
          say(SESSION, 1, "reading the parser"),
          say(SESSION, 2, "fixing the off-by-one"),
          result(SESSION, 3),
          exit(SESSION, 4)
        ]
      }
    });
    const { model, notes, reports } = harness(box);

    const parts = await streamed(model);

    expect(notes).toEqual([
      { key: `${SESSION}:claude:0`, text: "reading the parser" },
      { key: `${SESSION}:claude:1`, text: "fixing the off-by-one" }
    ]);
    // Narration streamed as text would become the run's result.
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish"
    ]);
    expect(textOf(parts)).toBe("report 1");
    expect(reports[0]?.session.result?.sessionId).toBe("sess-1");
    expect(reports[0]?.followUp).toBeUndefined();
  });

  it("reports once, and a re-entry emits the stored report", async () => {
    const box = container({
      [SESSION]: { events: [result(SESSION, 1), exit(SESSION, 2)] }
    });
    const { model, reports } = harness(box);

    expect(textOf(await streamed(model))).toBe("report 1");
    expect(textOf(await streamed(model))).toBe("report 1");
    expect(reports).toHaveLength(1);
    expect(box.calls.exec).toHaveLength(1);
  });

  /**
   * An isolate lost mid-drain before any cursor was stored: the session is
   * still running under its id, so the continued turn attaches to it rather
   * than starting another, and reads it from the start. The notes it files
   * again carry the keys they had, which the transcript dedupes.
   */
  it("attaches to the running session after a restart, and loses no note", async () => {
    const box = container({
      [SESSION]: {
        events: [say(SESSION, 1, "one"), say(SESSION, 2, "two")],
        ending: "break"
      }
    });
    const brief = vi.fn(async (task: string) => `brief: ${task}`);
    const { model, notes } = harness(box, { brief });

    await expect(streamed(model)).rejects.toThrow(/isolate went away/);
    box.scripts[SESSION] = {
      events: [
        say(SESSION, 1, "one"),
        say(SESSION, 2, "two"),
        say(SESSION, 3, "three"),
        result(SESSION, 4),
        exit(SESSION, 5)
      ]
    };
    expect(textOf(await streamed(model))).toBe("report 1");

    expect(box.calls.exec.map((c) => c.id)).toEqual([SESSION, SESSION]);
    expect(box.calls.getExec).toEqual([{ id: SESSION, resume: 0 }]);
    expect(new Set(notes.map((n) => n.key))).toEqual(
      new Set([0, 1, 2].map((n) => `${SESSION}:claude:${n}`))
    );
    // The brief is asked once and kept: a restart does not re-decide it.
    expect(brief).toHaveBeenCalledTimes(1);
    expect(box.calls.exec[0]?.command).toContain("brief: fix the parser");
  });

  it("resumes from a stored cursor, filing only what follows it", async () => {
    const box = container({
      [SESSION]: {
        events: [
          say(SESSION, 1, "one"),
          say(SESSION, 2, "two"),
          say(SESSION, 3, "three"),
          result(SESSION, 4),
          exit(SESSION, 5)
        ]
      }
    });
    const { model, notes, map } = harness(box);
    map.set(`claude-code:${RUN}:brief`, "the brief");
    map.set(`claude-code:${RUN}:cursor`, {
      execId: SESSION,
      seq: 2,
      carry: "",
      emitted: 2
    });

    await streamed(model);

    expect(box.calls.exec).toEqual([]);
    expect(box.calls.getExec).toEqual([{ id: SESSION, resume: 2 }]);
    expect(notes).toEqual([{ key: `${SESSION}:claude:2`, text: "three" }]);
  });

  it("runs a follow-up in the same session, and reports both ends", async () => {
    const box = container({
      [SESSION]: { events: [result(SESSION, 1), exit(SESSION, 2)] },
      [FOLLOW_UP]: {
        events: [
          say(FOLLOW_UP, 1, "committing"),
          result(FOLLOW_UP, 2, "committed"),
          exit(FOLLOW_UP, 3)
        ]
      }
    });
    const followUp = vi.fn(async () => "commit what you left");
    const { model, notes, reports } = harness(box, { followUp });

    await streamed(model);

    expect(box.calls.exec.map((c) => c.id)).toEqual([SESSION, FOLLOW_UP]);
    expect(box.calls.exec[1]?.command).toContain("--resume sess-1");
    // Its own exec id leads its keys, so its first note is not the session's.
    expect(notes).toEqual([
      { key: `${FOLLOW_UP}:claude:0`, text: "committing" }
    ]);
    expect(reports[0]?.session.result?.text).toBe("done");
    expect(reports[0]?.followUp?.result?.text).toBe("committed");
  });

  it("asks for a follow-up once, and resumes it rather than asking again", async () => {
    const box = container({
      [SESSION]: { events: [result(SESSION, 1), exit(SESSION, 2)] },
      [FOLLOW_UP]: {
        events: [say(FOLLOW_UP, 1, "committing")],
        ending: "break"
      }
    });
    const followUp = vi.fn(async () => "commit what you left");
    const { model, reports } = harness(box, { followUp });

    await expect(streamed(model)).rejects.toThrow(/isolate went away/);
    box.scripts[FOLLOW_UP] = {
      events: [
        say(FOLLOW_UP, 1, "committing"),
        result(FOLLOW_UP, 2, "committed"),
        exit(FOLLOW_UP, 3)
      ]
    };
    await streamed(model);

    expect(followUp).toHaveBeenCalledTimes(1);
    // The session's own end was kept, so it is not drained again.
    expect(box.calls.exec.map((c) => c.id)).toEqual([
      SESSION,
      FOLLOW_UP,
      FOLLOW_UP
    ]);
    expect(reports[0]?.followUp?.result?.text).toBe("committed");
  });

  it("reports the session alone when no follow-up is asked for", async () => {
    const box = container({
      [SESSION]: { events: [result(SESSION, 1), exit(SESSION, 2)] }
    });
    const { model, reports } = harness(box, {
      followUp: async () => undefined
    });

    await streamed(model);

    expect(box.calls.exec.map((c) => c.id)).toEqual([SESSION]);
    expect(reports[0]?.followUp).toBeUndefined();
  });

  it("fails the run with the brief's refusal, and starts nothing", async () => {
    const box = container({});
    const { model } = harness(box, {
      brief: async () => {
        throw new Error("every credential is spent until 14:00");
      }
    });

    await expect(streamed(model)).rejects.toThrow(/spent until 14:00/);
    expect(box.calls.exec).toEqual([]);
  });

  /** A cancelled turn takes the session with it, follow-up and all. */
  it("stops the session when the turn is cancelled", async () => {
    const box = container({
      [SESSION]: { events: [say(SESSION, 1, "working")], ending: "hang" }
    });
    const { model } = harness(box);
    const cancel = new AbortController();

    const running = streamed(model, call(undefined, cancel.signal));
    await vi.waitFor(() => expect(box.calls.exec).toHaveLength(1));
    cancel.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow(/cancelled/);
    expect(box.calls.killed).toEqual([FOLLOW_UP, SESSION]);
  });

  /**
   * A continued turn's prompt ends with the interrupted assistant message, so
   * the task is the last *user* message, not the last message.
   */
  it("takes the task from the last user message", async () => {
    const box = container({
      [SESSION]: { events: [result(SESSION, 1), exit(SESSION, 2)] }
    });
    const brief = vi.fn(async (task: string) => task);
    const { model } = harness(box, { brief });

    await streamed(
      model,
      call([
        { role: "system", content: "soul" },
        { role: "user", content: [{ type: "text", text: "fix the parser" }] },
        { role: "assistant", content: [] }
      ])
    );

    expect(brief).toHaveBeenCalledWith("fix the parser");
  });
});
