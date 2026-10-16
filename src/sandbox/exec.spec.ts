import { describe, expect, it } from "vitest";
import { sandboxExec, type SandboxExecConfig } from "./exec.js";
import { SANDBOX_RUNTIME_KEY } from "./name.js";

type Sent = {
  name: string;
  argv: string[];
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number };
};

/** Sandboxes that answer every command with `answer`, after `delayMs`. */
function sandboxes(
  answer: { exitCode: number; stdout?: string; stderr?: string },
  delayMs = 0
) {
  const sent: Sent[] = [];
  const binding = {
    getByName: (name: string) => ({
      async exec(argv: string[], options: Sent["options"] = {}) {
        sent.push({ name, argv, options });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { stdout: "", stderr: "", ...answer };
      }
    })
  } as unknown as SandboxExecConfig["binding"];
  return { binding, sent };
}

describe("sandboxExec", () => {
  it("runs a command under bash and its limit, in the parent's sandbox, dropping unset variables", async () => {
    const { binding, sent } = sandboxes({ exitCode: 0, stdout: "ok" });
    const exec = sandboxExec({ binding, sandboxName: () => "caller|repo" });
    expect(
      await exec("git status --porcelain", {
        cwd: "/workspace/repo",
        env: { A: "1", B: undefined }
      })
    ).toEqual({ success: true, stdout: "ok", stderr: "", exitCode: 0 });
    expect(sent[0]).toEqual({
      name: "caller|repo",
      argv: [
        "timeout",
        "--kill-after=5",
        "600",
        "bash",
        "-c",
        "git status --porcelain"
      ],
      options: { cwd: "/workspace/repo", env: { A: "1" }, timeoutMs: 610_000 }
    });
  });

  it("reaches the sandbox a sub-agent's runtime names", async () => {
    const { binding, sent } = sandboxes({ exitCode: 0 });
    await sandboxExec({ binding, sandboxName: () => "parent" })("true", {
      runtime: { [SANDBOX_RUNTIME_KEY]: "caller|<worktree:o/r:1>" }
    });
    expect(sent[0]?.name).toBe("caller|<worktree:o/r:1>");
    expect(sent[0]?.options.cwd).toBe("/workspace");
  });

  it("says a command was killed at its limit, and not for a 124 well inside it", async () => {
    const slow = sandboxes({ exitCode: 124, stderr: "partial" }, 20);
    const killed = await sandboxExec({
      binding: slow.binding,
      sandboxName: () => "s"
    })("sleep 600", { timeout: 10 });
    expect(killed.success).toBe(false);
    expect(killed.stderr).toMatch(
      /^partial\nthe command was killed at its time limit/
    );

    const quick = sandboxes({ exitCode: 124, stderr: "its own 124" });
    const own = await sandboxExec({
      binding: quick.binding,
      sandboxName: () => "s"
    })("exit 124", { timeout: 60_000 });
    expect(own.stderr).toBe("its own 124");
  });
});
