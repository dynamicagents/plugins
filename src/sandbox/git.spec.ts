import { describe, expect, it } from "vitest";
import { freshSandbox } from "../../test/sandbox/do.js";
import { sandboxRepoGit, type SandboxGitHost } from "./git.js";

/**
 * Credentialed git as the container's own, behind a fake container: what is
 * run, as whom, and what comes back. That the egress swaps the token and holds
 * a push to its policy is `./egress.spec.ts`'s.
 */

const ALLOWED = ["github.com"];
const URL = "https://github.com/dynamicagents/plugins.git";

async function setup(name: string) {
  const sandbox = freshSandbox(name);
  await sandbox.ensureRunning();
  const git = sandboxRepoGit(() => sandbox as unknown as SandboxGitHost);
  const sent = async (match: string) =>
    (await sandbox.fake()).execs
      .map((cmd) => cmd.join(" "))
      .filter((cmd) => cmd.includes(match));
  return { sandbox, git, sent };
}

describe("sandboxRepoGit", () => {
  it("clones as the agent, under a limit, notes the checkout, and says where it landed", async () => {
    const { sandbox, git, sent } = await setup("clone");
    await sandbox.answer("rev-parse --abbrev-ref HEAD", "main\n");
    expect(
      await git.clone({
        url: URL,
        dir: "/workspace/plugins",
        allowedHosts: ALLOWED,
        branch: "main",
        depth: 1
      })
    ).toEqual({ ok: true, detail: "main" });
    const [clone] = await sent("git clone");
    expect(clone).toMatch(
      /^setpriv .* timeout --kill-after=5 600 git clone --depth 1 --branch main -- https:\/\/github\.com\/dynamicagents\/plugins\.git \/workspace\/plugins$/
    );
    expect(
      await sent("/var/lib/da/checkouts/%2Fworkspace%2Fplugins")
    ).not.toHaveLength(0);
  });

  it("refuses a host or a scheme it was not allowed, and runs nothing", async () => {
    const { git, sent } = await setup("refuse");
    for (const url of [
      "http://github.com/a/b.git",
      "https://evil.example/a/b.git",
      "not a url"
    ]) {
      expect(
        await git.clone({ url, dir: "/workspace/x", allowedHosts: ALLOWED })
      ).toMatchObject({ ok: false });
    }
    expect(await sent("git ")).toEqual([]);
  });

  it("pushes one branch to its own name, never forced, and reports a refusal as a value", async () => {
    const { sandbox, git, sent } = await setup("push");
    await sandbox.answer("git push", "", 1);
    expect(
      await git.push({
        url: URL,
        dir: "/workspace/plugins",
        branch: "coding/abc",
        allowedHosts: ALLOWED
      })
    ).toEqual({ ok: false, code: "exit-1", message: "git push exited 1" });
    const [push] = await sent("git push");
    expect(push).toContain(
      `-- ${URL} refs/heads/coding/abc:refs/heads/coding/abc`
    );
    expect(push).not.toMatch(/--force|\+refs/);
  });

  it("names a git that ran past its limit", async () => {
    const { sandbox, git } = await setup("slow");
    await sandbox.answer("git fetch", "", 124);
    expect(
      await git.fetch({
        url: URL,
        dir: "/workspace/plugins",
        allowedHosts: ALLOWED
      })
    ).toMatchObject({ ok: false, code: "ETIMEDOUT" });
  });
});
