import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshWorkspace } from "../../../test/computer/do.js";
import { DEFAULT_INSTALL_PLAN, type InstallState } from "../install.js";
import { InstallJob } from "./install-job.js";
import type { Workspace } from "@cloudflare/computer";

/**
 * The install job against real Durable Object storage, driven directly: with no
 * container, the workspace object can never report a tree installed.
 */

/**
 * A checkout the install planner will act on, whose container refuses every
 * command.
 *
 * The filesystem is answered from a fixed set rather than "yes to everything",
 * so `node_modules` is genuinely absent and the install is not skipped as
 * already done — the one way this fake could make the test pass for the wrong
 * reason.
 */
function refusingWorkspace(err: Error): Workspace {
  const present = new Set([
    "/workspace/repo/package.json",
    "/workspace/repo/package-lock.json"
  ]);
  return {
    fs: {
      exists: async (path: string) => present.has(path),
      readFile: async () => "{}"
    },
    runtime: {
      exec: async () => {
        throw err;
      },
      getExec: async () => {
        throw err;
      }
    }
  } as unknown as Workspace;
}

/** A job wired to one workspace's real storage, and nothing else it does not need. */
function jobOn(
  storage: DurableObjectStorage,
  workspace?: Workspace
): InstallJob {
  return new InstallJob({
    storage,
    // Enough of a scheduler to accept the watchdog an install arms before it
    // spawns. The rows themselves are not what these specs pin — the deadline
    // wrapper around it writes to the real storage above, which is.
    scheduler: {
      set: async () => ({ id: "spec-schedule" }),
      cancel: async () => {},
      get: async () => undefined
    } as never,
    workspace: () => workspace ?? ({} as unknown as Workspace),
    plan: () => ({ ...DEFAULT_INSTALL_PLAN, overrides: {} }),
    timeoutMs: () => 20 * 60_000,
    headroom: () => undefined,
    touch: async () => {},
    ready: async () => {},
    waitUntil: () => {},
    containerGone: async () => {},
    tag: () => "spec",
    id: () => "spec-id"
  });
}

/** An install that finished, and whether the running container holds its tree. */
async function seedFinishedInstall(
  storage: DurableObjectStorage,
  options: { tree: boolean }
) {
  await storage.put("install", {
    state: "done",
    command: "npm ci --no-audit --no-fund",
    exitCode: 0,
    finishedAt: Date.now() - 60_000,
    ms: 80_000
  } satisfies InstallState);
  await storage.put("install:context", {
    dir: "/workspace/probe",
    fingerprint: "the-lockfile",
    command: "npm ci --no-audit --no-fund",
    startedAt: Date.now() - 140_000
  });
  if (options.tree)
    await storage.put("install:tree", {
      dir: "/workspace/probe",
      fingerprint: "the-lockfile",
      at: Date.now()
    });
}

describe("the tree belongs to the container", () => {
  it("arms nothing while this container holds the tree", async () => {
    const stub = freshWorkspace("tree-held");
    const state = await runInDurableObject(stub, async (_instance, ctx) => {
      await seedFinishedInstall(ctx.storage, { tree: true });
      await jobOn(ctx.storage).armIfTreeMissing();
      return (await ctx.storage.get<InstallState>("install"))?.state;
    });
    expect(state).toBe("done");
  });

  it("arms an install once the container is gone", async () => {
    const stub = freshWorkspace("tree-gone");
    const state = await runInDurableObject(stub, async (_instance, ctx) => {
      await seedFinishedInstall(ctx.storage, { tree: true });
      const job = jobOn(ctx.storage);
      await job.containerGone();
      await job.armIfTreeMissing();
      return (await ctx.storage.get<InstallState>("install"))?.state;
    });
    expect(state).toBe("running");
  });

  /** A replacement started inside `connect()` is seen only through its marker. */
  it("drops a record the container's marker contradicts, and keeps one it confirms", async () => {
    const stub = freshWorkspace("tree-reconcile");
    const after = await runInDurableObject(stub, async (_instance, ctx) => {
      await seedFinishedInstall(ctx.storage, { tree: true });
      const job = jobOn(ctx.storage);
      await job.reconcile("the-lockfile");
      const kept = await ctx.storage.get("install:tree");
      await job.reconcile(null);
      return { kept, dropped: await ctx.storage.get("install:tree") };
    });
    expect(after.kept).toBeDefined();
    expect(after.dropped).toBeUndefined();
  });
});

describe("what an install says when the container cannot be reached", () => {
  /** The host refusing a container whose image predates the shared secret. */
  const AUTH_FAULT = new Error(
    "WorkspaceTransportError: CloudflareContainerBackend(container-shell) " +
      "[stage=auth]: container served an unauthenticated request to /api with " +
      "405, so this workspace would run without authorization. A container or " +
      "image predating RPC_CLIENT_SECRET has to be recycled."
  );

  /** The same spawn failing because the container was merely not there. */
  const UNREACHABLE = new Error("Network connection lost.");

  async function failedInstall(err: Error, name: string) {
    const stub = freshWorkspace(name);
    return await runInDurableObject(stub, async (_instance, state) =>
      jobOn(state.storage, refusingWorkspace(err)).start({
        dir: "/workspace/repo"
      })
    );
  }

  it("tells an operator to redeploy when the image cannot authenticate", async () => {
    const state = await failedInstall(AUTH_FAULT, "install-auth-fault");
    expect(state.state).toBe("failed");
    // The record is what reaches the subagent, so it must not send it after a
    // command that would have to reach the same container this one could not.
    expect(state.state === "failed" && state.error).toMatch(/redeploy/);
    expect(state.state === "failed" && state.error).not.toMatch(/sb_exec/);
  });

  it("tells an operator to redeploy when the re-attach cannot reach it", async () => {
    // The other way in. A `running` record that this isolate did not start is
    // resolved by re-attaching to the command, and that reaches the same
    // container through `getExec` — so it fails the same way and owes the same
    // sentence. Young on purpose: a stale record is closed by the timeout bound
    // above this path and never reaches it.
    const stub = freshWorkspace("reattach-auth-fault");
    const state = await runInDurableObject(stub, async (_instance, s) => {
      await s.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now()
      } satisfies InstallState);
      return jobOn(s.storage, refusingWorkspace(AUTH_FAULT)).state();
    });
    expect(state.state).toBe("failed");
    expect(state.state === "failed" && state.error).toMatch(/redeploy/);
    expect(state.state === "failed" && state.error).not.toMatch(/sb_exec/);
  });

  it("still sends the subagent after an unreachable container", async () => {
    // The guard: without it the test above passes against a version that gives
    // every spawn failure the same sentence.
    const state = await failedInstall(UNREACHABLE, "install-unreachable");
    expect(state.state).toBe("failed");
    expect(state.state === "failed" && state.error).toMatch(/sb_exec/);
  });
});
