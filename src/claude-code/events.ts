import type { NoteData } from "@dynamicagents/core/subagent";
import {
  initCard,
  resultCard,
  thinkingCard,
  toolCallCard,
  toolResultCard
} from "./cards.js";

/**
 * `claude -p --output-format stream-json` on the wire, turned into things this
 * package can act on.
 *
 * ## Pure, and stateless on purpose
 *
 * Nothing here remembers anything between calls. That is not minimalism — it is
 * what makes the drain re-entrant. A drain interrupted by an eviction or a
 * deploy re-attaches on a fresh isolate with `getExec(id, { resume: seq })`
 * from the last sequence it stored, and whatever arrived after that store is
 * read again. A parser holding a cursor would hand back a different answer
 * depending on which isolate asked, and the difference would show up as
 * duplicated or missing notes in the parent's transcript rather than as an
 * error.
 *
 * So the caller owns the position and passes it in. See {@link toProgress}.
 *
 * ## A malformed line is skipped, never thrown
 *
 * The stream is a vendor's, it is version-coupled (see the pinned image), and it
 * is the *only* record of what a run did. A parser that throws on one
 * unrecognised line discards the whole run's output to report a schema change,
 * which is the worst possible trade. Unparseable lines are counted instead —
 * {@link ParsedStream.skipped} — so a systematic change is visible in the logs
 * rather than silent, and a single corrupt line costs one line.
 */

/** Content blocks Claude Code emits inside an `assistant` message. */
interface AssistantBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** What a `result` line carries, of the fields anything here reads. */
export interface ClaudeCodeResult {
  /** `success`, or one of the `error_*` subtypes. */
  subtype: string;
  isError: boolean;
  /** The run's final answer. Empty is legal and is handled by the caller. */
  text: string;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  /** `null` on a clean run; an HTTP status when the API refused. */
  apiErrorStatus: number | null;
  costUsd: number;
  usage: ClaudeCodeUsage;
  /** How many inner subagents the run spawned — advisory, for the logs. */
  subagentsSpawned?: number;
  permissionDenials: number;
  /**
   * The answer of a session launched with a JSON Schema: the input of its
   * `StructuredOutput` call, which `text` then holds as a JSON string. Absent
   * for any other session, and for one that never made the call.
   */
  structured?: unknown;
  /**
   * What the CLI says went wrong, when it reports an error rather than an
   * answer.
   *
   * The only account there is of a refused resume: a `--resume` naming a
   * conversation the config directory does not hold ends in a `result` line with
   * no `text` at all, and `No conversation found with session ID: …` here. A
   * caller that reports such a run as a failed session rather than as "not
   * resumable" is reporting the one thing it was handed to say.
   */
  errors?: string[];
}

/**
 * Token counts, flattened.
 *
 * Cache reads and writes are separated because they are priced differently and
 * because they are the *bulk* of what a `claude -p` invocation bills: a
 * ten-call burst measured 20 raw input tokens against 187,130 cache reads. A
 * usage summary that folds them into one "input" number describes none of the
 * cost.
 */
export interface ClaudeCodeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What the client knows about the subscription bucket it is drawing on.
 *
 * The one thing on this stream that is about the *deployment* rather than the
 * run. This plugin's entry point describes the 5-hour and weekly limits as
 * routed around rather than predicted, because the gateway only learns a bucket
 * is empty when Anthropic refuses a request — this is the client saying so in
 * advance, on every session.
 *
 * `resetsAt` is **seconds**, not milliseconds, which is the one field here it is
 * possible to get silently wrong: a value handed to `Date` unconverted lands in
 * January 1970, and a credential marked spent until then reads as usable.
 */
export interface RateLimitInfo {
  /**
   * {@link RATE_LIMIT_OK} on a healthy bucket. Any other value is
   * **unclassified** — no consumer should read one as exhaustion.
   */
  status: string;
  /** Unix **seconds** at which this bucket refills. */
  resetsAt?: number;
  /** Which bucket — `five_hour`, and the weekly one. */
  rateLimitType?: string;
  /** Whether spend beyond the bucket is permitted, and why not. */
  overageStatus?: string;
  overageDisabledReason?: string;
}

