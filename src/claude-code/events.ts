import type { ProgressEvent } from "@dynamicagents/core/subtasks";

/**
 * `claude -p --output-format stream-json` on the wire, turned into things this
 * package can act on.
 *
 * ## Pure, and stateless on purpose
 *
 * Nothing here remembers anything between calls. That is not minimalism — it is
 * what makes the drain re-entrant. A Claude Code run is drained in bounded
 * windows across several durable chunks, and a chunk that starts on a fresh
 * isolate re-attaches with `getExec(id, { resume: "tail" })`, which replays. A
 * parser holding a cursor would hand back a different answer depending on which
 * isolate asked, and the difference would show up as duplicated or missing
 * progress in the parent's context rather than as an error.
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
  text?: string;
  thinking?: string;
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
  | { kind: "init"; sessionId: string; model?: string }
  /**
   * The subscription bucket, as the client sees it. Carried rather than acted
   * on here — {@link describe} decides what a reader is told, and the caller
   * decides what the credential pool is told.
   */
  | { kind: "rateLimit"; info: RateLimitInfo }
  | { kind: "assistant"; text: string; tools: string[] }
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
 * Flatten an `assistant` message into a line of prose and the tools it called.
 *
 * `thinking` blocks are dropped. They are the model's private reasoning, they
 * are the largest thing in the stream by a wide margin, and the parent agent is
 * being shown progress rather than asked to review the subagent's deliberation.
 */
function readAssistant(message: Record<string, unknown>): {
  text: string;
  tools: string[];
} {
  const content = Array.isArray(message.content)
    ? (message.content as AssistantBlock[])
    : [];
  const text: string[] = [];
  const tools: string[] = [];

  for (const block of content) {
    if (!asRecord(block)) continue;
    const blockText = str(block.text);
    if (block.type === "text" && blockText) text.push(blockText.trim());
    const toolName = str(block.name);
    if (block.type === "tool_use" && toolName) tools.push(toolName);
  }

  return { text: text.join(" ").replace(/\s+/g, " ").trim(), tools };
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
 */
export function parseStream(buffer: string): ParsedStream {
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

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          const sessionId = str(event.session_id);
          if (!sessionId) {
            skip(trimmed);
            break;
          }
          const model = str(event.model);
          events.push({
            kind: "init",
            sessionId,
            ...(model ? { model } : {})
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
        const { text, tools } = readAssistant(message);
        if (!text && tools.length === 0) break;
        events.push({ kind: "assistant", text, tools });
        break;
      }

      // `user` messages on this stream are tool *results* being fed back to the
      // model, not anything a human said. They are large, they are already
      // summarised by the assistant turn that follows, and the un-nested ones
      // belong to the outer run's own tools — so they are deliberately not
      // surfaced as progress.
      case "user":
        break;

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
  }

  return { events, carry, skipped, nested, ...(sample ? { sample } : {}) };
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
    permissionDenials: denials
  };
}

/**
 * How much of an unrecognised line is kept for the logs.
 *
 * Read by a person deciding whether a schema moved, and the discriminating part
 * of a stream-json line is its `type` and `subtype`, both at the front.
 */
const SAMPLE_MAX_CHARS = 200;

/**
 * Turn events into progress notes the parent can post.
 *
 * **`from` is the number of notes already emitted for this run, and the key is
 * derived from it.** Not from the note's content, not from a clock, and not from
 * the Claude Code `uuid` — from position alone.
 *
 * The reason is replay. A chunk that dies mid-drain is retried by the Workflow,
 * the re-attach replays the tail, and the same assistant turn is parsed twice. A
 * content-derived key would make two identical notes collide *by luck* (and two
 * genuinely repeated notes — "Running tests" twice — collide wrongly). A
 * clock-derived key would never collide, so every replay would re-post
 * everything. Position is the only choice that dedupes exactly the events that
 * are the same event.
 */
export function toProgress(
  events: readonly ClaudeCodeEvent[],
  from: number
): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  let n = from;

  for (const event of events) {
    const text = describe(event);
    if (!text) continue;
    out.push({ key: `claude:${n}`, text });
    n++;
  }

  return out;
}

/** One line of progress, or nothing when the event is not worth a note. */
function describe(event: ClaudeCodeEvent): string | undefined {
  switch (event.kind) {
    // Tool calls are not narration. A turn that only called tools said nothing
    // the reader can act on, and it cost one Slack message per Bash/Read/Edit —
    // nine of them for a one-line README edit. The tool names added nothing to
    // the turns that *did* have text either, so the prefix goes with them.
    //
    // Same policy the in-process agents already apply in the gatekeeper
    // (src/agents/shared/loop.ts: "Tool-only steps stay silent in Slack").
    // Deliberately narrower than silencing the whole channel: `denied` and
    // `retry` below stay, because they are the only evidence of a session that
    // is being refused or throttled.
    //
    // Never clipped. A plan or a report cut mid-sentence reads as complete.
    case "assistant":
      return event.text || undefined;
    case "denied":
      // The one progress note that is more useful than the session's own
      // account of itself. A refused tool call is invisible in the transcript —
      // the model simply narrates an alternative approach — so without this the
      // parent sees a subagent being resourceful and never learns it was fenced
      // in. Named tool first, because that is what distinguishes a broken
      // configuration from a deny rule doing its job.
      return `permission denied${event.tool ? ` for ${event.tool}` : ""}: ${event.reason}`;
    case "retry":
      // Surfaced deliberately. This is what a budget refusal from the egress
      // gateway looks like from inside the container, and a run that ends
      // shortly afterwards is explained by it.
      return `retrying the model call: ${event.detail}`;
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
        : `the ${event.info.rateLimitType ?? "subscription"} limit reports "${event.info.status}"` +
            (event.info.resetsAt === undefined
              ? ""
              : ` until ${new Date(event.info.resetsAt * 1000).toISOString()}`);
    // `init` names a session id nobody outside this package can use, and
    // `result` is the terminal outcome the caller reports itself.
    case "init":
    case "result":
      return undefined;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
