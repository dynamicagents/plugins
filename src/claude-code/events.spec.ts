import { describe, it, expect } from "vitest";
import {
  parseStream,
  toProgress,
  RATE_LIMIT_OK,
  type ClaudeCodeEvent
} from "./events.js";
import capture from "../../test/fixtures/claude-code-probe-capture.json";
import { VERIFIED_CLAUDE_CODE_VERSION } from "./verified.js";

/**
 * The stream parser, and the three ways it can quietly ruin a run.
 *
 * It can **duplicate** — a resumed drain replays the tail, and a key that does
 * not collide re-files everything the parent already saw. It can **flood** — the
 * inner subagent tree talks on the same stream, and forwarding it fills the
 * parent's context with work the parent can neither read nor cancel. And it can
 * **lose everything** — one unrecognised line thrown from the parser discards
 * the whole run's only record of what it did.
 *
 * Each of those has a test below, because none of them looks like a failure at
 * the time.
 */

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const init = (sessionId = "sess-1") =>
  line({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "opus"
  });

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    ...extra
  });

/**
 * A `result` line with the field names Claude Code emits.
 *
 * Copied from a recorded run rather than invented, because every one of these
 * keys is a place a rename would break the cost accounting silently — the run
 * would still succeed and simply report spending nothing. The verified
 * version's own runs are checked below, from the probe's capture.
 */
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "the answer",
  session_id: "257ba51d-8527-438c-828e-9e273cfb02b7",
  num_turns: 1,
  duration_ms: 15_000,
  api_error_status: null,
  total_cost_usd: 0.0572045,
  permission_denials: [],
  subagent_stats: { spawned: 0 },
  usage: {
    input_tokens: 2,
    output_tokens: 685,
    cache_read_input_tokens: 18_713,
    cache_creation_input_tokens: 2_972
  }
};

