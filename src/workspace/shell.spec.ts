import { describe, it, expect } from "vitest";
import { withShell, withShellTranscript } from "./shell.js";

describe("withShell", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShell("npm test", undefined)).toBe("npm test");
  });

  /**
   * The property `/repo` depends on. It asks git questions whose answer is the
   * whole of stdout — a URL to compare, a sha to push, a count to test against
   * "0" — so a diagnostic merged into that channel is a wrong answer, not noise.
   */
  it("leaves the two streams alone, so stdout carries the answer only", () => {
    const command = withShell("git rev-list --count origin/main..HEAD", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    expect(command).not.toContain("2>&1");
  });

  /**
   * The regression this guards is a *silent* one, and it is the worst kind this
   * tool can produce. Without `pipefail`, a pipeline reports its last stage's
   * status — so `npm run check | tail -100` came back `exit 0` from a gate that
   * had failed in 1.3 seconds on a missing `node_modules`. A build that failed
   * and said it passed is worse than no answer at all.
   */
  it("asks the shell to report the first failing stage of a pipeline", () => {
    expect(withShell("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  /**
   * The command is model-authored and routinely carries its own quoting. If the
   * wrapper re-parsed it, `git commit -m "a message"` would arrive as two
   * arguments and the commit would be made with the wrong message — a silent
   * corruption, not an error.
   */
  it("survives a command that contains its own quotes", () => {
    expect(withShell(`git commit -m "add a line"`, "bash")).toContain(
      "add a line"
    );
  });
});

describe("withShellTranscript", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShellTranscript("npm test", undefined)).toBe("npm test");
  });

  it("merges stderr into stdout on the wrapper process", () => {
    const command = withShellTranscript("npm run check", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    // Bound to the wrapper, not nested inside it — so it applies to everything
    // the command spawns, however deep, with no brace group to mis-parse.
    expect(command.endsWith(" 2>&1")).toBe(true);
  });

  it("keeps pipefail, which is not the half that differs", () => {
    expect(withShellTranscript("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  it("survives a command that contains its own quotes", () => {
    const command = withShellTranscript(`git commit -m "add a line"`, "bash");
    expect(command).toContain("add a line");
    expect(command.endsWith(" 2>&1")).toBe(true);
  });
});
