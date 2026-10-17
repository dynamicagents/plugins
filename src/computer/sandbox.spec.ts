import { describe, expect, it } from "vitest";
import { PluginSetupError } from "@dynamicagents/core";
import { freshSandbox } from "../../test/sandbox/do.js";
import { testPluginContext } from "../../test/helpers.js";
import {
  sandboxClient,
  sandboxComputer,
  sandboxWorkspace,
  type SandboxComputerHost
} from "./index.js";

/**
 * The computer tools over a sandbox, behind a fake container: what goes to the
 * container, and how its answers are read.
 */

const json = (value: unknown) => JSON.stringify(value);
const rgLine = (type: string, path: string, line: number, text: string) =>
  json({
    type,
    data: {
      path: { text: path },
      line_number: line,
      lines: { text: `${text}\n` }
    }
  });

async function host(name: string) {
  const sandbox = freshSandbox(name);
  await sandbox.ensureRunning();
  return {
    sandbox,
    client: sandboxClient(sandbox as unknown as SandboxComputerHost),
    lastExec: async (match: string) =>
      (await sandbox.fake()).execs
        .map((cmd) => cmd.join(" "))
        .filter((cmd) => cmd.includes(match))
        .at(-1) ?? ""
  };
}

describe("sandboxClient", () => {
  it("greps with ripgrep from the directory its globs anchor to, and reads matches with their context", async () => {
    const { sandbox, client, lastExec } = await host("grep");
    await sandbox.answer(
      "--json",
      [
        "/workspace/repo",
        json({ type: "begin", data: { path: { text: "./src/a.go" } } }),
        rgLine("context", "./src/a.go", 1, "before"),
        rgLine("match", "./src/a.go", 2, "the needle"),
        rgLine("context", "./src/a.go", 3, "after"),
        rgLine("match", "./src/b.go", 9, "another needle")
      ].join("\n")
    );
    const matches = await client.fs.grep("needle", "/workspace/repo", {
      include: "**/*.ts",
      context: 1,
      exclude: ["**/node_modules", "**/.git"]
    });
    expect(matches).toEqual([
      {
        path: "/workspace/repo/src/a.go",
        line: 2,
        text: "the needle",
        context: [
          { line: 1, text: "before", isMatch: false },
          { line: 2, text: "the needle", isMatch: true },
          { line: 3, text: "after", isMatch: false }
        ]
      },
      {
        path: "/workspace/repo/src/b.go",
        line: 9,
        text: "another needle",
        context: [{ line: 9, text: "another needle", isMatch: true }]
      }
    ]);
    const sent = await lastExec("--json");
    expect(sent).toMatch(/^\/usr\/bin\/setpriv /);
    expect(sent).toContain("/workspace/repo **/*.ts");
    expect(sent).toContain("--fixed-strings");
    expect(sent).toContain("-g !**/node_modules -g !**/.git");
    expect(sent).toContain("-e needle");
  });

  it("pages a grep by offset and limit", async () => {
    const { sandbox, client } = await host("grep-page");
    await sandbox.answer(
      "--json",
      [
        "/workspace",
        rgLine("match", "./a", 1, "x"),
        rgLine("match", "./b", 1, "x"),
        rgLine("match", "./c", 1, "x")
      ].join("\n")
    );
    expect(
      (await client.fs.grep("x", "/workspace", { offset: 1, limit: 1 })).map(
        (match) => match.path
      )
    ).toEqual(["/workspace/b"]);
  });

  it("finds files under a directory, by a glob anchored to it", async () => {
    const { sandbox, client, lastExec } = await host("find");
    await sandbox.answer("--files", "/workspace/repo\n./a.ts\n./src/b.go\n");
    expect(await client.fs.find("/workspace/repo", "**/*.ts")).toEqual([
      { path: "/workspace/repo/a.ts", type: "file" },
      { path: "/workspace/repo/src/b.go", type: "file" }
    ]);
    expect(await lastExec("--files")).toContain("/workspace/repo **/*.ts");
  });

  it("launches a command under its own time limit, as the agent, behind its cancel mark", async () => {
    const { client, lastExec } = await host("exec");
    using handle = await client.runtime.exec("npm test", {
      cwd: "/workspace/repo",
      encoding: "utf8",
      timeoutMs: 90_000
    });
    expect(await handle.result()).toMatchObject({
      exitCode: 0,
      status: "completed"
    });
    const sent = await lastExec("npm test");
    expect(sent).toMatch(/^\/usr\/bin\/setpriv .* sh -c /);
    expect(sent).toContain('[ -e "/run/da/cancelled/$0" ] && exit 130');
    expect(sent).toMatch(
      /exec timeout --kill-after=5 "\$2" sh -c "\$1" "\$0" da-exec-[0-9a-f-]+ npm test 90$/
    );
  });

  it("marks a command cancelled before it signals it, so one still starting never runs", async () => {
    const sandbox = freshSandbox("cancel-cold");
    const client = sandboxClient(sandbox as unknown as SandboxComputerHost);
    const sent = async (match: string) =>
      (await sandbox.fake()).execs
        .map((cmd) => cmd.join(" "))
        .filter((cmd) => cmd.includes(match));
    // Cold: the launch is still starting the container when it is cancelled.
    const handle = await client.runtime.exec("rm -rf build", {
      cwd: "/workspace/repo",
      encoding: "utf8",
      timeoutMs: 90_000
    });
    await handle.kill();
    expect(await handle.result()).toMatchObject({ status: "cancelled" });
    const [launch] = await sent("rm -rf build");
    const id = /da-exec-([0-9a-f-]+)/.exec(launch ?? "")?.[1];
    const [cancel] = await sent("da-cancel");
    expect(cancel).toContain(`da-cancel da-exec- ${id}`);
    expect(cancel).toMatch(
      /: > "\/run\/da\/cancelled\/\$m"\npkill -TERM -f "\$m"/
    );
  });

  it("says a command that ignored TERM and was killed at its limit was cancelled", async () => {
    const { sandbox, client } = await host("exec-kill");
    await sandbox.answer("sleep 600", "", 137);
    using handle = await client.runtime.exec("sleep 600", {
      cwd: "/workspace",
      encoding: "utf8",
      timeoutMs: 1
    });
    expect(await handle.result()).toMatchObject({
      exitCode: 137,
      status: "cancelled"
    });
  });
});

describe("sandboxComputer()", () => {
  const onWorkspace = (workspace: unknown) =>
    testPluginContext({ workspace: () => workspace as never });
  const binding = {
    getByName: () => ({})
  } as unknown as DurableObjectNamespace<SandboxComputerHost>;
  const sandboxed = sandboxWorkspace({ binding, sandboxName: () => "s" });

  /**
   * Think's own workspace is the one an agent has unless it says otherwise,
   * and over it `read` and `write` would work on a different tree from `bash`.
   */
  it("runs on a sandbox's workspace, and refuses any other", () => {
    expect(
      Object.keys(sandboxComputer({}).tools!(onWorkspace(sandboxed))).sort()
    ).toEqual(["bash", "edit", "grep"]);
    expect(() => sandboxComputer({}).tools!(onWorkspace({}))).toThrow(
      PluginSetupError
    );
    expect(() => sandboxComputer({}).tools!(onWorkspace({}))).toThrow(
      /sandboxWorkspace\(config/
    );
  });

  it("tells the model the checkout is the container's disk, and nothing of a mount", async () => {
    const said = await sandboxComputer({}).context![0]!.provider!.get();
    expect(said).toContain("container's own disk");
    expect(said).not.toMatch(/mount point|while the container is restarting/);
  });
});