export type ClaudeCodeEvent =
  | {
      kind: "init";
      sessionId: string;
      model?: string;
      cwd?: string;
      permissionMode?: string;
    }
  /**
   * The subscription bucket, as the client sees it. Carried rather than acted
   * on here — {@link describe} decides what a reader is told, and the caller
   * decides what the credential pool is told.
   */
  | { kind: "rateLimit"; info: RateLimitInfo }
  /** One `text` block of an assistant message, verbatim — it is markdown. */
  | { kind: "text"; text: string }
  /**
   * One `thinking` block, as how long it took — never what it said. A block can
   * run to thousands of tokens of private reasoning; a reader is told that the
   * model thought, and for how long, the way the CLI itself says it. Timed from
   * the line before it (see {@link ParsedStream.since}), and absent when no line
   * before it carried a time, as for a session's first turn.
   */
  | { kind: "thinking"; durationMs?: number }
  | { kind: "toolUse"; id: string; name: string; input: unknown }
  /**
   * One `tool_result` block of a `user` line: a tool's answer going back to
   * the model. `structured` is the line's `tool_use_result` — the tool's own
   * record of what it did, richer than the text the model reads — and is read
   * only when the line carries a single result, since it is not per block.
   */
  | {
      kind: "toolResult";
      id: string;
      isError: boolean;
      content: string;
      structured?: unknown;
    }
  | { kind: "retry"; detail: string }
  /**
   * A tool call the session was not allowed to make.
   *
   * Surfaced rather than counted, because the count is useless on its own and
   * the wording is the whole diagnosis: a session denied `Write` is
   * misconfigured, a session denied one `Bash(curl …)` by a deny rule is working
   * as intended, and `permissionDenials: 3` cannot tell them apart. This is the
   * event that says which.
   */
  | { kind: "denied"; tool?: string; reason: string }
  | { kind: "result"; result: ClaudeCodeResult };

export interface ParsedStream {
  events: ClaudeCodeEvent[];
  /**
   * Bytes after the last newline — an incomplete line the next read completes.
   *
   * A bounded-window drain reads whatever has arrived, which routinely cuts a
   * line in half. Parsing that half throws away a whole event; carrying it costs
   * one string.
   */
  carry: string;
  /** Lines that were not JSON, or were JSON of no recognised shape. */
  skipped: number;
  /**
   * The first skipped line, clipped — absent when nothing was skipped.
   *
   * A count alone says a schema moved and refuses to say how. That is the
   * position this package spent a production incident in: `skipped: 1` on every
   * single session, for days, naming nothing. One clipped line is the difference
   * between a warning an operator can act on and a warning they learn to scroll
   * past.
   *
   * Clipped rather than whole because an unrecognised line is exactly the one
   * with no size contract — and it lands in a log, not a context window.
   */
  sample?: string;
  /** Lines dropped for carrying `parent_tool_use_id`. See {@link parseStream}. */
  nested: number;
  /**
   * The `timestamp` of the last complete line that carried one, in epoch
   * milliseconds — what the next thinking block is timed from.
   *
   * Handed back to the next call with `carry`, and for the same reason: the
   * line a block is measured from may be one an earlier read parsed. The caller
   * keeps it on its cursor, so a drain resumed on another isolate times the
   * next block from the same line.
   */
  since?: number;
}

const EMPTY_USAGE: ClaudeCodeUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readUsage(raw: unknown): ClaudeCodeUsage {
  const usage = asRecord(raw);
  if (!usage) return { ...EMPTY_USAGE };
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens)
  };
}

/**
 * An `assistant` message as events, one per block, in the order it said them.
 *
 * Per block rather than flattened, because the blocks are different things to
 * a reader: prose, the model's reasoning, and each tool it called. A message
 * that only calls tools is as much progress as one that narrates.
 */