describe("parseStream", () => {
  it("reads an init line and reports the session id", () => {
    const { events } = parseStream(init("abc"));
    expect(events).toEqual([{ kind: "init", sessionId: "abc", model: "opus" }]);
  });

  /**
   * A bounded-window drain reads whatever has arrived, which cuts a line in half
   * routinely rather than rarely. Parsing the half loses a whole event.
   */
  it("holds an incomplete trailing line back as carry", () => {
    const buffer = `${init()}{"type":"assist`;
    const { events, carry, skipped } = parseStream(buffer);

    expect(events).toHaveLength(1);
    expect(carry).toBe('{"type":"assist');
    // Emphatically not a skip: nothing is wrong with it yet.
    expect(skipped).toBe(0);
  });

  it("parses the line once the rest of it arrives", () => {
    const first = parseStream(`${init()}{"type":"assistant","message":`);
    const rest = `{"content":[{"type":"text","text":"done"}]}}\n`;
    const second = parseStream(first.carry + rest);

    expect(second.events).toEqual([{ kind: "text", text: "done" }]);
  });

  /**
   * The single most important line in the module. Claude Code runs its own
   * subagents and they talk on this same stream; they are invisible to Dynamic
   * Agents' scheduler and unreachable by its cancellation sweep, so their
   * chatter is noise the parent can neither act on nor stop.
   */
  it("drops messages belonging to Claude Code's own subagents", () => {
    const buffer =
      assistant("outer work") +
      assistant("inner chatter", { parent_tool_use_id: "toolu_123" }) +
      assistant("more outer work");

    const { events, nested } = parseStream(buffer);

    expect(events.map((e) => e.kind === "text" && e.text)).toEqual([
      "outer work",
      "more outer work"
    ]);
    expect(nested).toBe(1);
  });

  it("reads every block of a turn, in the order it said them", () => {
    const buffer = line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: " a deliberation " },
          {
            type: "text",
            text: "editing\n\n    indented code  \n- one\n- two"
          },
          { type: "text", text: "  \n " },
          { type: "tool_use", id: "toolu_1", name: "Edit", input: { a: 1 } },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
          // No id: nothing could complete its card.
          { type: "tool_use", name: "Read", input: {} }
        ]
      }
    });

    expect(parseStream(buffer).events).toEqual([
      { kind: "thinking", text: " a deliberation " },
      // Verbatim: it is markdown, and its indentation and line breaks are its
      // structure. A block of only whitespace says nothing.
      { kind: "text", text: "editing\n\n    indented code  \n- one\n- two" },
      { kind: "toolUse", id: "toolu_1", name: "Edit", input: { a: 1 } },
      { kind: "toolUse", id: "toolu_2", name: "Bash", input: {} }
    ]);
  });

  describe("a tool result coming back", () => {
    it("is read as a string or as text blocks, with is_error", () => {
      const buffer =
        line({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }
            ]
          }
        }) +
        line({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                is_error: true,
                content: [
                  { type: "text", text: "first" },
                  { type: "image", source: {} },
                  { type: "text", text: "second" }
                ]
              }
            ]
          }
        });

      expect(parseStream(buffer).events).toEqual([
        { kind: "toolResult", id: "toolu_1", isError: false, content: "ok" },
        {
          kind: "toolResult",
          id: "toolu_2",
          isError: true,
          content: "first\n[image]\nsecond"
        }
      ]);
    });

    it("carries the tool's own record, when the line holds one result", () => {
      const record = { stdout: "hi", stderr: "", interrupted: false };
      const one = line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "hi" }
          ]
        },
        tool_use_result: record
      });
      const two = line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "b" }
          ]
        },
        tool_use_result: record
      });

      expect(parseStream(one).events).toEqual([
        expect.objectContaining({ id: "toolu_1", structured: record })
      ]);
      // Not per block, so it belongs to neither of two.
      expect(
        parseStream(two).events.some((event) => "structured" in event)
      ).toBe(false);
    });

    it("says nothing for a user line that is not a tool's answer", () => {
      const buffer = line({
        type: "user",
        message: { content: [{ type: "text", text: "the prompt" }] }
      });
      expect(parseStream(buffer).events).toEqual([]);
    });
  });

  it("surfaces an api_retry, which is what a budget refusal looks like", () => {
    const buffer = line({
      type: "system",
      subtype: "api_retry",
      error: "rate_limit",
      attempt: 2
    });

    expect(parseStream(buffer).events).toEqual([
      { kind: "retry", detail: "rate_limit" }
    ]);
  });

  /**
   * The stream is a vendor's and it is version-coupled. Throwing on one bad line
   * would discard a whole run's output to report a schema change.
   */
  it("skips a malformed line instead of throwing, and counts it", () => {
    const buffer = `not json at all\n${init()}{"type":"nonsense"}\n`;
    const { events, skipped } = parseStream(buffer);

    expect(events).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  /**
   * A count alone told an operator that something was being dropped and nothing
   * about what — so `skipped: 1` fired on every session in a deployment for a
   * release and was read as noise. The first line is kept because a stream that
   * has gone wrong repeats the same shape, and the earliest instance is closest
   * to whatever changed.
   */
  it("keeps the first skipped line so the warning can be acted on", () => {
    const buffer = `${line({ type: "control_request", subtype: "can_use_tool" })}not json\n`;
    const { skipped, sample } = parseStream(buffer);

    expect(skipped).toBe(2);
    expect(sample).toContain("can_use_tool");
  });

  it("offers no sample when nothing was skipped", () => {
    expect(parseStream(init()).sample).toBeUndefined();
  });

  it("clips a runaway line rather than logging the whole of it", () => {
    const { sample } = parseStream(`${"z".repeat(5_000)}\n`);

    expect(sample?.length).toBeLessThanOrEqual(200);
    expect(sample?.endsWith("…")).toBe(true);
  });

  it("is silent about system subtypes it does not recognise", () => {
    // Not a skip — nothing is wrong, there is simply nothing to say. Counting
    // these would make the skip signal useless as soon as a release adds one.
    const buffer = line({ type: "system", subtype: "something_new" });
    const { events, skipped } = parseStream(buffer);

    expect(events).toEqual([]);
    expect(skipped).toBe(0);
  });

  /**
   * The subtype that spent a release inside "informational", saying nothing
   * while every session in the deployment was refused every write.
   *
   * A refused tool call is invisible in the transcript — the model narrates an
   * alternative approach and moves on — so this line is the only place a
   * permission problem is stated rather than inferred.
   */
  describe("a denied tool call", () => {
    const denial = (over: Record<string, unknown> = {}) =>
      line({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "toolu_1",
        decision_reason_type: "mode",
        decision_reason: "permission mode is default",
        message: "Claude requested permissions to use Write",
        ...over
      });

    it("names the tool and what it was told", () => {
      const { events, skipped } = parseStream(denial());

      expect(skipped).toBe(0);
      expect(events).toEqual([
        {
          kind: "denied",
          tool: "Write",
          reason: "Claude requested permissions to use Write"
        }
      ]);
    });

    it("falls back through the reasons a denial may carry", () => {
      const [withReason] = parseStream(denial({ message: undefined })).events;
      expect(withReason).toMatchObject({
        reason: "permission mode is default"
      });

      const [withType] = parseStream(
        denial({ message: undefined, decision_reason: undefined })
      ).events;
      expect(withType).toMatchObject({ reason: "mode" });

      const [bare] = parseStream(
        line({ type: "system", subtype: "permission_denied" })
      ).events;
      expect(bare).toEqual({ kind: "denied", reason: "no reason given" });
    });

    /**
     * Unlike the `parent_tool_use_id` filter, an inner subagent's denial is kept.
     * A subagent that cannot write is the same misconfiguration as the outer
     * session, found one level down — dropping it would hide the fault in
     * exactly the runs that delegate.
     */
    it("keeps a denial raised inside Claude Code's own subagent tree", () => {
      const { events } = parseStream(denial({ agent_id: "agent-3" }));
      expect(events).toHaveLength(1);
    });

    it("reaches the parent as a progress note", () => {
      const notes = toProgress(parseStream(denial()).events, 0);
      expect(notes.map((n) => n.text)).toEqual([
        "permission denied for Write: Claude requested permissions to use Write"
      ]);
    });
  });

  describe("the result line", () => {
    it("reads every field the cost accounting depends on", () => {
      const { events } = parseStream(line(RESULT));
      expect(events).toHaveLength(1);
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result).toEqual({
        subtype: "success",
        isError: false,
        text: "the answer",
        sessionId: "257ba51d-8527-438c-828e-9e273cfb02b7",
        numTurns: 1,
        durationMs: 15_000,
        apiErrorStatus: null,
        costUsd: 0.0572045,
        subagentsSpawned: 0,
        permissionDenials: 0,
        usage: {
          input: 2,
          output: 685,
          cacheRead: 18_713,
          cacheWrite: 2_972
        }
      });
    });

    /**
     * Cache reads were 18,713 against 2 raw input tokens on this very call.
     * Folding them into one "input" number would describe none of the cost, and
     * the budget governor meters from exactly this event.
     */
    it("keeps cache reads and writes apart", () => {
      const { events } = parseStream(line(RESULT));
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;
      expect(event.result.usage.cacheRead).toBeGreaterThan(
        event.result.usage.input * 1000
      );
    });

    it("reports an error subtype without inventing a cost", () => {
      const { events } = parseStream(
        line({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          api_error_status: 429
        })
      );
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result.subtype).toBe("error_max_turns");
      expect(event.result.isError).toBe(true);
      expect(event.result.apiErrorStatus).toBe(429);
      expect(event.result.costUsd).toBe(0);
      expect(event.result.text).toBe("");
    });

    /**
     * A `--resume` naming a conversation the config directory does not hold.
     * The CLI gives up in milliseconds, having called nothing and spent nothing,
     * and this line is the entire account of why — so a caller that cannot read
     * `errors` reports a session that failed for no stated reason, when what
     * actually happened is that there was nothing to resume.
     */
    it("reads the errors a refused resume reports, since nothing else explains it", () => {
      const { events } = parseStream(
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["No conversation found with session ID: sess-gone"],
          session_id: "sess-new",
          api_error_status: null
        })
      );
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result.errors).toEqual([
        "No conversation found with session ID: sess-gone"
      ]);
      expect(event.result.text).toBe("");
    });

    it("says nothing about errors on a run that had none", () => {
      const { events } = parseStream(line(RESULT));
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;
      expect(event.result.errors).toBeUndefined();
    });

    /**
     * The field is a vendor's, and an entry carrying a code and a message is a
     * likely shape for it. Dropping one would throw away the only account of the
     * failure it describes.
     */
    it("keeps an entry that is not a string rather than dropping it", () => {
      const { events } = parseStream(
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [{ code: "ENOENT", message: "no such conversation" }, "", 7]
        })
      );
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result.errors).toEqual([
        '{"code":"ENOENT","message":"no such conversation"}',
        "7"
      ]);
    });
  });
});

