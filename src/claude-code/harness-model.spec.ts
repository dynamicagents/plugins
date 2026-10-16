import { describe, expect, it } from "vitest";
import type { ContainerOperationResult } from "agents/harness/container";
import { SANDBOX_CONTRACT } from "../sandbox/constants.js";
import { readRunHeader } from "../sandbox/header.js";
import type { PolledMessage, PollResult } from "../sandbox/object.js";
import type { ClaudeCodeResult } from "./events.js";
import {
  claudeCodeHarnessModel,
  CONTAINER_LOST_PROMPT,
  type ClaudeCodeHarnessModelOptions,
  type SandboxRuns
} from "./harness-model.js";
import { encodeNote, encodeRunEnd, encodeSessionId } from "./harness-wire.js";
import type { SessionOutcome, SessionRecord } from "./model.js";

/**
 * The session as a sub-agent's model, over a scripted sandbox: what is this
 * module's own is the order of the steps, what survives a restart between
 * them, and what it submits when a container is lost.
 */

const RUN = "run-1";
const RESULT = {
  subtype: "success",
  isError: false,
  text: "the answer",
  sessionId: "sess-1",
  apiErrorStatus: null,
  costUsd: 0.1,
  usage: {},
  permissionDenials: 0
} as unknown as ClaudeCodeResult;

const message = (
  operationId: string,
  id: string,
  text: string
): PolledMessage => ({
  id: `${operationId}:${id}`,
  digest: id,
  message: {
    id: `${operationId}:${id}`,
    role: "assistant",
    parts: [{ type: "text", text }],
    operationId,
    createdAt: 0
  }
});
const session = (op: string, id = "sess-1") =>
  message(op, "session", encodeSessionId(id));
const note = (op: string, n: number, text: string) =>
  message(op, `claude:${n}`, encodeNote({ key: `claude:${n}`, text }));

type Turn = {
  messages: PolledMessage[];
  result?: Omit<ContainerOperationResult, "operationId" | "session">;
};
const done = (sessionId = "sess-1", exitCode = 0): Turn["result"] => ({
  status: "done",
  text: encodeRunEnd({ result: { ...RESULT, sessionId }, exitCode, sessionId })
});
const lost: Turn["result"] = { status: "unanswered", reason: "container_lost" };

/** A sandbox whose every operation is answered by `script`, in the order it is submitted. */
function sandbox(script: (operationId: string, attempt: number) => Turn) {
  const submits: { operationId: string; text: string }[] = [];
  const polls: { operationId: string; from: number }[] = [];
  const runs: { runId: string; options: object }[] = [];
  const turns = new Map<string, Turn>();
  let stops = 0;
  let failNext = 0;
  const runs_: SandboxRuns = {
    async createRun(runId, options) {
      runs.push({ runId, options });
    },
    async submit(_runId, text, operationId) {
      submits.push({ operationId, text });
      if (!turns.has(operationId))
        turns.set(operationId, script(operationId, submits.length - 1));
    },
    async poll(_runId, operationId, _waitMs, from = 0): Promise<PollResult> {
      polls.push({ operationId, from });
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("Network connection lost.");
      }
      const turn = turns.get(operationId) ?? { messages: [] };
      return {
        contract: SANDBOX_CONTRACT,
        messages: turn.messages.slice(from),
        next: turn.messages.length,
        ...(turn.result
          ? { result: { operationId, session: "h-1", ...turn.result } }
          : {})
      };
    },
    async stopRun() {
      stops += 1;
    }
  };
  return {
    runs: runs_,
    submits,
    polls,
    created: runs,
    stops: () => stops,
    failPolls: (n: number) => {
      failNext = n;
    }
  };
}

function memoryStorage() {
  const map = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
    }
  } as unknown as DurableObjectStorage;
  return { map, storage };
}

function harness(
  box: ReturnType<typeof sandbox>,
  over: Partial<ClaudeCodeHarnessModelOptions> = {}
) {
  const notes: { key: string; text: string }[] = [];
  const reports: SessionOutcome[] = [];
  const sessions: SessionRecord[] = [];
  const { map, storage } = memoryStorage();
  const options: ClaudeCodeHarnessModelOptions = {
    sandbox: () => box.runs,
    storage,
    runId: RUN,
    dir: "/workspace/repo",
    schema: "write",
    note: async (key, text) => {
      notes.push({ key, text });
    },
    onSession: async (record) => {
      sessions.push(record);
    },
    report: async (outcome) => {
      reports.push(outcome);
      return `report ${reports.length}`;
    },
    ...over
  };
  return {
    model: claudeCodeHarnessModel(options),
    notes,
    reports,
    sessions,
    map
  };
}

const call = (abortSignal?: AbortSignal) => ({
  prompt: [
    { role: "system" as const, content: "soul" },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "fix the parser" }]
    }
  ],
  ...(abortSignal ? { abortSignal } : {})
});

const textOf = async (
  model: ReturnType<typeof claudeCodeHarnessModel>,
  abort?: AbortSignal
) => {
  const result = await model.doGenerate(call(abort));
  const part = result.content[0];
  return part?.type === "text" ? part.text : undefined;
};