function readAssistant(
  message: Record<string, unknown>,
  thought: number | undefined
): ClaudeCodeEvent[] {
  const content = Array.isArray(message.content)
    ? (message.content as AssistantBlock[])
    : [];
  const events: ClaudeCodeEvent[] = [];

  for (const block of content) {
    if (!asRecord(block)) continue;
    if (block.type === "text") {
      // Trimmed only to ask whether it is empty: indentation is a code block's
      // and trailing spaces a hard break's, so the event keeps it verbatim.
      const text = str(block.text);
      if (text?.trim()) events.push({ kind: "text", text });
    } else if (block.type === "thinking") {
      events.push({
        kind: "thinking",
        ...(thought === undefined ? {} : { durationMs: thought })
      });
    } else if (block.type === "tool_use") {
      const id = str(block.id);
      const name = str(block.name);
      if (id && name)
        events.push({ kind: "toolUse", id, name, input: block.input });
    }
  }

  return events;
}

/**
 * A `user` line's tool results. Anything else a user line carries — the
 * prompt echoed back, a hook's note — is not a tool's answer and says nothing.
 */
function readToolResults(
  event: Record<string, unknown>,
  message: Record<string, unknown>
): ClaudeCodeEvent[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const results = content.filter(
    (block): block is Record<string, unknown> =>
      asRecord(block)?.type === "tool_result"
  );
  const structured = results.length === 1 ? event.tool_use_result : undefined;
  const events: ClaudeCodeEvent[] = [];
  for (const block of results) {
    const id = str(block.tool_use_id);
    if (!id) continue;
    events.push({
      kind: "toolResult",
      id,
      isError: block.is_error === true,
      content: resultText(block.content),
      ...(structured === undefined || structured === null ? {} : { structured })
    });
  }
  return events;
}

/**
 * A `tool_result` block's content as text. It is a string, or a list of
 * blocks of which only the text ones are readable here — an image a tool
 * returned is named, not carried.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (record?.type === "text") return str(record.text) ?? "";
      return record?.type ? `[${String(record.type)}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Read a `system`/`permission_denied` line into something worth reporting.
 *
 * Claude Code emits one per auto-denied tool call — the headless path denies
 * rather than prompts, so this is what a permission problem looks like from
 * outside the container. Three fields carry the answer and any of them may be
 * absent, so they are tried in order of how much they explain: the message the
 * model was given, then the deciding component's own words, then the bare
 * discriminator (`mode`, `rule`, `classifier`, `asyncAgent`).
 *
 * `agent_id` is deliberately not read. It marks a denial inside Claude Code's
 * own subagent tree, and unlike the `parent_tool_use_id` filter above there is
 * no case for dropping those: an inner subagent that cannot write is the same
 * misconfiguration as an outer one, discovered one level down.
 */
function readDenial(event: Record<string, unknown>): ClaudeCodeEvent {
  const tool = str(event.tool_name);
  const reason =
    str(event.message) ??
    str(event.decision_reason) ??
    str(event.decision_reason_type) ??
    "no reason given";
  return { kind: "denied", reason, ...(tool ? { tool } : {}) };
}

/**
 * Parse whatever has arrived so far into complete events plus a carry.
 *
 * **Messages carrying `parent_tool_use_id` are dropped**, and this is the single
 * most important line in the module. Claude Code runs its *own* subagents, and
 * every message one of them produces arrives on this same stream tagged with the
 * parent tool-use that spawned it. Forwarding those fills the Dynamic Agents
 * parent's context with the inner tree's chatter — which it can neither act on
 * nor cancel, because those subagents are invisible to Dynamic Agents'
 * scheduler. The tag is the only reliable way to tell the two apart, so it is
 * the filter.
 *
 * `result` and `init` are never nested and are read unconditionally.
 *
 * `since` is the last line's time from the previous call — see
 * {@link ParsedStream.since}.
 */