describe("toProgress", () => {
  it("keys notes by position, continuing from where the last drain stopped", () => {
    const { events } = parseStream(assistant("one") + assistant("two"));

    expect(toProgress(events, 0).map((p) => p.key)).toEqual([
      "claude:0",
      "claude:1"
    ]);
    expect(toProgress(events, 7).map((p) => p.key)).toEqual([
      "claude:7",
      "claude:8"
    ]);
  });

  /**
   * The replay case, and the reason the key is positional.
   *
   * A drain that dies mid-stream is resumed, the re-attach replays the tail, and
   * the same turns are parsed again. Re-parsing from the same offset must
   * produce the same keys, so the transcript drops the repeats.
   */
  it("produces identical keys when a replayed tail is parsed twice", () => {
    const tail = assistant("running tests") + assistant("running tests");
    const first = toProgress(parseStream(tail).events, 4);
    const second = toProgress(parseStream(tail).events, 4);

    expect(second).toEqual(first);
    // And two *genuinely* repeated notes still get distinct keys — a
    // content-derived key would have collapsed these into one.
    expect(first.map((p) => p.key)).toEqual(["claude:4", "claude:5"]);
  });

  it("marks a session's start and end as cards", () => {
    const { events } = parseStream(init() + line(RESULT));
    expect(toProgress(events, 0)).toEqual([
      {
        key: "claude:0",
        text: "Session started · opus",
        detail: { title: "Session" }
      },
      {
        key: "claude:1",
        text: "Session finished · 1 turn · 15s",
        detail: { title: "Session", status: "ok" }
      }
    ]);
  });

  /**
   * The seven silent minutes this exists for: a session reading and searching
   * for a long stretch says nothing in prose, and every one of those calls is
   * the progress a reader came to the transcript for. Each is a card — which
   * never reaches the thread, so this is not one Slack message per call.
   */
  it("files a card per call for a turn that only calls tools, and its result completes it", () => {
    const buffer =
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "npm test", description: "Run the suite" }
            },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "Read",
              input: { file_path: "src/a.ts" }
            }
          ]
        }
      }) +
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "1 passed" }
          ]
        },
        tool_use_result: { stdout: "1 passed", stderr: "", interrupted: false }
      });

    expect(toProgress(parseStream(buffer).events, 0)).toEqual([
      {
        key: "claude:0",
        text: "Run the suite",
        detail: {
          ref: "toolu_1",
          status: "running",
          title: "Bash",
          sections: [{ label: "Command", body: "npm test", format: "code" }]
        }
      },
      {
        key: "claude:1",
        text: "src/a.ts",
        detail: { ref: "toolu_2", status: "running", title: "Read" }
      },
      {
        key: "claude:2",
        text: "1 passed",
        detail: {
          ref: "toolu_1",
          status: "ok",
          sections: [{ label: "Output", body: "1 passed", format: "code" }]
        }
      }
    ]);
  });

  it("posts a long turn whole", () => {
    const text = `${"x".repeat(20_000)}.`;
    const note = toProgress(parseStream(assistant(text)).events, 0);

    expect(note[0]!.text).toBe(text);
    expect(note[0]!.detail).toBeUndefined();
  });

  it("posts a long denial reason and retry detail whole", () => {
    const reason = "r".repeat(20_000);
    const detail = "d".repeat(20_000);
    const [denied, retry] = toProgress(
      [
        { kind: "denied", tool: "Bash", reason },
        { kind: "retry", detail }
      ],
      0
    );

    expect(denied!.text).toBe(`permission denied for Bash: ${reason}`);
    expect(retry!.text).toBe(`retrying the model call: ${detail}`);
  });
});

