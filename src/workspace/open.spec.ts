import { describe, it, expect } from "vitest";
import { workspaceNameFromRuntime, WORKSPACE_RUNTIME_KEY } from "./open.js";

describe("the workspace a sub-agent reaches", () => {
  /**
   * A sub-agent cannot compute the name: its parent chose the checkout. The
   * spec's `prepare` puts it in `runtime()`, and reading it back is what makes
   * a sub-agent land in the checkout its parent cloned.
   */
  it("comes from the runtime when a parent supplied one", () => {
    expect(
      workspaceNameFromRuntime({ [WORKSPACE_RUNTIME_KEY]: "caller|o/r" })
    ).toBe("caller|o/r");
  });

  it("falls back rather than throwing on anything else", () => {
    for (const runtime of [undefined, null, {}, { workspaceName: "" }, 7]) {
      expect(workspaceNameFromRuntime(runtime)).toBeUndefined();
    }
  });
});
