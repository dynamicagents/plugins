import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { ContainerGitIdentity, GIT_IDENTITY_COMMAND } from "./git-identity.js";

/** A workspace whose container answers, recording what it was asked to run. */
function answering(stdout: string, exitCode = 0) {
  const runs: { command: string; env?: Record<string, string> }[] = [];
  const workspace = {
    runtime: {
      exec: async (
        command: string,
        options?: { env?: Record<string, string> }
      ) => {
        runs.push({ command, ...(options?.env ? { env: options.env } : {}) });
        return {
          result: async () => ({ exitCode, stdout, stderr: "" }),
          [Symbol.dispose]: () => {}
        };
      }
    }
  } as unknown as Workspace;
  return { workspace, runs };
}

function identityOn(workspace: Workspace): ContainerGitIdentity {
  return new ContainerGitIdentity({
    workspace: () => workspace,
    author: () => ({ name: 'A "quoted" name', email: "a@example.invalid" }),
    tag: () => "spec",
    id: () => "spec-id"
  });
}

describe("GIT_IDENTITY_COMMAND", () => {
  /**
   * System scope is the whole point: a repository the container made for itself
   * has no config of its own, and `--global` would depend on `HOME`.
   */
  it("writes the system config, not a user's", () => {
    expect(GIT_IDENTITY_COMMAND).toContain("git config --system user.name");
    expect(GIT_IDENTITY_COMMAND).toContain("git config --system user.email");
    expect(GIT_IDENTITY_COMMAND).not.toContain("--global");
  });

  it("takes the identity as variables, so a name is never shell", () => {
    expect(GIT_IDENTITY_COMMAND).toContain('"$GIT_NAME"');
    expect(GIT_IDENTITY_COMMAND).toContain('"$GIT_EMAIL"');
  });
});

describe("ContainerGitIdentity", () => {
  it("configures once per container, and again after it is forgotten", async () => {
    const { workspace, runs } = answering("IDENTITY OK\n");
    const identity = identityOn(workspace);

    await identity.ensure();
    await identity.ensure();
    expect(runs.length).toBe(1);
    expect(runs[0]?.env).toEqual({
      GIT_NAME: 'A "quoted" name',
      GIT_EMAIL: "a@example.invalid"
    });

    identity.forget();
    await identity.ensure();
    expect(runs.length).toBe(2);
  });

  /**
   * An unconfigured container is not a broken one — the commit that needs an
   * identity says so itself — so this retries rather than throwing.
   */
  it("retries a write that did not land, and never throws", async () => {
    const { workspace, runs } = answering("error: could not lock config", 1);
    const identity = identityOn(workspace);
    await expect(identity.ensure()).resolves.toBeUndefined();
    await identity.ensure();
    expect(runs.length).toBe(2);
  });

  it("only logs an unreachable container", async () => {
    const workspace = {
      runtime: {
        exec: async () => {
          throw new Error("container unreachable");
        }
      }
    } as unknown as Workspace;
    await expect(identityOn(workspace).ensure()).resolves.toBeUndefined();
  });
});