describe("rate_limit_event", () => {
  /**
   * Captured from production, not invented.
   *
   * This exact line was skipped twice in one thirteen-minute session and counted
   * as `skipped: 1` on every session before that — the sample on the warning is
   * what turned it from background noise into a schema anyone could read. Keeping
   * the real shape is what makes this spec worth having: a hand-written
   * approximation would pass while the field names drifted.
   */
  const CAPTURED = line({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1789587600,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled_until"
    }
  });

  it("reads the captured line instead of counting it as a schema change", () => {
    const parsed = parseStream(CAPTURED);
    expect(parsed.skipped).toBe(0);
    expect(parsed.sample).toBeUndefined();
    expect(parsed.events).toEqual([
      {
        kind: "rateLimit",
        info: {
          status: RATE_LIMIT_OK,
          resetsAt: 1789587600,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled_until"
        }
      }
    ]);
  });

  it("says nothing while the bucket is allowing requests", () => {
    // Every line of a healthy session carries this. A note apiece would be the
    // noisiest thing on the stream, and each one would say "allowed".
    expect(toProgress(parseStream(CAPTURED).events, 0)).toEqual([]);
  });

  it("surfaces an unrecognised status rather than assuming it is benign", () => {
    const notes = toProgress(
      parseStream(
        line({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            resetsAt: 1789587600,
            rateLimitType: "five_hour"
          }
        })
      ).events,
      4
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.key).toBe("claude:4");
    // Seconds, not milliseconds — the one field here it is possible to get
    // silently wrong, and the wrong reading lands in January 1970.
    // Quotes the status rather than asserting it: nothing here knows what a
    // non-`allowed` value means, and prose that reads as a verdict is how a
    // healthy credential gets retired by the next person to act on it.
    expect(notes[0]!.text).toBe(
      'the five_hour limit reports "rejected" until 2026-09-16T19:40:00.000Z'
    );
  });

  it("drops a reset that is not a moment, instead of throwing on it", () => {
    /**
     * `1e308` is finite, and a finite number of seconds can still be past what
     * `Date` represents. Kept, it reaches `toISOString()` inside the drain's
     * parse loop and throws — taking down a whole session over one malformed
     * vendor field, in a parser whose entire contract is to drop a bad line.
     */
    const parsed = parseStream(
      line({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1e308 }
      })
    );

    expect(parsed.events).toEqual([
      { kind: "rateLimit", info: { status: "rejected" } }
    ]);
    expect(() => toProgress(parsed.events, 0)).not.toThrow();
    expect(toProgress(parsed.events, 0)[0]!.text).toBe(
      'the subscription limit reports "rejected"'
    );
  });

  it("skips a line carrying no status, rather than recording an unknown bucket", () => {
    const parsed = parseStream(
      line({ type: "rate_limit_event", rate_limit_info: { resetsAt: 1 } })
    );
    expect(parsed.events).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });
});