export function parseStream(buffer: string, since?: number): ParsedStream {
  const events: ClaudeCodeEvent[] = [];
  let skipped = 0;
  let nested = 0;
  let sample: string | undefined;

  /**
   * Count an unrecognised line, and remember the first one.
   *
   * First rather than last: a stream that has gone wrong systematically repeats
   * the same shape, and the earliest instance is the one closest to whatever
   * changed. Every `skipped++` in this function goes through here so that a
   * later branch cannot quietly count without sampling.
   */
  const skip = (line: string): void => {
    skipped++;
    sample ??= clip(line, SAMPLE_MAX_CHARS);
  };

  const newline = buffer.lastIndexOf("\n");
  const carry = newline === -1 ? buffer : buffer.slice(newline + 1);
  const complete = newline === -1 ? "" : buffer.slice(0, newline);

  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skip(trimmed);
      continue;
    }

    const event = asRecord(parsed);
    if (!event) {
      skip(trimmed);
      continue;
    }

    // The inner-subagent filter. Checked before the type switch so it applies to
    // every message shape, including ones added by a later Claude Code.
    if (str(event.parent_tool_use_id)) {
      nested++;
      continue;
    }

    const at = readTime(event.timestamp);

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          const sessionId = str(event.session_id);
          if (!sessionId) {
            skip(trimmed);
            break;
          }
          const model = str(event.model);
          const cwd = str(event.cwd);
          const permissionMode = str(event.permissionMode);
          events.push({
            kind: "init",
            sessionId,
            ...(model ? { model } : {}),
            ...(cwd ? { cwd } : {}),
            ...(permissionMode ? { permissionMode } : {})
          });
          break;
        }
        if (event.subtype === "permission_denied") {
          events.push(readDenial(event));
          break;
        }
        if (event.subtype === "api_retry") {
          events.push({
            kind: "retry",
            detail:
              str(event.error) ??
              str(event.message) ??
              `attempt ${num(event.attempt) || "?"}`
          });
          break;
        }
        // Other `system` subtypes are informational and grow between releases.
        // Not "skipped": nothing is wrong, there is simply nothing to say.
        //
        // That reading is right for the rest of them and was wrong for
        // `permission_denied` above, which sat in here for a release saying
        // nothing while every session in the deployment was being refused every
        // write. A new subtype belongs here only once somebody has read what it
        // carries; the default is silence, not the conclusion that it is noise.
        break;
      }

      case "assistant": {
        const message = asRecord(event.message);
        if (!message) {
          skip(trimmed);
          break;
        }
        // The model starts on a turn once the line before it is out — the
        // tool result it answers, or the text before it — so that line's time
        // is when this thinking began.
        const thought =
          at !== undefined && since !== undefined && at >= since
            ? at - since
            : undefined;
        events.push(...readAssistant(message, thought));
        break;
      }

      // `user` messages on this stream are tool *results* being fed back to the
      // model, not anything a human said — each one completes the card its call
      // opened.
      case "user": {
        const message = asRecord(event.message);
        if (message) events.push(...readToolResults(event, message));
        break;
      }

      case "result": {
        events.push({ kind: "result", result: readResult(event) });
        break;
      }

      /**
       * A top-level `type`, not a `system` subtype, so it is handled here and
       * not in the subtype switch above.
       *
       * The placement is load-bearing rather than tidy: everything this switch
       * does not name falls to `default`, which counts it as an unrecognised
       * line and warns. A recognised shape parsed in the wrong place is
       * therefore indistinguishable from a schema that moved — the drain reports
       * a steady `skipped` on every session, and the reading it is dropping is
       * the only free view of the subscription bucket anything here gets.
       */
      case "rate_limit_event": {
        const info = readRateLimit(event);
        if (!info) {
          skip(trimmed);
          break;
        }
        events.push({ kind: "rateLimit", info });
        break;
      }

      default:
        skip(trimmed);
    }

    if (at !== undefined) since = at;
  }

  return {
    events,
    carry,
    skipped,
    nested,
    ...(sample ? { sample } : {}),
    ...(since === undefined ? {} : { since })
  };
}