describe("claudeCodeHarnessModel", () => {
  it("runs the brief as one operation in the run's directory, files its notes, and reports once", async () => {
    const box = sandbox((op) => ({
      messages: [
        session(op),
        note(op, 0, "Session started"),
        note(op, 1, "found it")
      ],
      result: done()
    }));
    const { model, notes, reports, sessions } = harness(box);
    expect(await textOf(model)).toBe("report 1");

    expect(box.created).toEqual([
      { runId: RUN, options: { cwd: "/workspace/repo" } }
    ]);
    expect(box.submits).toHaveLength(1);
    const { header, prompt } = readRunHeader(box.submits[0]!.text);
    expect(box.submits[0]!.operationId).toBe(`${RUN}:session:a0`);
    expect(header).toEqual({
      cwd: "/workspace/repo",
      mode: "build",
      schema: "write"
    });
    expect(prompt).toBe("fix the parser");
    expect(notes.map((n) => n.key)).toEqual([
      `${RUN}:session:a0:claude:0`,
      `${RUN}:session:a0:claude:1`
    ]);
    expect(reports[0]?.session).toMatchObject({
      exitCode: 0,
      sessionId: "sess-1",
      result: { text: "the answer" }
    });
    expect(sessions[0]).toEqual({ sessionId: "sess-1" });
    expect(sessions.at(-1)?.end?.result?.text).toBe("the answer");

    // Once: a recovered turn reads the report back rather than running again.
    expect(await textOf(model)).toBe("report 1");
    expect(box.submits).toHaveLength(1);
  });

  it("resumes a session whose container was lost, in the same conversation, told what happened", async () => {
    const box = sandbox((op, n) =>
      n === 0
        ? { messages: [session(op), note(op, 0, "half-way")], result: lost }
        : { messages: [note(op, 0, "done now")], result: done() }
    );
    const { model, notes, reports } = harness(box);
    expect(await textOf(model)).toBe("report 1");
    expect(box.submits.map((s) => s.operationId)).toEqual([
      `${RUN}:session:a0`,
      `${RUN}:session:a1`
    ]);
    const resumed = readRunHeader(box.submits[1]!.text);
    expect(resumed.prompt).toBe(CONTAINER_LOST_PROMPT);
    expect(resumed.header?.cwd).toBe("/workspace/repo");
    expect(notes.map((n) => n.key)).toContain(
      `${RUN}:session:a0:container-lost`
    );
    expect(reports).toHaveLength(1);
  });

  it("submits the whole step again when the container was lost before the CLI started", async () => {
    const box = sandbox((op, n) =>
      n === 0
        ? { messages: [], result: lost }
        : { messages: [session(op)], result: done() }
    );
    const { model } = harness(box);
    await textOf(model);
    expect(readRunHeader(box.submits[1]!.text).prompt).toBe("fix the parser");
  });

  it("gives up on a turn that loses its container every time", async () => {
    const box = sandbox((op) => ({ messages: [session(op)], result: lost }));
    const { model, notes } = harness(box);
    await expect(textOf(model)).rejects.toThrow(/container_lost/);
    expect(box.submits).toHaveLength(4);
    expect(notes.map((n) => n.key)).toContain(`${RUN}:session:a3:lost`);
  });

  it("reports a session that ended without a result with its exit and stderr", async () => {
    const box = sandbox((op) => ({
      messages: [session(op)],
      result: {
        status: "unanswered",
        reason: encodeRunEnd({ exitCode: 1, stderr: "No conversation found" })
      }
    }));
    const { model, reports } = harness(box);
    await textOf(model);
    expect(reports[0]?.session).toEqual({
      exitCode: 1,
      stderr: "No conversation found",
      sessionId: "sess-1"
    });
  });

  it("stops the run when the turn is aborted, and ends it with the reason", async () => {
    const box = sandbox(() => ({ messages: [] }));
    const abort = new AbortController();
    const poll = box.runs.poll.bind(box.runs);
    box.runs.poll = async (...args) => {
      abort.abort(new Error("cancelled by the parent"));
      return poll(...args);
    };
    const { model, notes } = harness(box);
    await expect(textOf(model, abort.signal)).rejects.toThrow(
      /cancelled by the parent/
    );
    expect(box.stops()).toBe(1);
    expect(notes.map((n) => n.key)).toContain(`${RUN}:session:a0:lost`);
  });

  it("submits nothing for a turn aborted before it began", async () => {
    const box = sandbox(() => ({ messages: [] }));
    const { model } = harness(box);
    const abort = new AbortController();
    abort.abort(new Error("cancelled by the parent"));
    await expect(textOf(model, abort.signal)).rejects.toThrow(
      /cancelled by the parent/
    );
    expect(box.submits).toHaveLength(0);
    expect(box.stops()).toBe(0);
  });

  it("stops a recovered turn still running when the abort lands before it is polled", async () => {
    const box = sandbox(() => ({ messages: [] }));
    const { model, map, notes } = harness(box);
    // The last invocation submitted the turn, then its object was reset.
    map.set(`claude-code:${RUN}:turn:session`, {
      attempt: 0,
      startedAt: Date.now(),
      from: 0
    });
    const abort = new AbortController();
    abort.abort(new Error("cancelled by the parent"));
    await expect(textOf(model, abort.signal)).rejects.toThrow(
      /cancelled by the parent/
    );
    expect(box.stops()).toBe(1);
    expect(box.submits).toHaveLength(0);
    expect(notes.map((n) => n.key)).toContain(`${RUN}:session:a0:lost`);
  });

  it("carries on another run's conversation by forking it in the same sandbox", async () => {
    const box = sandbox((op) => ({
      messages: [session(op, "sess-2")],
      result: done("sess-2")
    }));
    const { model } = harness(box, {
      resume: { run: "plan-1", fork: true },
      permissionMode: "plan",
      schema: "plan"
    });
    await textOf(model);
    expect(box.created[0]?.options).toEqual({
      cwd: "/workspace/repo",
      forkOf: "plan-1"
    });
    expect(readRunHeader(box.submits[0]!.text).header).toEqual({
      cwd: "/workspace/repo",
      mode: "plan",
      schema: "plan",
      fork: true
    });
  });

  it("follows up as a second operation of the run, without the session's schema", async () => {
    const box = sandbox((op) => ({ messages: [session(op)], result: done() }));
    const { model, reports } = harness(box, {
      followUp: async () => "now push it"
    });
    await textOf(model);
    expect(box.submits.map((s) => s.operationId)).toEqual([
      `${RUN}:session:a0`,
      `${RUN}:follow-up:a0`
    ]);
    const followUp = readRunHeader(box.submits[1]!.text);
    expect(followUp.prompt).toBe("now push it");
    expect(followUp.header).toEqual({ cwd: "/workspace/repo", mode: "build" });
    expect(reports[0]?.followUp?.exitCode).toBe(0);
  });

  it("keeps a plan's schema on its follow-up, and counts the follow-up against the session's limit", async () => {
    const box = sandbox((op) => ({ messages: [session(op)], result: done() }));
    const { model, map } = harness(box, {
      permissionMode: "plan",
      schema: "plan",
      followUp: async () => "tighten step 2"
    });
    await textOf(model);
    expect(readRunHeader(box.submits[1]!.text).header).toEqual({
      cwd: "/workspace/repo",
      mode: "plan",
      schema: "plan"
    });
    const started = (step: string) =>
      (map.get(`claude-code:${RUN}:turn:${step}`) as { startedAt: number })
        .startedAt;
    expect(started("follow-up")).toBe(started("session"));
  });

  it("polls a note again that failed to file, rather than moving past it", async () => {
    const box = sandbox((op) => ({
      messages: [session(op), note(op, 0, "one"), note(op, 1, "two")],
      result: done()
    }));
    let failures = 1;
    const filed: string[] = [];
    const { model, reports } = harness(box, {
      note: async (key) => {
        if (key.endsWith("claude:0") && failures-- > 0)
          throw new Error("the parent is busy");
        filed.push(key);
      }
    });
    await textOf(model);
    expect(filed).toEqual([
      `${RUN}:session:a0:claude:0`,
      `${RUN}:session:a0:claude:1`
    ]);
    expect(box.polls.map((p) => p.from)).toEqual([0, 1]);
    expect(reports).toHaveLength(1);
  });

  it("stops a run aborted while its submission is still on the way", async () => {
    const box = sandbox(() => ({ messages: [] }));
    const abort = new AbortController();
    const submit = box.runs.submit.bind(box.runs);
    box.runs.submit = async (...args) => {
      abort.abort(new Error("cancelled by the parent"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      return submit(...args);
    };
    const { model } = harness(box);
    await expect(textOf(model, abort.signal)).rejects.toThrow(
      /cancelled by the parent/
    );
    expect(box.stops()).toBe(1);
  });

  it("asks only for messages it has not filed, and rides out a dropped call", async () => {
    let polled = 0;
    const box = sandbox((op) => ({
      messages: [session(op), note(op, 0, "one")]
    }));
    const { model } = harness(box);
    const original = box.runs.poll.bind(box.runs);
    box.runs.poll = async (...args) => {
      polled += 1;
      const answer = await original(...args);
      return polled >= 3
        ? {
            ...answer,
            result: { operationId: args[1], session: "h-1", ...done()! }
          }
        : answer;
    };
    box.failPolls(1);
    await textOf(model);
    // The dropped call, its retry, then on from what was filed.
    expect(box.polls.map((p) => p.from)).toEqual([0, 0, 2]);
  });

  it("does not brief a run that began on a workspace again", async () => {
    const box = sandbox(() => ({ messages: [], result: done() }));
    const { model, map } = harness(box);
    map.set(`claude-code:${RUN}:cursor`, { execId: "x", seq: 3 });
    await expect(textOf(model)).rejects.toThrow(
      /started in a workspace container/
    );
    expect(box.submits).toHaveLength(0);
  });
});
