import { describe, it, expect } from "vitest";
import { ENTRY_SECTION_MAX_CHARS } from "@dynamicagents/core/artifacts";
import {
  initCard,
  resultCard,
  thinkingCard,
  toolCallCard,
  toolResultCard
} from "./cards.js";

/**
 * How each of the CLI's tools reads on the transcript. The shapes are the
 * CLI's own `tool_use` inputs and `tool_use_result` records; a renamed field
 * shows here as a card that lost its summary line, not as an error.
 */

const result = (over: {
  content?: string;
  isError?: boolean;
  structured?: unknown;
}) => ({
  kind: "toolResult" as const,
  id: "toolu_1",
  isError: over.isError ?? false,
  content: over.content ?? "",
  ...(over.structured === undefined ? {} : { structured: over.structured })
});

describe("toolCallCard", () => {
  it("opens every call as running, under its tool-use id", () => {
    expect(
      toolCallCard("toolu_9", "Read", { file_path: "a.ts" }).detail
    ).toMatchObject({
      ref: "toolu_9",
      status: "running"
    });
  });

  it("reads Bash by its description, with the command beneath", () => {
    expect(
      toolCallCard("t", "Bash", {
        command: "npm test -- --run",
        description: "Run the suite"
      })
    ).toEqual({
      text: "Run the suite",
      detail: {
        ref: "t",
        status: "running",
        title: "Bash",
        sections: [
          { label: "Command", body: "npm test -- --run", format: "code" }
        ]
      }
    });
    expect(toolCallCard("t", "Bash", { command: "ls\nwc -l" }).text).toBe("ls");
  });

  it("reads Read by its path and range", () => {
    expect(toolCallCard("t", "Read", { file_path: "src/a.ts" }).text).toBe(
      "src/a.ts"
    );
    expect(
      toolCallCard("t", "Read", { file_path: "src/a.ts", offset: 10, limit: 5 })
        .text
    ).toBe("src/a.ts · lines 10–14");
  });

  it("keeps a long absolute path's end, where the file's name is", () => {
    expect(
      toolCallCard("t", "Read", {
        file_path: "/workspace/repo/src/claude-code/cards.ts"
      }).text
    ).toBe("…/src/claude-code/cards.ts");
    expect(
      toolCallCard("t", "Read", { file_path: "/workspace/repo/a.ts" }).text
    ).toBe("/workspace/repo/a.ts");
  });

  it("shows an Edit as the diff it makes", () => {
    const card = toolCallCard("t", "Edit", {
      file_path: "src/a.ts",
      old_string: "one\ntwo",
      new_string: "three"
    });
    expect(card.text).toBe("src/a.ts");
    expect(card.detail).toMatchObject({
      title: "Update",
      sections: [{ label: "Diff", body: "-one\n-two\n+three", format: "diff" }]
    });
  });

  it("shows each of a MultiEdit's edits as a hunk", () => {
    const card = toolCallCard("t", "MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" }
      ]
    });
    expect(card.detail.sections?.[0]?.body).toBe(
      "@@ edit 1 @@\n-a\n+b\n@@ edit 2 @@\n-c\n+d"
    );
  });

  it("shows a Write as the content it writes, clipped", () => {
    const card = toolCallCard("t", "Write", {
      file_path: "big.txt",
      content: "x".repeat(ENTRY_SECTION_MAX_CHARS * 3)
    });
    expect(card.detail.title).toBe("Write");
    expect(card.detail.sections?.[0]?.body.length).toBeLessThan(
      ENTRY_SECTION_MAX_CHARS + 100
    );
  });

  it("reads Grep and Glob by pattern and place, and folds the rest", () => {
    expect(
      toolCallCard("t", "Grep", {
        pattern: "TODO",
        path: "src",
        output_mode: "content"
      })
    ).toMatchObject({
      text: "TODO in src",
      detail: {
        title: "Search",
        sections: [{ label: "Options", format: "code" }]
      }
    });
    expect(toolCallCard("t", "Glob", { pattern: "**/*.ts" })).toEqual({
      text: "**/*.ts",
      detail: { ref: "t", status: "running", title: "Glob" }
    });
  });

  it("reads WebFetch by its url and WebSearch by its query", () => {
    expect(
      toolCallCard("t", "WebFetch", {
        url: "https://x.dev",
        prompt: "summarise"
      })
    ).toMatchObject({ text: "https://x.dev", detail: { title: "Fetch" } });
    expect(
      toolCallCard("t", "WebSearch", { query: "workerd sqlite" })
    ).toMatchObject({
      text: "workerd sqlite",
      detail: { title: "Web Search" }
    });
  });

  it("reads a Task by its description, its prompt as markdown", () => {
    expect(
      toolCallCard("t", "Task", {
        description: "Map the artifacts",
        prompt: "# Find\n- the store",
        subagent_type: "Explore"
      })
    ).toMatchObject({
      text: "Map the artifacts",
      detail: {
        title: "Explore",
        sections: [
          { label: "Prompt", body: "# Find\n- the store", format: "markdown" }
        ]
      }
    });
  });

  it("reads TodoWrite as a checklist, the active item in its active form", () => {
    expect(
      toolCallCard("t", "TodoWrite", {
        todos: [
          {
            content: "Read the store",
            status: "completed",
            activeForm: "Reading"
          },
          {
            content: "Write the card",
            status: "in_progress",
            activeForm: "Writing the card"
          },
          { content: "Test it", status: "pending", activeForm: "Testing" },
          { content: "Malformed", status: "someday" }
        ]
      })
    ).toEqual({
      text: "Writing the card · 1/3 done",
      detail: {
        ref: "t",
        status: "running",
        title: "Todos",
        checklist: [
          { text: "Read the store", state: "done" },
          { text: "Writing the card", state: "active" },
          { text: "Test it", state: "pending" }
        ]
      }
    });
  });

  it("falls back to the tool's name and its input as JSON", () => {
    expect(
      toolCallCard("t", "mcp__docs__search", { q: "cards", limit: 3 })
    ).toEqual({
      text: "cards",
      detail: {
        ref: "t",
        status: "running",
        title: "mcp__docs__search",
        sections: [
          {
            label: "Input",
            body: '{\n  "q": "cards",\n  "limit": 3\n}',
            format: "code"
          }
        ]
      }
    });
    expect(toolCallCard("t", "Ping", {})).toEqual({
      text: "Ping",
      detail: { ref: "t", status: "running", title: "Ping" }
    });
  });
});