/**
 * Read a `rate_limit_event` line, or nothing when it carries no status.
 *
 * `status` is the only required field: it is what decides whether anything is
 * wrong, and a line without it says nothing this package can use — so it is
 * skipped and sampled like any other unrecognised shape, rather than recorded as
 * a bucket in an unknown state.
 */
function readRateLimit(
  event: Record<string, unknown>
): RateLimitInfo | undefined {
  const info = asRecord(event.rate_limit_info);
  const status = info && str(info.status);
  if (!info || !status) return undefined;

  const resetsAt = info.resetsAt;
  return {
    status,
    // Finite is not enough. `1e308` is finite, and seconds past the `Date` range
    // make `toISOString()` throw — inside `describe`, inside the drain's parse
    // loop, which would take a whole session down over one malformed vendor
    // field. The contract everywhere else here is to drop a bad line, not to
    // raise, so the check is "does this name a moment" rather than "is this a
    // number".
    ...(typeof resetsAt === "number" && isRealDate(resetsAt * 1000)
      ? { resetsAt }
      : {}),
    ...(str(info.rateLimitType)
      ? { rateLimitType: str(info.rateLimitType) }
      : {}),
    ...(str(info.overageStatus)
      ? { overageStatus: str(info.overageStatus) }
      : {}),
    ...(str(info.overageDisabledReason)
      ? { overageDisabledReason: str(info.overageDisabledReason) }
      : {})
  };
}

/** A line's `timestamp`, in epoch milliseconds, or `undefined`. */
function readTime(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether a millisecond value is one `Date` can actually represent. */
function isRealDate(ms: number): boolean {
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
}

/**
 * The status a healthy bucket reports, and the only one ever observed.
 *
 * **Every other value is unclassified, not a refusal.** Nothing here knows what
 * a non-`allowed` status means, and the one place that decides whether a
 * credential is spent — `readRateLimitEvent` in this package's `credentials.ts`
 * — recognises none of them, deliberately: retiring a working credential on a
 * guess is the expensive half of that trade. What an unrecognised status earns
 * is a note and a log, so somebody can name it.
 */
export const RATE_LIMIT_OK = "allowed";

/** Read a `result` line. Total by construction — a missing field reads as zero. */
function readResult(event: Record<string, unknown>): ClaudeCodeResult {
  const apiErrorStatus = event.api_error_status;
  const stats = asRecord(event.subagent_stats);
  const denials = Array.isArray(event.permission_denials)
    ? event.permission_denials.length
    : 0;
  const sessionId = str(event.session_id);
  const spawned = stats ? num(stats.spawned) : undefined;
  const errors = readErrors(event.errors);

  return {
    subtype: str(event.subtype) ?? "unknown",
    isError: event.is_error === true,
    text: typeof event.result === "string" ? event.result : "",
    ...(sessionId ? { sessionId } : {}),
    numTurns: num(event.num_turns),
    durationMs: num(event.duration_ms),
    apiErrorStatus: typeof apiErrorStatus === "number" ? apiErrorStatus : null,
    costUsd: num(event.total_cost_usd),
    usage: readUsage(event.usage),
    ...(spawned === undefined ? {} : { subagentsSpawned: spawned }),
    permissionDenials: denials,
    ...(errors.length > 0 ? { errors } : {}),
    ...(event.structured_output === undefined ||
    event.structured_output === null
      ? {}
      : { structured: event.structured_output })
  };
}

/**
 * A result line's `errors`, as sentences.
 *
 * **Anything that is not a string is stringified rather than dropped**, which is
 * the whole of the care this needs: the field is a vendor's, an entry carrying a
 * code and a message is a perfectly likely shape for it, and on the run this
 * exists to explain — a resume with nowhere to resume from — it is the only
 * account of what happened. Dropping an unexpected entry would report that run
 * as having failed for no stated reason.
 */
function readErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry : safeJson(entry)))
    .filter((entry) => entry.length > 0);
}

