import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_AGENT } from "./index.js";

/**
 * The spec, as the parent's model sees it. `prepare` and `settle` are the
 * host's, so the spec carries neither.
 */
describe("the sub-agent spec", () => {
  it("offers the writer under its own name", () => {
    expect(CLAUDE_CODE_AGENT.name).toBe("claude_code");
  });

  /** A session runs for up to its `timeoutMs`, past a parent's turn. */
  it("runs detached", () => {
    expect(CLAUDE_CODE_AGENT.detached).toBe(true);
  });

  it("lets the writer name a branch to continue", () => {
    const write = CLAUDE_CODE_AGENT.inputSchema as unknown as {
      parse: (v: unknown) => unknown;
    };
    expect(write.parse({ task: "t" })).toEqual({ task: "t" });
    expect(
      write.parse({ task: "t", continue: "claude-coordinator/t/1" })
    ).toEqual({
      task: "t",
      continue: "claude-coordinator/t/1"
    });
  });

  /** The session reads the task; the branch is the host's `prepare`'s. */
  it("hands the session the task alone", () => {
    expect(
      CLAUDE_CODE_AGENT.formatInput!({ task: "add the flag", continue: "b" })
    ).toBe("add the flag");
  });
});
