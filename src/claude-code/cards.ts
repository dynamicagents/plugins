import {
  clipEntryBody,
  type ArtifactEntryDetail,
  type ChecklistItem,
  type EntrySection
} from "@dynamicagents/core/artifacts";
import type { ClaudeCodeEvent, ClaudeCodeResult } from "./events.js";

/**
 * A Claude Code session's stream as cards on its parent's transcript — the
 * only place in this package that knows what each of the CLI's tools is.
 *
 * Modelled on how the CLI shows them itself: a tool and the thing it acted on
 * on one line, the input and the output folded beneath. A tool's call and its
 * result are two cards sharing the tool-use id as their `ref`, and the
 * transcript folds the second into the first — see core's
 * `ArtifactEntryDetail`. Both are pure functions of one event, because the
 * drain that calls them is re-entrant (see `./events.ts`): a result is
 * formatted from its own line, never from the call it answers.
 *
 * Every section is clipped here, before the note is persisted anywhere — see
 * core's `ENTRY_SECTION_MAX_CHARS` for the ceiling that protects.
 */

/** A note's text and its card. */
export interface Card {
  text: string;
  detail: ArtifactEntryDetail;
}

/** The most of a summary line a card's head shows. */
const SUMMARY_MAX_CHARS = 120;

type ToolResultEvent = Extract<ClaudeCodeEvent, { kind: "toolResult" }>;
type InitEvent = Extract<ClaudeCodeEvent, { kind: "init" }>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The first line of `text`, clipped to a card's head. */
function oneLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** The most of a path's end a card's head keeps. */
const PATH_SEGMENTS = 3;

/**
 * A path as a card's head shows it: its last segments, since the head is one
 * line and clips at its end — where the file's name is. A checkout's absolute
 * prefix is the same on every card and tells a reader nothing.
 */
function shortPath(path: string | undefined): string | undefined {
  if (!path?.startsWith("/")) return path;
  const parts = path.split("/").filter(Boolean);
  return parts.length > PATH_SEGMENTS + 1
    ? `…/${parts.slice(-PATH_SEGMENTS).join("/")}`
    : path;
}

function section(
  label: string,
  body: string,
  format: EntrySection["format"]
): EntrySection {
  return { label, body: clipEntryBody(body), ...(format ? { format } : {}) };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The input, minus fields already on the head, or nothing when that is all. */
function rest(input: Record<string, unknown>, shown: string[]): string {
  const left = Object.fromEntries(
    Object.entries(input).filter(([key]) => !shown.includes(key))
  );
  return Object.keys(left).length > 0 ? json(left) : "";
}

/** `old` replaced by `next`, as the lines a diff section colours. */
function replacement(old: string, next: string): string {
  const minus = old ? old.split("\n").map((line) => `-${line}`) : [];
  const plus = next ? next.split("\n").map((line) => `+${line}`) : [];
  return [...minus, ...plus].join("\n");
}

const TODO_STATES: Record<string, ChecklistItem["state"]> = {
  completed: "done",
  in_progress: "active",
  pending: "pending"
};

/** A `TodoWrite` list as a checklist. The active item reads as its `activeForm`. */
function todos(input: Record<string, unknown>): ChecklistItem[] {
  const list = Array.isArray(input.todos) ? input.todos : [];
  const items: ChecklistItem[] = [];
  for (const raw of list) {
    const todo = record(raw);
    const state = TODO_STATES[str(todo.status) ?? ""];
    const text =
      (state === "active" ? str(todo.activeForm) : undefined) ??
      str(todo.content);
    if (state && text) items.push({ text, state });
  }
  return items;
}

/** A tool call: the card its result will complete. */
export function toolCallCard(id: string, name: string, raw: unknown): Card {
  const input = record(raw);
  const open = (
    title: string,
    text: string | undefined,
    extra: Omit<ArtifactEntryDetail, "ref" | "status" | "title"> = {}
  ): Card => ({
    text: oneLine(text ?? "") || title,
    detail: { ref: id, status: "running", title, ...extra }
  });
  const path = shortPath(str(input.file_path) ?? str(input.notebook_path));

  switch (name) {
    case "Bash": {
      const command = str(input.command) ?? "";
      return open("Bash", str(input.description) ?? command, {
        sections: [section("Command", command, "code")]
      });
    }
    case "Read": {
      const offset = typeof input.offset === "number" ? input.offset : 0;
      const limit = typeof input.limit === "number" ? input.limit : 0;
      const range =
        offset || limit
          ? ` · lines ${offset || 1}–${limit ? (offset || 1) + limit - 1 : "end"}`
          : "";
      return open("Read", path && `${path}${range}`);
    }
    case "Edit":
      return open("Update", path, {
        sections: [
          section(
            "Diff",
            replacement(
              str(input.old_string) ?? "",
              str(input.new_string) ?? ""
            ),
            "diff"
          )
        ]
      });
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const diff = edits
        .map((edit, n) => {
          const one = record(edit);
          return `@@ edit ${n + 1} @@\n${replacement(str(one.old_string) ?? "", str(one.new_string) ?? "")}`;
        })
        .join("\n");
      return open("Update", path, {
        sections: [section("Diff", diff, "diff")]
      });
    }
    case "Write":
      return open("Write", path, {
        sections: [section("Content", str(input.content) ?? "", "code")]
      });
    case "NotebookEdit":
      return open("NotebookEdit", path, {
        sections: [section("Source", str(input.new_source) ?? "", "code")]
      });
    case "Grep":
    case "Glob": {
      const pattern = str(input.pattern) ?? "";
      const where = shortPath(str(input.path));
      const extra = rest(input, ["pattern", "path"]);
      return open(
        name === "Grep" ? "Search" : "Glob",
        `${pattern}${where ? ` in ${where}` : ""}`,
        extra ? { sections: [section("Options", extra, "code")] } : {}
      );
    }
    case "WebFetch":
      return open("Fetch", str(input.url), {
        sections: [section("Prompt", str(input.prompt) ?? "", "text")]
      });
    case "WebSearch":
      return open("Web Search", str(input.query));
    case "Task":
    case "Agent":
      return open(str(input.subagent_type) ?? "Task", str(input.description), {
        sections: [section("Prompt", str(input.prompt) ?? "", "markdown")]
      });
    case "TodoWrite": {
      const items = todos(input);
      const done = items.filter((item) => item.state === "done").length;
      const active = items.find((item) => item.state === "active");
      return open(
        "Todos",
        `${active ? `${active.text} · ` : ""}${done}/${items.length} done`,
        { checklist: items }
      );
    }
    case "ExitPlanMode":
      return open("Plan", "the plan, for approval", {
        sections: [section("Plan", str(input.plan) ?? "", "markdown")]
      });
    default: {
      const first = Object.values(input).find(
        (value): value is string => typeof value === "string"
      );
      const body = Object.keys(input).length > 0 ? json(input) : "";
      return open(name, first, {
        ...(body ? { sections: [section("Input", body, "code")] } : {})
      });
    }
  }
}

