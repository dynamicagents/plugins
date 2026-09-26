import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { ContainerDeps, depsSetupCommand } from "./container-deps.js";

/**
 * The script is verified end to end against a real shell outside this suite
 * (Docker, `--privileged`): a script-spawned `npm ci` gets the mount, as does a
 * `--prefix` target; a re-run setup wraps the real binary rather than its
 * wrapper; `corepack enable` leaves the wrappers in place; and nothing outside
 * the workspace is mounted. These pin the properties that made those true.
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

  /** `corepack enable` or `npm i -g pnpm` installs one after the setup ran. */
  it("wraps every package manager, installed yet or not", () => {
    expect(command).toContain(
      "for tool in npm npx pnpm yarn corepack bun bunx; do install"
    );
  });

  it("finds the real binary when the wrapper runs, with the wrapper directory skipped", () => {
    expect(command).toContain('tool=$(basename "$0")');
    expect(command).toContain('[ "$d" = /usr/local/sbin ] && continue');
  });

  it("keeps corepack's shims from replacing the wrappers", () => {
    expect(command).toContain('set -- "$cmd" --install-directory "$real" "$@"');
  });

  it("mounts the directory a package manager is pointed at", () => {
    expect(command).toContain(
      '/usr/local/sbin/workspace-deps-mount "$PWD" "$@"'
    );
    expect(command).toContain("--prefix|--cwd|--dir|-C)");
    expect(command).toContain("--prefix=*|--cwd=*|--dir=*)");
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
    const { workspace, runs } = answering("MARKER abc\nSETUP OK\n");
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

  /**
   * The container answered and has no wrappers, so an install would succeed
   * into the workspace. Nothing else would say so.
   */
  it("throws for a setup that did not finish, and retries it", async () => {
    const { workspace, runs } = answering("install: permission denied", 1);
    const deps = depsOn(workspace);
    await expect(deps.ensure("/workspace/repo")).rejects.toThrow(
      /permission denied/
    );
    await expect(deps.ensure("/workspace/repo")).rejects.toThrow();
    expect(runs.count).toBe(2);
  });

  it("only logs an unreachable container, whose next command fails too", async () => {
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
