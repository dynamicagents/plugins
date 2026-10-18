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

  /**
   * The skill name is spliced into a path under the checkout, so the shape is
   * the boundary: everything refused here is something that would have escaped
   * `<cwd>/.claude/skills/<skill>/SKILL.md` or named nothing in it.
   */
  it("takes a skill that is one path segment, and nothing that is not", () => {
    const carried = (skill: string) =>
      readRunHeader(withRunHeader({ cwd: "/workspace/repo", skill }, "x"))
        .header?.skill;
    for (const skill of ["refactor-discovery", "a", "a.b_c-1"]) {
      expect(carried(skill)).toBe(skill);
    }
    for (const skill of [
      "",
      " ",
      "..",
      ".hidden",
      "/refactor-discovery",
      "refactor discovery",
      "refactor\ndiscovery",
      "nested/skill",
      "../../etc/passwd",
      "plugin:skill"
    ]) {
      expect(() =>
        withRunHeader({ cwd: "/workspace/repo", skill }, "x")
      ).toThrow(/skill must be one path segment/);
    }
    expect(() =>
      readRunHeader('@@da {"cwd":"/workspace","skill":7}\nx')
    ).toThrow(/skill must be one path segment/);
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