/**
 * A tool's result: the half that completes its call's card.
 *
 * Read off the tool's own record (`structured`) where it has one, and off the
 * text the model was given where it does not. The record's shape is what
 * names the tool — the result line carries only the call's id.
 */
export function toolResultCard(event: ToolResultEvent): Card {
  const done = (sections: EntrySection[]): Card => ({
    text: oneLine(event.content) || "result",
    detail: {
      ref: event.id,
      status: event.isError ? "error" : "ok",
      ...(sections.length > 0 ? { sections } : {})
    }
  });
  if (event.isError) return done([section("Error", event.content, "text")]);

  const result = record(event.structured);
  // Bash.
  if ("stdout" in result || "stderr" in result) {
    const stdout = str(result.stdout) ?? "";
    const stderr = str(result.stderr) ?? "";
    const sections: EntrySection[] = [];
    if (stdout) sections.push(section("Output", stdout, "code"));
    if (stderr) sections.push(section("Stderr", stderr, "code"));
    if (result.interrupted === true)
      sections.push(section("Note", "interrupted", "text"));
    return done(
      sections.length > 0
        ? sections
        : [section("Output", "(no output)", "text")]
    );
  }
  // Read.
  const file = record(result.file);
  if (typeof file.content === "string") {
    const lines =
      typeof file.numLines === "number"
        ? `${file.numLines} line${file.numLines === 1 ? "" : "s"}`
        : "Output";
    return done([section(lines, file.content, "code")]);
  }
  // Edit, MultiEdit, Write and TodoWrite: the call's card already shows what
  // changed, and the result only says that it did.
  if ("structuredPatch" in result || "newTodos" in result) return done([]);
  // Task: the subagent's answer.
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((block) => str(record(block).text) ?? "")
      .filter(Boolean)
      .join("\n\n");
    if (text) return done([section("Result", text, "markdown")]);
  }
  return done(event.content ? [section("Output", event.content, "text")] : []);
}

/**
 * A thinking block, as the CLI says it: "Thought for 5s", or "Thought" when it
 * was not timed. What it thought is never on the card — see the `thinking`
 * event in `./events.ts`.
 *
 * Its message is its `ref`, so a message's blocks are one card: a message
 * that thinks twice ends on a second block of a few milliseconds, and the CLI
 * shows the two as one thought.
 */
export function thinkingCard(
  durationMs: number | undefined,
  messageId: string | undefined
): Card {
  return {
    text:
      durationMs === undefined
        ? "Thought"
        : `Thought for ${duration(Math.max(durationMs, 1000))}`,
    detail: { title: "Thinking", ...(messageId ? { ref: messageId } : {}) }
  };
}

/** A session starting — every exec, a resume or a follow-up included. */
export function initCard(event: InitEvent): Card {
  const parts = [
    "Session started",
    event.model,
    event.permissionMode && `${event.permissionMode} mode`
  ].filter(Boolean);
  return { text: parts.join(" · "), detail: { title: "Session" } };
}

/** A session's end, with what its `result` line says about it. */
export function resultCard(result: ClaudeCodeResult): Card {
  const failed = result.isError || result.subtype !== "success";
  const parts = [
    failed ? `Session failed (${result.subtype})` : "Session finished",
    result.numTurns
      ? `${result.numTurns} turn${result.numTurns === 1 ? "" : "s"}`
      : undefined,
    result.durationMs ? duration(result.durationMs) : undefined
  ].filter(Boolean);
  const errors = result.errors?.join("\n");
  return {
    text: parts.join(" · "),
    detail: {
      title: "Session",
      status: failed ? "error" : "ok",
      ...(errors ? { sections: [section("Errors", errors, "text")] } : {})
    }
  };
}

/** A session its run gave up on before reading its end, and why. */
export function lostCard(why: string): Card {
  return {
    text: "Session ended before its run read it to the end",
    detail: {
      title: "Session",
      status: "error",
      sections: [section("Why", why, "text")]
    }
  };
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
