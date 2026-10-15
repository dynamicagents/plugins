import type { NoteData } from "@dynamicagents/core/subagent";
import type { ClaudeCodeResult, RateLimitInfo } from "./events.js";

/**
 * What the daemon in a sandbox image and the host model must spell
 * identically, in one module both import. The harness stores a turn's messages
 * and its outcome, and nothing else the daemon reports, so everything the host
 * reads travels as one of those.
 */

/**
 * How one turn of a session ended. The harness keeps an operation's outcome as
 * one string — the text of a turn that was answered, or the reason one was not
 * — so the whole end travels in it: the CLI's own `result` line, the
 * subscription bucket it last reported, its session id, and for a process that
 * died with no result, its exit code and the end of its stderr.
 */
export interface RunEnd {
  result?: ClaudeCodeResult;
  rateLimit?: RateLimitInfo;
  sessionId?: string;
  /** Only when there is no `result`: the process ended without one. */
  exitCode?: number | null;
  stderr?: string;
}

/** The host the CLI is pointed at by `ANTHROPIC_BASE_URL`, which the sandbox intercepts. */
export const ANTHROPIC_PLACEHOLDER_HOST = "anthropic.harness.internal";

const END = "claude-code-end:";
const NOTE = "claude-code-note:";
const SESSION = "claude-code-session:";

export function encodeRunEnd(end: RunEnd): string {
  return `${END}${JSON.stringify(end)}`;
}

/** The end in `text`, or `undefined` for a string the daemon did not write — the harness's own `container_lost`, say. */
export function decodeRunEnd(text: string | undefined): RunEnd | undefined {
  return decode<RunEnd>(END, text);
}

/**
 * One transcript note, as one message's only text part.
 *
 * The daemon makes the note (`./events.ts` `toProgress`) rather than sending
 * the event, because a card clips its sections and an event does not: a tool's
 * output is whatever the tool printed, and the harness stores every message in
 * a row of the object's SQLite.
 */
export function encodeNote(note: NoteData): string {
  return `${NOTE}${JSON.stringify(note)}`;
}

export function decodeNote(text: string): NoteData | undefined {
  return decode<NoteData>(NOTE, text);
}

/**
 * The CLI's session id, as its own message: the handle a host records the
 * moment the `init` line names it, since a session that dies before its end
 * reports no other.
 */
export function encodeSessionId(sessionId: string): string {
  return `${SESSION}${JSON.stringify(sessionId)}`;
}

export function decodeSessionId(text: string): string | undefined {
  return decode<string>(SESSION, text);
}

function decode<T>(prefix: string, text: string | undefined): T | undefined {
  if (!text?.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(text.slice(prefix.length)) as T;
  } catch {
    return undefined;
  }
}
