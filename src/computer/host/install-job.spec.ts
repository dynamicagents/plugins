import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshWorkspace } from "../../../test/computer/do.js";
import { DEFAULT_INSTALL_PLAN, type InstallState } from "../install.js";
import { InstallJob } from "./install-job.js";
import type { Workspace } from "@cloudflare/computer";

/**
 * What an install is allowed to certify, against real Durable Object storage.
 *
 * Driven directly rather than through the workspace object, because the path
 * under test needs a drain that reports `complete` — and with no container a
 * drain can only report `unavailable`. The storage is real; everything the job
 * reaches for on this path is `ctx.storage`.
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
    armSync: async () => {},
    forgetTrust: () => {},
    tag: () => "spec",
    id: () => "spec-id"
  });
}

/** An install that finished, whose tree may or may not be believed to be coming. */
async function seedFinishedInstall(
  storage: DurableObjectStorage,
  options: { inFlight: boolean }
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
  if (options.inFlight)
    await storage.put("install:syncing", { at: Date.now() });
}

describe("what a completed pull is allowed to certify", () => {
  it("records the tree when it finished the pull that was outstanding", async () => {
    const stub = freshWorkspace("promote-with-marker");
    const landed = await runInDurableObject(stub, async (_instance, state) => {
      await seedFinishedInstall(state.storage, { inFlight: true });
      await jobOn(state.storage).onSyncComplete();
      return state.storage.get<{ fingerprint: string }>("install:completed");
    });
    expect(landed?.fingerprint).toBe("the-lockfile");
  });

  it("records nothing when there was no pull to finish", async () => {
    /**
     * A drain answers `complete` for an empty pull exactly as for one that moved
     * a tree — to the cursor, "nothing outstanding" and "everything arrived" are
     * the same answer. The case that makes the difference matter is a container
     * replaced after the install: its writes are unreachable, and the first pull
     * from the replacement finds a clean filesystem and completes at once.
     *
     * Promoting there would record a tree that never crossed, and the skip
     * condition would then decline to reinstall it — the one outcome a missing
     * dependency tree must not have.
     */
    const stub = freshWorkspace("promote-without-marker");
    const landed = await runInDurableObject(stub, async (_instance, state) => {
      await seedFinishedInstall(state.storage, { inFlight: false });
      await jobOn(state.storage).onSyncComplete();
      return state.storage.get("install:completed");
    });
    expect(landed).toBeUndefined();
  });

  it("clears the marker when the tree turns out to be unreachable", async () => {
    const stub = freshWorkspace("unrecoverable-clears-marker");
    const after = await runInDurableObject(stub, async (_instance, state) => {
      await seedFinishedInstall(state.storage, { inFlight: true });
      await jobOn(state.storage).onSyncUnrecoverable();
      return {
        marker: await state.storage.get("install:syncing"),
        completed: await state.storage.get("install:completed")
      };
    });
    // The wait is over, and deliberately without a fingerprint: the next access
    // should find a missing tree and arm an install rather than skip one.
    expect(after).toEqual({ marker: undefined, completed: undefined });
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

  it("still sends the subagent after an unreachable container", async () => {
    // The guard: without it the test above passes against a version that gives
    // every spawn failure the same sentence.
    const state = await failedInstall(UNREACHABLE, "install-unreachable");
    expect(state.state).toBe("failed");
    expect(state.state === "failed" && state.error).toMatch(/sb_exec/);
  });
});