describe("toolResultCard", () => {
  it("completes the call's card, and says an error in its own words", () => {
    expect(
      toolResultCard(result({ isError: true, content: "no such file" }))
    ).toEqual({
      text: "no such file",
      detail: {
        ref: "toolu_1",
        status: "error",
        sections: [{ label: "Error", body: "no such file", format: "text" }]
      }
    });
  });

  it("splits Bash's output from its stderr", () => {
    expect(
      toolResultCard(
        result({
          content: "ok",
          structured: { stdout: "ok", stderr: "warn", interrupted: false }
        })
      ).detail.sections
    ).toEqual([
      { label: "Output", body: "ok", format: "code" },
      { label: "Stderr", body: "warn", format: "code" }
    ]);
    expect(
      toolResultCard(result({ structured: { stdout: "", stderr: "" } })).detail
        .sections
    ).toEqual([{ label: "Output", body: "(no output)", format: "text" }]);
  });

  it("shows a Read as the lines it read", () => {
    expect(
      toolResultCard(
        result({
          content: "     1→const a = 1;",
          structured: {
            type: "text",
            file: { filePath: "a.ts", content: "const a = 1;", numLines: 1 }
          }
        })
      ).detail.sections
    ).toEqual([{ label: "1 line", body: "const a = 1;", format: "code" }]);
  });

  it("adds nothing to an edit or a todo list, whose call shows the change", () => {
    for (const structured of [
      { structuredPatch: [] },
      { newTodos: [], oldTodos: [] }
    ]) {
      expect(
        toolResultCard(result({ content: "done", structured })).detail
      ).toEqual({
        ref: "toolu_1",
        status: "ok"
      });
    }
  });

  it("shows a Task's answer as markdown", () => {
    expect(
      toolResultCard(
        result({
          structured: {
            status: "completed",
            content: [{ type: "text", text: "**found** it" }]
          }
        })
      ).detail.sections
    ).toEqual([{ label: "Result", body: "**found** it", format: "markdown" }]);
  });

  it("falls back to the text the model was given", () => {
    expect(toolResultCard(result({ content: "a\nb" })).detail.sections).toEqual(
      [{ label: "Output", body: "a\nb", format: "text" }]
    );
  });
});

describe("the session's own cards", () => {
  it("says how long a thinking block took, the way the CLI does", () => {
    expect(thinkingCard(4_600, "msg_1")).toEqual({
      text: "Thought for 5s",
      detail: { title: "Thinking", ref: "msg_1" }
    });
    expect(thinkingCard(65_000, undefined)).toEqual({
      text: "Thought for 1m 5s",
      detail: { title: "Thinking" }
    });
    // A block that took less than a second still took one.
    expect(thinkingCard(200, undefined).text).toBe("Thought for 1s");
    expect(thinkingCard(undefined, undefined).text).toBe("Thought");
  });

  it("names the model and the mode a session started in", () => {
    expect(
      initCard({
        kind: "init",
        sessionId: "s",
        model: "claude-opus-5-5",
        permissionMode: "plan"
      })
    ).toEqual({
      text: "Session started · claude-opus-5-5 · plan mode",
      detail: { title: "Session" }
    });
  });

  it("says how a session ended, its errors folded beneath", () => {
    const card = resultCard({
      subtype: "error_max_turns",
      isError: true,
      text: "",
      numTurns: 40,
      durationMs: 432_000,
      apiErrorStatus: null,
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      permissionDenials: 0,
      errors: ["ran out of turns"]
    });
    expect(card).toEqual({
      text: "Session failed (error_max_turns) · 40 turns · 7m 12s",
      detail: {
        title: "Session",
        status: "error",
        sections: [
          { label: "Errors", body: "ran out of turns", format: "text" }
        ]
      }
    });
  });
});