describe("a session launched with a JSON Schema", () => {
  it("reads its answer as structured, beside the text that holds it as JSON", () => {
    const answer = { title: "the plan" };
    const { events } = parseStream(
      line({
        ...RESULT,
        result: JSON.stringify(answer),
        structured_output: answer
      })
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "result",
        result: expect.objectContaining({
          text: JSON.stringify(answer),
          structured: answer
        })
      })
    ]);
  });

  it("has none when the session never answered through it", () => {
    const { events } = parseStream(line(RESULT));
    expect(events[0]).toMatchObject({ kind: "result" });
    expect(
      events[0]?.kind === "result" && "structured" in events[0].result
    ).toBe(false);
  });
});

/**
 * The verified version's own runs, recorded by the probe against a fake API
 * whose reply and token counts are in the capture beside them. The parser reads
 * a result "total by construction" — a renamed field reads as zero rather than
 * failing — so knowing what the counts should be is what makes a rename visible.
 */
describe("the verified version's recorded runs", () => {
  const runs = Object.entries(capture.runs);
  /**
   * The one recorded run that is meant to fail: a `--resume` naming a
   * conversation the config directory does not hold. It answers none of the
   * questions below about a reply or its cost, and answers one of its own.
   */
  const REFUSED = "unresumable";
  const answered = runs.filter(([run]) => run !== REFUSED);
  const parse = (lines: string[]) =>
    parseStream(lines.map((l) => `${l}\n`).join(""));

  /** The two are written together; a partial record or a merge can part them. */
  it("are the verified version's", () => {
    expect(capture.version).toBe(VERIFIED_CLAUDE_CODE_VERSION);
  });

  it.each(runs)("reads every line of the %s run", (_, lines) => {
    const parsed = parse(lines);
    expect(parsed.skipped).toBe(0);
    expect(parsed.sample).toBeUndefined();
  });

  /**
   * What a host has to report as "not resumable" rather than as a failed
   * session: the run cost nothing, so the only thing to pass on is this.
   */
  it("reads the refused resume's reason off its result line", () => {
    const { events } = parse(capture.runs[REFUSED]);
    const result = events.find((event) => event.kind === "result");

    expect(result?.kind === "result" && result.result.isError).toBe(true);
    expect(
      result?.kind === "result" && result.result.errors?.length
    ).toBeGreaterThan(0);
  });

  it.each(answered)(
    "reads the %s run's result, counts included",
    (run, lines) => {
      const { events } = parse(lines);
      const result = events.find((event) => event.kind === "result");
      const { usage, reply, structured } = capture.fake;

      expect(result?.kind === "result" && result.result).toMatchObject({
        isError: false,
        // The structured run answers through `StructuredOutput`, and its text is
        // that answer as JSON.
        ...(run === "structured"
          ? { structured, text: JSON.stringify(structured) }
          : { text: reply }),
        usage: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens
        }
      });
    }
  );
});
