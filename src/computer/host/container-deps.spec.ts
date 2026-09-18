import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { ContainerDeps, depsSetupCommand } from "./container-deps.js";

/**
 * The script is verified end to end against a real shell outside this suite
 * (Docker, `--privileged`): a script-spawned `npm ci` gets the mount, a re-run
 * setup wraps the real binary rather than its wrapper, and nothing outside the
 * workspace is mounted. These pin the properties that made those true.
 */
describe("depsSetupCommand", () => {
  const command = depsSetupCommand("/workspace", "/workspace/repo");

  it("mounts only under the workspace, and never inside another tree", () => {
    expect(command).toContain("*/node_modules/*) exit 0;;");
    expect(command).toContain("/workspace|/workspace/*) ;;");
    expect(command).toContain("mount --bind");
  });

  it("replaces wrappers rather than writing through a path that may be a symlink", () => {
    expect(command).toContain(
      'install -m 755 /tmp/workspace-deps-wrap "/usr/local/sbin/$tool"'
    );
  });

  it("resolves the real binary with the wrapper directory skipped", () => {
    expect(command).toContain('[ "$d" = /usr/local/sbin ] && continue');
  });

  it("reads the marker only when there is a directory to read it in", () => {
    expect(command).toContain("/workspace/repo/node_modules/.da-installed");
    expect(depsSetupCommand("/workspace")).not.toContain("MARKER");
  });
});

/** A workspace whose container answers the setup with `stdout`, counting runs. */
function answering(stdout: string, exitCode = 0) {
  const runs = { count: 0 };
  const workspace = {
    runtime: {
      exec: async () => {
        runs.count += 1;
        return {
          result: async () => ({ exitCode, stdout, stderr: "" }),
          [Symbol.dispose]: () => {}
        };
      }
    }
  } as unknown as Workspace;
  return { workspace, runs };
}

function depsOn(workspace: Workspace): ContainerDeps {
  return new ContainerDeps({
    workspace: () => workspace,
    workspaceDir: "/workspace",
    tag: () => "spec",
    id: () => "spec-id"
  });
}

describe("ContainerDeps", () => {
  it("sets up once per container, and again after it is forgotten", async () => {
    const { workspace, runs } = answering(
      "WRAPPED npm\nMARKER abc\nSETUP OK\n"
    );
    const deps = depsOn(workspace);

    expect(await deps.ensure("/workspace/repo")).toEqual({ marker: "abc" });
    expect(await deps.ensure("/workspace/repo")).toBeUndefined();
    expect(runs.count).toBe(1);

    deps.forget();
    await deps.ensure("/workspace/repo");
    expect(runs.count).toBe(2);
  });

  it("reports no marker as null", async () => {
    const { workspace } = answering("MARKER -\nSETUP OK\n");
    expect(await depsOn(workspace).ensure("/workspace/repo")).toEqual({
      marker: null
    });
  });

  it("retries a setup that did not finish", async () => {
    const { workspace, runs } = answering("", 1);
    const deps = depsOn(workspace);
    expect(await deps.ensure("/workspace/repo")).toBeUndefined();
    await deps.ensure("/workspace/repo");
    expect(runs.count).toBe(2);
  });

  it("never throws for an unreachable container", async () => {
    const workspace = {
      runtime: {
        exec: async () => {
          throw new Error("container unreachable");
        }
      }
    } as unknown as Workspace;
    await expect(depsOn(workspace).ensure("/workspace/repo")).resolves.toBe(
      undefined
    );
  });
});