/** `value` as JSON, or as whatever `String` makes of it when it has no JSON. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * How much of an unrecognised line is kept for the logs.
 *
 * Read by a person deciding whether a schema moved, and the discriminating part
 * of a stream-json line is its `type` and `subtype`, both at the front.
 */
const SAMPLE_MAX_CHARS = 200;

/**
 * Turn events into progress notes for the parent's transcript.
 *
 * **`from` is the number of notes already emitted for this run, and the key is
 * derived from it.** Not from the note's content, not from a clock, and not from
 * the Claude Code `uuid` — from position alone.
 *
 * The reason is replay. A drain that dies mid-stream is resumed from the last
 * stored sequence, whatever arrived after it is read again, and the same
 * assistant turn is parsed twice. A
 * content-derived key would make two identical notes collide *by luck* (and two
 * genuinely repeated notes — "Running tests" twice — collide wrongly). A
 * clock-derived key would never collide, so every replay would re-post
 * everything. Position is the only choice that dedupes exactly the events that
 * are the same event.
 */
export function toProgress(
  events: readonly ClaudeCodeEvent[],
  from: number
): NoteData[] {
  const out: NoteData[] = [];
  let n = from;

  for (const event of events) {
    const note = describe(event);
    if (!note) continue;
    out.push({ key: `claude:${n}`, ...note });
    n++;
  }

  return out;
}

/** One note, or nothing when the event is not worth one. */
function describe(event: ClaudeCodeEvent): Omit<NoteData, "key"> | undefined {
  switch (event.kind) {
    // Never clipped. A plan or a report cut mid-sentence reads as complete.
    case "text":
      return { text: event.text };
    // Tool activity is a card, and a card never reaches the thread — core's
    // `transcribeNote` keeps it on the transcript — so a session's every Bash,
    // Read and Edit is shown without one message each in front of the person.
    // `./cards.ts` holds how each tool reads.
    case "toolUse":
      return toolCallCard(event.id, event.name, event.input);
    case "toolResult":
      return toolResultCard(event);
    case "thinking":
      return thinkingCard(event.durationMs);
    case "denied":
      // The one progress note that is more useful than the session's own
      // account of itself. A refused tool call is invisible in the transcript —
      // the model simply narrates an alternative approach — so without this the
      // parent sees a subagent being resourceful and never learns it was fenced
      // in. Named tool first, because that is what distinguishes a broken
      // configuration from a deny rule doing its job.
      return {
        text: `permission denied${event.tool ? ` for ${event.tool}` : ""}: ${event.reason}`
      };
    case "retry":
      // Surfaced deliberately. This is what a budget refusal from the egress
      // gateway looks like from inside the container, and a run that ends
      // shortly afterwards is explained by it.
      return { text: `retrying the model call: ${event.detail}` };
    case "rateLimit":
      /**
       * Silent while the bucket is fine, which is every line of a healthy
       * session — one note per `rate_limit_event` would be the noisiest thing on
       * the stream and would say "allowed" each time.
       *
       * The test is inverted deliberately: an unrecognised status produces a
       * note rather than silence. The statuses are a vendor's and only
       * {@link RATE_LIMIT_OK} has been seen, so a new one meaning "nearly out"
       * should surface as prose somebody reads, not be assumed benign.
       */
      return event.info.status === RATE_LIMIT_OK
        ? undefined
        : {
            text:
              `the ${event.info.rateLimitType ?? "subscription"} limit reports "${event.info.status}"` +
              (event.info.resetsAt === undefined
                ? ""
                : ` until ${new Date(event.info.resetsAt * 1000).toISOString()}`)
          };
    // `init`'s session id is a handle as well as news: it reaches the host on
    // the drain's cursor — see `DrainCursor.sessionId` in ./run.ts — where
    // something can record it and resume with it.
    case "init":
      return initCard(event);
    case "result":
      return resultCard(event.result);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
