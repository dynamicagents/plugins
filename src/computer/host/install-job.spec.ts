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

/** A job wired to one workspace's real storage, and nothing else it does not need. */
function jobOn(storage: DurableObjectStorage): InstallJob {
  return new InstallJob({
    storage,
    // Untouched on the sync paths below, which are storage reads and writes.
    scheduler: {} as never,
    workspace: () => ({}) as unknown as Workspace,
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
