import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshWorkspace } from "../../test/workspace/do.js";
import { DEFAULT_INSTALL_PLAN, type InstallState } from "./install.js";
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
    command: "npm ci --no-audit --no-fund"
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
    // The record is what reaches the agent, so it must not send it after a
    // command that would have to reach the same container this one could not.
    expect(state.state === "failed" && state.error).toMatch(/redeploy/);
    expect(state.state === "failed" && state.error).not.toMatch(/bash/);
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
    expect(state.state === "failed" && state.error).not.toMatch(/bash/);
  });

  it("still sends the agent after an unreachable container", async () => {
    // The guard: without it the test above passes against a version that gives
    // every spawn failure the same sentence.
    const state = await failedInstall(UNREACHABLE, "install-unreachable");
    expect(state.state).toBe("failed");
    expect(state.state === "failed" && state.error).toMatch(/bash/);
  });
});

describe("one install at a time", () => {
  /**
   * A checkout whose probes take a moment, as a container's do, and whose
   * container counts the installs it is asked to spawn. The command never
   * finishes: what is pinned is how many start.
   */
  function countingWorkspace(read?: () => Promise<void>) {
    const present = new Set([
      "/workspace/repo/package.json",
      "/workspace/repo/package-lock.json"
    ]);
    const spawned: string[] = [];
    const running = () => ({
      result: () => new Promise(() => {}),
      [Symbol.dispose]: () => {}
    });
    const workspace = {
      fs: {
        exists: async (path: string) => {
          await (read?.() ?? new Promise((r) => setTimeout(r, 5)));
          return present.has(path);
        },
        readFile: async () => "{}"
      },
      runtime: {
        exec: async (command: string) => {
          spawned.push(command);
          return running();
        },
        // A re-attach finds the exec still going.
        getExec: async () => running()
      }
    } as unknown as Workspace;
    return { workspace, spawned };
  }

  it("spawns once for two overlapping starts", async () => {
    // Both callers are inside the probe window at once — which a check that
    // wrote nothing until after the probes let both through.
    const stub = freshWorkspace("install-overlap");
    const { workspace, spawned } = countingWorkspace();
    const states = await runInDurableObject(stub, async (_instance, s) => {
      const job = jobOn(s.storage, workspace);
      return await Promise.all([
        job.start({ dir: "/workspace/repo" }),
        job.start({ dir: "/workspace/repo" })
      ]);
    });
    expect(spawned).toHaveLength(1);
    expect(states.map((state) => state.state)).toEqual(["running", "running"]);
  });

  it("hands the record back when the install cannot be prepared", async () => {
    const stub = freshWorkspace("install-unprepared");
    const { workspace, spawned } = countingWorkspace(async () => {
      throw new Error("Network connection lost.");
    });
    const after = await runInDurableObject(stub, async (_instance, s) => {
      await seedFinishedInstall(s.storage, { tree: false });
      const job = jobOn(s.storage, workspace);
      await expect(job.start({ dir: "/workspace/repo" })).rejects.toThrow(
        "Network connection lost."
      );
      return await job.read();
    });
    expect(spawned).toHaveLength(0);
    // As it was, not the reservation's placeholder: a `running` record nothing
    // will finish shuts the gate until the staleness bound.
    expect(after.state).toBe("done");
  });

  it("fails the alarm's placeholder rather than restoring it", async () => {
    // The armed install's own placeholder is `running` with no alarm left to
    // run it, so putting it back would shut the gate just the same.
    const stub = freshWorkspace("install-unprepared-armed");
    const { workspace } = countingWorkspace(async () => {
      throw new Error("Network connection lost.");
    });
    const after = await runInDurableObject(stub, async (_instance, s) => {
      await seedFinishedInstall(s.storage, { tree: false });
      const armedAt = Date.now();
      await s.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: armedAt
      } satisfies InstallState);
      await s.storage.put("install:armed", armedAt);
      const job = jobOn(s.storage, workspace);
      await expect(job.onRun()).rejects.toThrow("Network connection lost.");
      return await job.read();
    });
    expect(after.state).toBe("failed");
    expect(after.state === "failed" && after.error).toMatch(
      /could not be prepared/
    );
  });
});

/**
 * The re-attach is for a `running` record a dead isolate left. Asked of an
 * install this isolate is still starting, it reaches the last container's exec,
 * or none, and fails an install that is about to run.
 */
describe("an install this isolate is driving is not re-attached", () => {
  const COMMAND = "npm ci --no-audit --no-fund";

  /** A checkout that installs, a finished command, and a count of re-attaches. */
  function drivenWorkspace(probe?: () => Promise<void>) {
    const present = new Set([
      "/workspace/repo/package.json",
      "/workspace/repo/package-lock.json"
    ]);
    const reattached: string[] = [];
    const workspace = {
      fs: {
        exists: async (path: string) => {
          await probe?.();
          return present.has(path);
        },
        readFile: async () => "{}"
      },
      runtime: {
        exec: async () => ({
          result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          [Symbol.dispose]: () => {}
        }),
        getExec: async (id: string) => {
          reattached.push(id);
          throw Object.assign(new Error(`execution ${id} was lost`), {
            code: "EEXEC_LOST"
          });
        }
      }
    } as unknown as Workspace;
    return { workspace, reattached };
  }

  it("leaves an armed install to the alarm", async () => {
    const stub = freshWorkspace("driven-armed");
    const { workspace, reattached } = drivenWorkspace();
    const state = await runInDurableObject(stub, async (_instance, s) => {
      await seedFinishedInstall(s.storage, { tree: true });
      const job = jobOn(s.storage, workspace);
      await job.containerGone();
      // What `advisories()` does: arm, then read the state straight back.
      await job.armIfTreeMissing();
      return await job.state();
    });
    expect(reattached).toEqual([]);
    expect(state.state).toBe("running");
  });

  it("leaves an install it has reserved but not yet spawned", async () => {
    const stub = freshWorkspace("driven-reserved");
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { workspace, reattached } = drivenWorkspace(() => gate);
    const during = await runInDurableObject(stub, async (_instance, s) => {
      const job = jobOn(s.storage, workspace);
      const starting = job.start({ dir: "/workspace/repo" });
      // Reserved, and held in the probe that comes before the spawn.
      while ((await job.read()).state !== "running") await scheduler.wait(1);
      const read = await job.state();
      open();
      await starting;
      return read;
    });
    expect(reattached).toEqual([]);
    expect(during.state).toBe("running");
  });

  it("runs the alarm's placeholder without re-attaching to it", async () => {
    const stub = freshWorkspace("driven-alarm");
    const { workspace, reattached } = drivenWorkspace();
    const after = await runInDurableObject(stub, async (_instance, s) => {
      const armedAt = Date.now();
      await s.storage.put("install", {
        state: "running",
        command: COMMAND,
        startedAt: armedAt
      } satisfies InstallState);
      await s.storage.put("install:armed", armedAt);
      await s.storage.put("install:context", {
        dir: "/workspace/repo",
        command: COMMAND
      });
      const job = jobOn(s.storage, workspace);
      await job.onRun();
      return await job.read();
    });
    expect(reattached).toEqual([]);
    expect(after.state).toBe("done");
  });
});
