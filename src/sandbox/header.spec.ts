import { describe, expect, it } from "vitest";
import {
  isUnder,
  readRunHeader,
  RunHeaderError,
  withRunHeader
} from "./header.js";

describe("run header", () => {
  it("rides as the first line and comes off whole", () => {
    const text = withRunHeader(
      {
        cwd: "/workspace/dev-agents",
        mode: "plan",
        schema: "plan",
        effort: "xhigh"
      },
      "Plan the change.\nSecond line."
    );
    expect(text.split("\n")[0]).toMatch(/^@@da \{/);
    expect(readRunHeader(text)).toEqual({
      header: {
        cwd: "/workspace/dev-agents",
        mode: "plan",
        schema: "plan",
        effort: "xhigh"
      },
      prompt: "Plan the change.\nSecond line."
    });
  });

  it("leaves a prompt with no header alone: control prompts and follow-ups carry none", () => {
    expect(readRunHeader("control:wake")).toEqual({
      header: undefined,
      prompt: "control:wake"
    });
  });

  it("refuses a header it cannot honour rather than run with defaults", () => {
    expect(() => readRunHeader("@@da {not json\nx")).toThrow(RunHeaderError);
    expect(() => readRunHeader('@@da {"cwd":"/etc"}\nx')).toThrow(
      /under \/workspace/
    );
    expect(() => readRunHeader('@@da {"cwd":"/workspace/../etc"}\nx')).toThrow(
      RunHeaderError
    );
    expect(() =>
      readRunHeader('@@da {"cwd":"/workspace","mode":"plan"}\nx')
    ).toThrow(/schema/);
    expect(() =>
      readRunHeader('@@da {"cwd":"/workspace","mode":"yolo"}\nx')
    ).toThrow(/mode/);
    expect(() => withRunHeader({ cwd: "relative" }, "x")).toThrow(
      RunHeaderError
    );
  });

  it("confines paths to the root, `..` included", () => {
    expect(isUnder("/workspace", "/workspace")).toBe(true);
    expect(isUnder("/workspace/a/./b", "/workspace")).toBe(true);
    expect(isUnder("/workspace/a/../b", "/workspace")).toBe(true);
    expect(isUnder("/workspace/../root", "/workspace")).toBe(false);
    expect(isUnder("/workspaces", "/workspace")).toBe(false);
    expect(isUnder("workspace", "/workspace")).toBe(false);
  });
});
