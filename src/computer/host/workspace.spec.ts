import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { TestWorkspaceDO } from "../../../test/worker.js";
import {
  freshWorkspace,
  workspaceNamespace
} from "../../../test/computer/do.js";
import { DEFAULT_INSTALL_PLAN, type InstallState } from "../install.js";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import {
  computer,
  computerWorkspace,
  openWorkspace,
  openWorkspaceFs,
  type ComputerConfig
} from "../index.js";
import { testPluginContext } from "../../../test/helpers.js";
import { DEFAULT_SCRATCH_DIR } from "../../scratch/index.js";
import { TRUST_CA_COMMAND } from "./ca-trust.js";
import { pathExists } from "../read.js";
import { readyWithin } from "./workspace.js";

/**
 * The plan `TestWorkspaceDO` is configured with — read here rather than
 * restated, so a spec asserting against the install timeout cannot drift from
 * the host it is driving.
 */
const INSTALL_PLAN = { ...DEFAULT_INSTALL_PLAN, overrides: {} };

/**
 * The install gate, and the two ways it can hang forever.
 *
 * `running` is the only install state that **blocks work**: `bash` waits on
 * it and then refuses to run anything. Every other state is a fact the agent
 * can act on — so `running` is the one that must never outlive the command it
 * describes. A `runtime.exec` that throws on the container's WebSocket is how it
 * gets orphaned: the record stays `running` with nothing draining it and no
 * watchdog armed, and every later `bash` waits ninety seconds and runs
 * nothing until the task dies on its own timeout.
 *
 * The tests below run **without a container**, which is not a limitation here
 * but the point: the pool cannot start one, so `runtime.exec` fails in exactly
 * that way.
 */

/**
 * The same workspace, through a new stub, once a reclaim has reset it.
 *
 * A reclaim resets the isolate after it returns, and a stub connected to an
 * object that reset stays broken — every later call on it throws. A caller in
 * production gets a new stub per request, so this is what one sees.
 *
 * **Waits for the reset rather than for a duration.** The reset is an abort the
 * reclaim arms and the alarm carries out, so it lands some time after
 * `reclaimIfIdle` returns — and a fixed sleep either outlasts it on a fast
 * machine or does not on a slow one, where the abort arrives in the middle of
 * whatever the test did next and fails it somewhere unrelated. The old instance
 * throwing *is* the event, so that is what this waits for.
 */
async function afterReclaim(stub: DurableObjectStub<TestWorkspaceDO>) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      // Any call at all: what is being watched for is the instance ceasing to
      // answer, not anything it would answer with.
      await runInDurableObject(stub, () => {});
    } catch {
      return workspaceNamespace.get(stub.id);
    }
    if (Date.now() > deadline)
      throw new Error("the reclaim never reset the isolate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Read the raw install record, bypassing the staleness repair `advisories` applies. */
function storedInstall(stub: DurableObjectStub<TestWorkspaceDO>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<InstallState>("install")
  );
}

/**
 * Put a checkout in the workspace — a directory with a `.git` in it, and nothing
 * else.
 *
 * **Separate from {@link seedNodeCheckout}, and keeping them separate is the
 * point.** A lockfile is what makes the install resolver act, so a fixture that
 * writes one takes the `run` branch; a fixture that does not takes `skip`. A
 * single helper doing both puts every workspace in this file on one of those
 * paths and leaves the other untested — and `skip` is the branch that decides
 * whether a repository can be worked in at all.
 *
 * So the two facts stay apart: this is a checkout, that is a checkout which
 * installs. Reach for the second only where the resolver has to act.
 */
async function seedGitCheckout(
  stub: DurableObjectStub<TestWorkspaceDO>,
  dir: string
) {
  using ws = await openWorkspace(stub);
  await ws.fs.mkdir(`${dir}/.git`, { recursive: true });
  // `.git` is a directory in a real checkout, but what the workspace probes for
  // is its presence, and a file is what a fixture can create in one call. It is
  // the same question either way: is there a git repository here.
  await ws.fs.writeFile(`${dir}/.git/HEAD`, "ref: refs/heads/main\n");
}

/** A checkout the install resolver will act on: git, plus a lockfile. */
async function seedNodeCheckout(
  stub: DurableObjectStub<TestWorkspaceDO>,
  dir: string
) {
  await seedGitCheckout(stub, dir);
  using ws = await openWorkspace(stub);
  await ws.fs.writeFile(`${dir}/package.json`, '{"name":"probe"}');
  await ws.fs.writeFile(`${dir}/package-lock.json`, '{"lockfileVersion":3}');
}

describe("the install gate", () => {
  it("reports failed, not running, when the command cannot be started", async () => {
    const stub = freshWorkspace("install-spawn");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    // The resolver now has a lockfile to act on, so `startInstall` gets all the
    // way to the spawn — where there is no container, which is precisely how it
    // failed in production.
    const state = await stub.startInstall({ dir });

    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.command).toBe("npm ci --no-audit --no-fund");
    }

    // And it is written down: a caller reading the record later has to see the
    // same answer this one got, or the gate closes behind it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  it("abandons a running record that is past its own timeout", async () => {
    const stub = freshWorkspace("install-stale");
    const limit = INSTALL_PLAN.timeoutMs ?? 20 * 60_000;

    // Seed the exact state production was stuck in: running, nobody draining
    // it, and long enough ago that the runtime would have killed the command.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - limit - 10 * 60_000
      } satisfies InstallState)
    );

    const [advisory] = await stub.advisories();

    expect(advisory?.kind).toBe("deps-broken");
    // The message is load-bearing — it is what the agent reads instead of
    // waiting, so it has to say the command is not coming back.
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).toMatch(/not going to finish/);
    }

    // And it is written down, so the next `bash` does not re-derive it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  /**
   * `repo_clone` starts the install, and a recovered turn starts it again — three
   * times in fifty seconds is a real rate. Spawns share an exec id, so each
   * displaces the last while the displaced command's drain stays attached: it
   * then writes *its* verdict over a record describing an install that is still
   * running, and the agent reads a failure belonging to a command that no
   * longer exists.
   */
  it("resolves a running record before starting another install", async () => {
    const stub = freshWorkspace("install-reentry");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    const startedAt = Date.now() - 30_000;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt
      } satisfies InstallState)
    );

    const state = await stub.startInstall({ dir });

    // The invariant: the pre-existing `running` is never simply ignored. It is
    // either confirmed live and handed back, or resolved — and here, with no
    // container to re-attach to, resolved is the honest answer.
    expect(state).not.toMatchObject({ state: "running", startedAt });
    // Whatever it decided, the record agrees. A returned verdict that differs
    // from the stored one is how the agent ends up reading a result that
    // describes nothing.
    expect((await storedInstall(stub))?.state).toBe(state.state);
    // The guard's live path — returning the in-flight install untouched — needs
    // a real container to reach, since the record is verified rather than
    // trusted. It is covered end to end rather than here.
  });

  it("leaves a young running record alone", async () => {
    const stub = freshWorkspace("install-young");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 30_000
      } satisfies InstallState)
    );

    // Half a minute in, with no container to re-attach to. The re-attach fails
    // and says so — what must *not* happen is the staleness bound firing early
    // and declaring a healthy install dead thirty seconds after it started.
    const [advisory] = await stub.advisories();
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).not.toMatch(/not going to finish/);
    }
  });

  /**
   * The counterweight to the staleness bound: `skipped` means the resolver looked
   * and found nothing to install, so a missing `node_modules` is the correct and
   * permanent state rather than a symptom. Nothing should chase it.
   */
  it("leaves a checkout with nothing to install alone", async () => {
    const stub = freshWorkspace("install-skipped");

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "skipped",
        reason: "no package.json"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir: "/workspace/probe",
        fingerprint: null,
        command: "(none)",
        startedAt: Date.now()
      });
    });

    // `deps-absent`, not silence: a session that finds no `node_modules` should
    // be told the host looked and there was nothing to install, rather than left
    // to wonder whether an install is still coming.
    expect(await stub.advisories()).toEqual([
      { kind: "deps-absent", reason: "no package.json" }
    ]);
  });

  /** Nothing vouches for a tree from the moment it starts being rebuilt. */
  it("drops the tree record, and the retired ones, when a real install starts", async () => {
    const stub = freshWorkspace("install-clears-tree");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install:tree", {
        dir,
        fingerprint: "stale",
        at: 0
      });
      await state.storage.put("install:completed", {
        fingerprint: "stale",
        at: 0
      });
      await state.storage.put("install:syncing", { at: 0 });
    });

    await stub.startInstall({ dir });

    expect(
      await runInDurableObject(stub, async (_instance, state) => [
        await state.storage.get("install:tree"),
        await state.storage.get("install:completed"),
        await state.storage.get("install:syncing")
      ])
    ).toEqual([undefined, undefined, undefined]);
  });

  it("does not auto-retry a failed install", async () => {
    const stub = freshWorkspace("install-failed-sticky");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 30_000,
        error: "the container was unreachable"
      } satisfies InstallState)
    );

    // Reported whatever the `node_modules` probe says. That probe is `test -d`,
    // which the wreckage of a half-finished install satisfies just as well as a
    // healthy tree, so it qualifies the advisory rather than deleting it — and
    // the record itself is never rewritten to say something it did not observe.
    const advisories = await stub.advisories();
    expect(advisories.map((a) => a.kind)).toEqual(["deps-broken"]);
    expect((await storedInstall(stub))?.state).toBe("failed");
  });
});

/**
 * Where the work is — the question `checkoutDir()` answers, and the invariants
 * that make its answer worth acting on.
 *
 * Two properties, and each has a test here because each can be lost on its own:
 *
 * - **A checkout is recorded whether or not anything was installed into it.**
 *   The install resolver skips a checkout it finds nothing to do in, and that
 *   says nothing about whether there is a checkout. See `noteCheckout` in
 *   `./workspace.ts` for why the two records are separate.
 * - **The answer is probed, not remembered.** A recorded path is where to look;
 *   `.git` being there is what makes it true. A session's cwd and the
 *   cancellation `git reset --hard` both act on it, and neither recovers from a
 *   confident wrong answer.
 */
describe("where the work is", () => {
  it("reports a checkout the install had nothing to do in", async () => {
    const stub = freshWorkspace("checkout-no-lockfile");
    const dir = "/workspace/spike";
    // A repository with a README and no `package.json` — the shape the install
    // resolver skips.
    await seedGitCheckout(stub, dir);

    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/spike" });
    const state = await stub.startInstall({ dir });

    // The install correctly has nothing to do...
    expect(state.state).toBe("skipped");
    // ...and that must not be the same thing as having nowhere to work.
    expect(await stub.checkoutDir()).toBe(dir);
  });

  /**
   * The claim being made is "there is a git repository at this path", not "this
   * path was written down once". Only a probe can support the first, and the
   * difference is what a session's cwd and a `git reset --hard` both depend on.
   */
  it("stops reporting a checkout that is no longer there", async () => {
    const stub = freshWorkspace("checkout-vanished");
    const dir = "/workspace/gone";
    await seedGitCheckout(stub, dir);
    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/gone" });
    expect(await stub.checkoutDir()).toBe(dir);

    using ws = await openWorkspace(stub);
    await ws.fs.rm(`${dir}/.git`, { recursive: true });

    // The record still says `dir`. The answer is `undefined` anyway, because the
    // record is where to look and `.git` is what makes it true.
    expect(await stub.checkoutDir()).toBeUndefined();
  });

  /**
   * A scratchpad is a repository whose remote is nowhere, and this is the line
   * where that claim has to hold: it has no install to write a context as a side
   * effect — a directory with no `package.json` is exactly what the resolver
   * skips — so without the record it could be created and never delegated into.
   */
  it("reports a scratchpad the same way it reports a checkout", async () => {
    const stub = freshWorkspace("checkout-scratch");
    await seedGitCheckout(stub, DEFAULT_SCRATCH_DIR);

    const noted = await stub.noteCheckout({
      dir: DEFAULT_SCRATCH_DIR,
      kind: "scratch"
    });

    // `present` is the same probe the delegation will make, reported at the
    // moment the scratchpad is opened rather than a delegation later.
    expect(noted).toEqual({ dir: DEFAULT_SCRATCH_DIR, present: true });
    expect(await stub.checkoutDir()).toBe(DEFAULT_SCRATCH_DIR);
  });

  /** An empty workspace has nowhere to work, and must keep saying so. */
  it("reports nothing for a workspace nothing has been opened in", async () => {
    const stub = freshWorkspace("checkout-empty");
    expect(await stub.checkoutDir()).toBeUndefined();
  });
});

/**
 * Arming the install when the workspace has no dependency tree.
 *
 * The tree lives on the container's disk, so the signal is the container: a
 * tree is recorded by the install that built it and dropped when that container
 * is seen gone. With no container in this pool, every access sees it gone.
 *
 * It still has to be caught here rather than left to `repo_clone`: a follow-up
 * task never calls it, because its checkout is already here, and the turn then
 * pays 99 seconds of `npm ci` inside itself. Nor can the gate close it by
 * installing directly — an install started from a poll that returns in
 * milliseconds loses its drain with that invocation and leaves a half-written
 * tree.
 *
 * So detection is a local read here, and the install itself belongs to the
 * alarm. These tests cover the detection; the alarm's own handler needs a
 * container and is covered end to end.
 */
describe("arming an install when the tree is missing", () => {
  const armed = (stub: DurableObjectStub<TestWorkspaceDO>) =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.get<number>("install:armed")
    );

  /**
   * A workspace that installed successfully; `tree` records that its container
   * held the result.
   */
  async function seedInstalled(
    stub: DurableObjectStub<TestWorkspaceDO>,
    dir: string,
    options: { tree?: boolean } = {}
  ) {
    // The checkout has to be here too, or the resolver finds no `package.json`,
    // answers `skip`, and the armed install never reaches a spawn — passing
    // while asserting half of what it claims.
    await seedNodeCheckout(stub, dir);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "done",
        command: "npm ci --no-audit --no-fund",
        exitCode: 0,
        finishedAt: Date.now() - 60_000,
        ms: 80_000
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
      if (options.tree)
        await state.storage.put("install:tree", {
          dir,
          fingerprint: "stale",
          at: Date.now() - 60_000
        });
    });
  }

  /** Touch the workspace the way anything reaching it does — via the stub hook. */
  async function touchWorkspace(stub: DurableObjectStub<TestWorkspaceDO>) {
    using ws = await openWorkspace(stub);
    void ws;
  }

  /**
   * Wait for the armed install to reach a terminal state.
   *
   * The alarm fires promptly enough to race a read of `install:armed`, which is
   * the system working — so these assert the settled outcome rather than a
   * marker that is meant to be transient.
   */
  async function settled(stub: DurableObjectStub<TestWorkspaceDO>, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await storedInstall(stub);
      if (state?.state !== "running") return state;
      if (Date.now() > deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("arms on the first workspace access, and the alarm carries it out", async () => {
    const stub = freshWorkspace("arm-cold");
    await seedInstalled(stub, "/workspace/probe");

    // `getWorkspace` goes through `__getWorkspaceStub`, which is the hook — the
    // earliest point in a task, before any command runs.
    await touchWorkspace(stub);

    // `failed` is the whole assertion. Getting there means the record left
    // `done` (so arming happened) *and* something tried to spawn an install (so
    // the alarm ran it) — and with no container in the pool, a spawn cannot
    // succeed.
    expect((await settled(stub))?.state).toBe("failed");
  });

  /**
   * The bound on retrying, and it has to exist.
   *
   * Arming is naturally once-only for an install that *succeeds*: it leaves a
   * tree in the workspace, so the probe short-circuits everything after. A
   * failing one has no such property — it lands back on `failed` with the tree
   * still absent, and `__getWorkspaceStub` is the busiest entry point in the
   * object, so without a cooldown it would re-arm on essentially every tool
   * call. That bound is `INSTALL_ARM_COOLDOWN_MS`, and this is what holds it.
   */
  it("does not re-arm again immediately after a failure", async () => {
    const stub = freshWorkspace("arm-cooldown");
    await seedInstalled(stub, "/workspace/probe");

    await touchWorkspace(stub);
    expect((await settled(stub))?.state).toBe("failed");
    const after = await storedInstall(stub);

    // Two more accesses, as a task would make dozens of.
    await touchWorkspace(stub);
    await touchWorkspace(stub);

    // Untouched: no new `running`, and the same terminal record as before.
    expect((await storedInstall(stub))?.state).toBe("failed");
    expect(await storedInstall(stub)).toStrictEqual(after);
    expect(await armed(stub)).toBeUndefined();
  });

  /**
   * A failed install must not poison the workspace forever.
   *
   * Arming only for `done` leaves a failed record standing, so the next task
   * declines to arm and is rescued only if the parent happens to call
   * `repo_clone` — and without that coincidence the agent is back to running
   * `npm ci` by hand inside the turn, which is what all of this prevents.
   */
  it("arms for a workspace whose last install failed", async () => {
    const stub = freshWorkspace("arm-after-failure");
    const dir = "/workspace/probe";
    await seedNodeCheckout(stub, dir);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 60_000,
        error: "the container was unreachable"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
    });

    await touchWorkspace(stub);

    /**
     * Asserting `failed` would prove nothing — the record went in `failed` and a
     * version that armed nothing would leave it that way. The *message* is what
     * discriminates: the seeded one is invented by this test, and only a real
     * spawn attempt replaces it with the one the install job writes when the
     * container cannot be reached.
     */
    const state = await settled(stub);
    expect(state?.state).toBe("failed");
    if (state?.state === "failed") {
      expect(state.error).toMatch(/could not be started/);
      expect(state.error).not.toMatch(/the container was unreachable$/);
    }
    expect(await armed(stub)).toBeUndefined();
  });

  /**
   * A tree recorded for a container that is not running went with it. The
   * record is dropped before the arming check reads it, so the install runs.
   */
  it("installs again when the container that held the tree is gone", async () => {
    const stub = freshWorkspace("arm-tree-container-gone");
    await seedInstalled(stub, "/workspace/probe", { tree: true });

    await touchWorkspace(stub);

    expect((await settled(stub))?.state).toBe("failed");
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("install:tree")
      )
    ).toBeUndefined();
  });

  /**
   * `bash` reads the advisories before its `#ready()` starts a container, so
   * that read has to arm the install, or the gate lets the command outrun it.
   */
  it("arms from the gate's own read, before a command starts a container", async () => {
    const stub = freshWorkspace("arm-from-gate");
    await seedInstalled(stub, "/workspace/probe", { tree: true });

    await stub.advisories();

    expect((await settled(stub))?.state).toBe("failed");
  });

  /**
   * A caller's very first task: nothing has ever been installed, so there is no
   * record of *where* to install. `repo_clone` and its `afterCheckout` hook own
   * this case.
   */
  it("arms nothing when no install has ever run", async () => {
    const stub = freshWorkspace("arm-first-task");

    await touchWorkspace(stub);

    expect(await armed(stub)).toBeUndefined();
    expect((await storedInstall(stub))?.state ?? "idle").toBe("idle");
  });
});

/**
 * Keeping the workspace level with the container, which nothing else will do.
 *
 * A command's own bracket pulls its writes back when it exits, and that pull can
 * fail while the command succeeds. The runtime reports it and schedules nothing:
 * the cursor is durable, so a later `pull()` resumes the same operation, and
 * driving that later `pull()` is the host's half of syncing.
 *
 * These assert it on the idle path and the git path, the places the host has to
 * act. Both run without a container, which is the case the drain has to survive
 * rather than the case it exists for — with none running there is nothing left
 * to pull, because whatever a container held that never arrived went with it.
 */
describe("draining an outstanding pull", () => {
  /**
   * The drain must never start a container.
   *
   * Opening a backend handle would launch one, and a pull against a replacement
   * finds an empty filesystem rather than the writes it was after. Launching a
   * container to discover that is pure cost — and on the idle path it would
   * restart the very container the deadline had just decided to stop.
   *
   * **The property itself is pinned next door**, in `./sync.spec.ts`, which
   * asserts the workspace is never opened. It has to be: the pool starts no
   * containers, so `container.running` reads false here whatever the handler
   * does, and an assertion on it cannot fail. What this adds is the wiring —
   * that a due deadline reaches the drain through the alarm at all.
   */
  it("starts no container when none is running", async () => {
    const stub = freshWorkspace("drain-no-container");
    await seedGitCheckout(stub, "/workspace/probe");

    await runInDurableObject(stub, async (instance, state) => {
      // The idle handler's own path, with the clock far enough back that it
      // decides to stop. It reaches the drain first, which must decline.
      await state.storage.put("lastUsedAt", Date.now() - 24 * 60 * 60_000);
      // Moving the clock is not enough to make the handler run: `lastUsedAt` is
      // storage, and the schedule is a row with its own due time a day out. The
      // assertion below passes vacuously without this — a container that never
      // started because nothing ever asked.
      expect(forceDue(state, "containerIdle")).toBeGreaterThan(0);
      await instance.alarm?.();
      expect(state.container?.running ?? false).toBe(false);
    });
  });

  /** The tree lived on the container's disk, so stopping it ends the tree. */
  it("drops the tree record when the idle deadline stops the container", async () => {
    const stub = freshWorkspace("idle-drops-tree");
    const dir = "/workspace/probe";
    await seedGitCheckout(stub, dir);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("install:tree", { dir, fingerprint: "x", at: 0 });
      await state.storage.put("lastUsedAt", Date.now() - 24 * 60 * 60_000);
      expect(forceDue(state, "containerIdle")).toBeGreaterThan(0);
      await instance.alarm?.();
    });

    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("install:tree")
      )
    ).toBeUndefined();
  });

  /**
   * Git runs **here**, against this object's storage, so it reads a tree that is
   * only as current as the last pull. A commit made in the container that has
   * not arrived is a commit `git push` cannot see — and pushing anyway publishes
   * a tree the agent did not produce, which reports success and shows an older
   * branch on the forge.
   *
   * With no container there is nothing outstanding, so this asserts the other
   * half: the check does not stand between a workspace and its own git.
   */
  it("lets git run when there is nothing outstanding", async () => {
    const stub = freshWorkspace("drain-git-clear");
    const dir = "/workspace/probe";
    await seedGitCheckout(stub, dir);

    // Refused for want of an allowed host, which is a decision made *after* the
    // sync check — so reaching it at all proves the check passed.
    const result = await stub.gitPush({
      url: "https://github.example/acme/api.git",
      dir,
      branch: "main",
      allowedHosts: []
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/reached the workspace/);
    }
  });
});

/**
 * A reclaimed workspace reads exactly like one nobody ever used, and these hold
 * the line between them — see `reclaimIfIdle` in `./workspace.ts` for why an
 * absent `lastUsedAt` must not read as idle.
 */
describe("reclaiming an idle workspace", () => {
  it("reports nothing to do for a workspace nothing has ever used", async () => {
    const stub = freshWorkspace("never-used");

    const result = await stub.reclaimIfIdle();

    // Not `reclaimed: true` with an epoch-sized `idleMs`.
    expect(result.reclaimed).toBe(false);
    expect(result.idleMs).toBe(0);
  });

  it("stays false however long the sweep waits", async () => {
    // No `maxIdleMs` can rescue a missing record that reads as "idle forever",
    // so the threshold is not where this is decided.
    const stub = freshWorkspace("never-used-zero-threshold");

    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(false);
  });

  /**
   * The other half: a workspace that has been used is still reclaimable, so the
   * rule above cannot collapse into "never reclaim anything".
   */
  it("still reclaims one that was used and then went idle", async () => {
    const stub = freshWorkspace("used-then-idle");
    // `getWorkspace` is the busiest entry point and the one that touches.
    using ws = await openWorkspace(stub);
    await ws.fs.mkdir("/workspace/repo", { recursive: true });

    // A zero threshold stands in for a week having passed.
    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(true);
    // And once emptied it reports nothing to do rather than reclaiming again,
    // which is the loop this whole describe exists for.
    const reclaimed = await afterReclaim(stub);
    expect((await reclaimed.reclaimIfIdle(0)).reclaimed).toBe(false);
  });
});

/**
 * The CA-trust command, which has no other way to be wrong safely.
 *
 * It is a shell script carried as a string and run in a container the suite
 * cannot reach, so the only failure that matters — it does not parse — would
 * otherwise surface as a workspace with no working TLS and a log line nobody
 * connects to a missing `\` .
 */
describe("the interception CA command", () => {
  const lines = TRUST_CA_COMMAND.split("\n");

  /**
   * A newline ends a command in sh, so an `&&` or `||` opening a line is a
   * syntax error rather than the continuation it looks like: the operators have
   * to trail.
   */
  it("never opens a line with a shell operator", () => {
    for (const line of lines) {
      expect(line.trimStart()).not.toMatch(/^(&&|\|\|)/);
    }
  });

  /**
   * The listing runs before, and outside, the `if`. When the CA is missing it is
   * the only evidence separating "mounted somewhere else" from "never
   * provisioned", which is the question the whole step exists to answer.
   */
  it("lists the directory whether or not the CA is there", () => {
    expect(lines[0]).toContain("ls -A /etc/cloudflare/certs");
    expect(TRUST_CA_COMMAND).toContain("NO CA AT");
  });
});

/**
 * The CA is trusted on container liveness, never on install state.
 *
 * Those are not the same question, and a `skipped` workspace is where they come
 * apart: the resolver found nothing to install, so nothing ever arms an install
 * again — and every command in every replacement container would run against an
 * untrusted CA, failing TLS with an error that names no cause.
 *
 * These run **without a container**, like the rest of this file, so the trust
 * command cannot succeed. That is the point: what is asserted is whether it is
 * *attempted*, and an attempt is observable either way.
 */
describe("trusting the interception CA", () => {
  /** Every outcome of the trust step logs; a skipped one logs nothing at all. */
  function attempts(calls: unknown[][]): number {
    return calls.filter(([msg]) =>
      String(msg).includes("trust the interception CA")
    ).length;
  }

  it("happens for a workspace with nothing to install", async () => {
    const stub = freshWorkspace("ca-skipped-install");

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "skipped",
        reason: "no package.json"
      } satisfies InstallState);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await openWorkspace(stub);
      void ws;
      expect(attempts(warn.mock.calls)).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * An install refuses to begin when the workspace is full — which is the one
   * situation where the agent most needs working egress to dig itself out. So
   * the trust must not sit behind that refusal: reaching the object is enough.
   */
  it("happens before anything that can refuse an install", async () => {
    const stub = freshWorkspace("ca-before-refusals");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await openWorkspace(stub);
      void ws;
      // No checkout, no install record, nothing armed.
      expect(await storedInstall(stub)).toBeUndefined();
      expect(attempts(warn.mock.calls)).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * What a file tool waits for — `__getWorkspaceFsStub` in `./workspace.ts` holds
 * why.
 *
 * These run **without a container**, which is what makes it observable: the
 * trust command cannot succeed here, so *attempting* it is what logs.
 */
describe("the filesystem stub", () => {
  /** Every outcome of the trust step logs; a skipped one logs nothing at all. */
  function trustAttempts(calls: unknown[][]): number {
    return calls.filter(([msg]) =>
      String(msg).includes("trust the interception CA")
    ).length;
  }

  const warmRows = async (stub: DurableObjectStub<TestWorkspaceDO>) =>
    (
      await runInDurableObject(stub, (_instance, state) => scheduleRows(state))
    ).filter((row) => row.callback === "containerWarm");

  /** Poll until `check` holds: the alarm fires on its own clock. */
  async function eventually(
    check: () => boolean,
    ms = 5_000
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  /** `pathExists` takes this path; `.call` on a stub method throws DataCloneError. */
  it("answers pathExists over the stub", async () => {
    const stub = freshWorkspace("fs-stub-exists");
    await seedGitCheckout(stub, "/workspace/probe");
    using ws = await openWorkspaceFs(stub);
    expect(await pathExists(ws.fs, "/workspace/probe/.git/HEAD")).toBe(true);
    expect(await pathExists(ws.fs, "/workspace/probe/absent")).toBe(false);
  });

  it("reads the workspace without starting a container", async () => {
    const stub = freshWorkspace("fs-no-container");
    await seedGitCheckout(stub, "/workspace/probe");

    // Spied after seeding, which opens the workspace the other way.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await openWorkspaceFs(stub);
      // Still answers, and answers from here.
      expect(await ws.fs.readdir("/workspace")).toHaveLength(1);
      expect(trustAttempts(warn.mock.calls)).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks the alarm to start the container it did not wait for", async () => {
    const stub = freshWorkspace("fs-warms");
    const dir = "/workspace/probe";
    await seedGitCheckout(stub, dir);
    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/spike" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await openWorkspaceFs(stub);
      void ws;

      // Armed for now, so the alarm carries it out on its own.
      expect(await eventually(() => trustAttempts(warn.mock.calls) > 0)).toBe(
        true
      );
    } finally {
      warn.mockRestore();
    }
  });

  /** Nothing to push and nothing to run, so a warm would only bill. */
  it("warms nothing for a workspace with no checkout", async () => {
    const stub = freshWorkspace("fs-no-checkout");

    using ws = await openWorkspaceFs(stub);
    void ws;

    expect(await warmRows(stub)).toHaveLength(0);
  });

  /**
   * The rule {@link touch} lives under, on a path that runs per tool call: a
   * schedule is a minted row, so arming without cancelling leaves one per read.
   */
  it("keeps one warm row however many files are read", async () => {
    const stub = freshWorkspace("fs-one-row");
    const dir = "/workspace/probe";
    await seedGitCheckout(stub, dir);
    await stub.noteCheckout({ dir, kind: "repo", repo: "acme/spike" });

    for (let i = 0; i < 3; i++) {
      using ws = await openWorkspaceFs(stub);
      await ws.fs.readdir("/workspace");
    }

    expect((await warmRows(stub)).length).toBeLessThanOrEqual(1);
  });
});

/**
 * Bring a deadline forward to now, so `alarm()` actually runs its handler.
 *
 * The suite cannot wait out an idle window, and a deadline that is not due is a
 * handler that does not run — which a test asserting what the handler *did* would
 * pass without noticing. Reaches into the scheduler's own table, like
 * {@link scheduleRows}, because the times are the thing being faked.
 */
function forceDue(state: DurableObjectState, callback: string): number {
  return state.storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE fn = ?",
    Date.now() - 1_000,
    callback
  ).rowsWritten;
}

/**
 * The scheduler's rows, read from storage. A schedule is a row in the lifecycle's
 * job queue under the scheduler's capability, its callback name in `fn`. No
 * table at all is no rows: storage that was just wiped has not had the queue
 * recreated yet.
 */
function scheduleRows(
  state: DurableObjectState
): { id: string; callback: string }[] {
  const [table] = state.storage.sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'"
    )
    .toArray();
  if (!table) return [];
  return state.storage.sql
    .exec<{ id: string; callback: string }>(
      "SELECT id, fn AS callback FROM cf_agents_jobs WHERE capability = 'scheduler'"
    )
    .toArray();
}

/**
 * A schedule is a minted row rather than a keyed upsert — see `IDLE_RECLAIM_ID`
 * in `./workspace.ts` — so moving a deadline leaves a second row unless it
 * cancels the first, and `#touch()` runs on every entry point.
 *
 * Counted through storage rather than through a scheduler handle, because the
 * count is the durable consequence and a handle would only report what the code
 * under test already believes.
 */
describe("the idle deadlines, over a scheduler that has no upsert", () => {
  /** The same hook anything reaching this object goes through. */
  async function touch(stub: DurableObjectStub<TestWorkspaceDO>) {
    using ws = await openWorkspace(stub);
    void ws;
  }

  const schedules = (stub: DurableObjectStub<TestWorkspaceDO>) =>
    runInDurableObject(stub, (_instance, state) => scheduleRows(state));

  it("keeps one row per deadline however often the workspace is touched", async () => {
    const stub = freshWorkspace("touch-repeatedly");

    await touch(stub);
    const afterOne = await schedules(stub);

    await touch(stub);
    await touch(stub);
    await touch(stub);
    const afterFour = await schedules(stub);

    // The two idle timers, and no more of them for three further touches.
    expect(afterFour).toHaveLength(afterOne.length);
    const callbacks = afterFour.map((row) => row.callback).sort();
    expect(callbacks).toContain("idleReclaim");
    expect(callbacks).toContain("containerIdle");
  });

  /**
   * Concurrent touches, which is the case that actually happens: several
   * sub-agents reach one workspace at once, and each entry point moves both
   * deadlines. A move is read-cancel-create-write across several awaits, so if
   * two interleaved they could cancel the same row, create two replacements and
   * keep one id — leaving a schedule nothing can reach.
   *
   * They do interleave: the input gate closes while a storage operation is in
   * flight, not for the stretch between two of them. So `namedDeadline`
   * serializes moves per key, and this is the end-to-end half of proving it —
   * the deterministic unit lives in core, and this shows the object really gets
   * it, through a real Durable Object under concurrent RPCs.
   *
   * Worth having both, because this one passes on timing alone when the
   * serialization is missing. It only failed in a full-suite run.
   */
  it("keeps one row per deadline under concurrent touches", async () => {
    const stub = freshWorkspace("touch-concurrent");

    await Promise.all([
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub),
      touch(stub)
    ]);

    const rows = await schedules(stub);
    const byCallback = rows.map((row) => row.callback).sort();
    expect(byCallback.filter((c) => c === "idleReclaim")).toHaveLength(1);
    expect(byCallback.filter((c) => c === "containerIdle")).toHaveLength(1);
  });

  it("moves the deadline rather than adding beside it", async () => {
    const stub = freshWorkspace("touch-moves");

    await touch(stub);
    const first = await schedules(stub);
    const firstIdle = first.find((row) => row.callback === "idleReclaim");
    expect(firstIdle).toBeDefined();

    await touch(stub);
    const second = await schedules(stub);
    const secondIdle = second.find((row) => row.callback === "idleReclaim");

    // A different row, not a second one: the id changes because the deadline was
    // cancelled and recreated, and the count does not.
    expect(secondIdle).toBeDefined();
    expect(secondIdle!.id).not.toBe(firstIdle!.id);
    expect(second.filter((row) => row.callback === "idleReclaim")).toHaveLength(
      1
    );
  });

  /**
   * A reclaimed workspace must not wake again, and must still work if it is
   * used again.
   *
   * `deleteAll()` takes the lifecycle's job queue table with it, and an
   * instance that has already created that table will not create it again. So
   * a touch on the same instance after a reclaim schedules against a table that
   * is no longer there, and the workspace stops arming its timers for good. The
   * reclaim resets the isolate so that the next call is a fresh instance, and
   * this test is what pins that the fresh instance schedules.
   */
  it("leaves no schedule behind after a reclaim, and still schedules after one", async () => {
    const stub = freshWorkspace("reclaim-clears");
    await touch(stub);
    expect((await schedules(stub)).length).toBeGreaterThan(0);

    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(true);
    const reclaimed = await afterReclaim(stub);
    expect(await schedules(reclaimed)).toHaveLength(0);

    await touch(reclaimed);
    const again = (await schedules(reclaimed))
      .map((row) => row.callback)
      .sort();
    expect(again).toContain("idleReclaim");
    expect(again).toContain("containerIdle");
  });
});

describe("purging synced dependency trees", () => {
  it("deletes every node_modules once, and leaves the source", async () => {
    const stub = freshWorkspace("purge-synced-trees");
    // Written straight into storage: any stub access would purge first.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("deps:purged", Date.now());
    });
    await seedGitCheckout(stub, "/workspace/probe");
    {
      using ws = await openWorkspaceFs(stub);
      await ws.fs.mkdir("/workspace/probe/node_modules/zod", {
        recursive: true
      });
      await ws.fs.writeFile("/workspace/probe/node_modules/zod/index.js", "x");
      await ws.fs.mkdir("/workspace/probe/core/node_modules/a", {
        recursive: true
      });
      await ws.fs.writeFile("/workspace/probe/core/node_modules/a/b.js", "x");
      await ws.fs.writeFile("/workspace/probe/core/index.ts", "src");
    }
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.delete("deps:purged")
    );

    {
      using ws = await openWorkspace(stub);
      void ws;
    }

    using ws = await openWorkspaceFs(stub);
    expect(await pathExists(ws.fs, "/workspace/probe/node_modules")).toBe(
      false
    );
    expect(await pathExists(ws.fs, "/workspace/probe/core/node_modules")).toBe(
      false
    );
    expect(await pathExists(ws.fs, "/workspace/probe/core/index.ts")).toBe(
      true
    );
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("deps:purged")
      )
    ).toBeTypeOf("number");
  });

  /** Only a missing workspace means nothing was synced; anything else retries. */
  it("tries again after a failure other than a missing workspace", async () => {
    const stub = freshWorkspace("purge-fails");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("deps:purged", Date.now());
    });
    {
      using ws = await openWorkspaceFs(stub);
      await ws.fs.rm("/workspace", { recursive: true, force: true });
      await ws.fs.writeFile("/workspace", "not a directory");
    }
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.delete("deps:purged")
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      using ws = await openWorkspace(stub);
      void ws;
    } catch {
      // Whatever else a file at the workspace root breaks is not this spec's.
    } finally {
      warn.mockRestore();
    }

    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("deps:purged")
      )
    ).toBeUndefined();
  });
});

/**
 * The wait on a container start. A start whose connect never answers held every
 * caller until core abandoned the call, so the model read an abandoned call, not
 * a reason, and the next call joined the same hung start.
 */
describe("waiting on a container start", () => {
  it("refuses the wait at its deadline, with a reason", async () => {
    const hung = new Promise<void>(() => {});

    await expect(readyWithin(hung, 10)).rejects.toThrow(
      /did not become ready within .*the next call starts it again/
    );
  });

  it("leaves no timer behind when the start finishes first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await readyWithin(Promise.resolve(), 5 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Releasing a container without throwing the workspace away.
 *
 * The distinction from `reclaimIfIdle` is the only reason this exists, and it is
 * invisible from the outside: both leave no container running. What separates them
 * is what is still on disk afterwards — and getting it wrong costs the next task a
 * fresh clone and a full dependency install, silently, because nothing fails.
 */
describe("releasing a container", () => {
  it("keeps the checkout, which is what makes it not a reclaim", async () => {
    const stub = freshWorkspace("release-keeps-storage");
    const dir = "/workspace/api";
    await seedNodeCheckout(stub, dir);
    await stub.noteCheckout({ dir, repo: "acme/api", kind: "repo" });

    expect(await stub.releaseContainer()).toEqual({ released: true });

    // The whole point: the next task on this repository skips the clone and the
    // install. A `reclaimIfIdle` here would answer `undefined`.
    expect(await stub.checkoutDir()).toBe(dir);
  });

  it("refuses while an install is still running", async () => {
    const stub = freshWorkspace("release-during-install");
    const dir = "/workspace/api";
    await seedNodeCheckout(stub, dir);

    // An install in flight is "in use" even though nothing has called in —
    // stopping the container under it throws the work away and leaves the gate
    // closed until something notices.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now()
      } satisfies InstallState)
    );

    expect(await stub.releaseContainer()).toEqual({ released: false });
  });

  it("is safe on a workspace nothing has ever opened", async () => {
    // Reached on a task that failed before it cloned anything. Nothing to stop and
    // nothing to drain, and a teardown that threw here would be reported against
    // the task rather than against itself.
    const stub = freshWorkspace("release-never-used");

    expect(await stub.releaseContainer()).toEqual({ released: true });
  });
});

/**
 * Think's file tools over a real workspace object.
 *
 * `read`, `write` and `delete` are Think's, reaching the container's tree
 * through `computerWorkspace`; `grep`, `find`, `list` and `edit` are this
 * plugin's. The tree is checkout-sized, with a `.git` beside the source that
 * the walks prune — the fixture the migration's cost measurement ran on.
 */
describe("the file tools over a checkout", () => {
  const root = "/workspace/app";
  const line = (i: number) => `export const value${i} = ${i}; // padding\n`;
  const body = (i: number) =>
    Array.from({ length: 60 }, (_, k) => line(i * 100 + k)).join("");

  const run = (tool: unknown, input: unknown) =>
    (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      input,
      { toolCallId: "t", messages: [] }
    );

  it("serves Think's tools and ours from the durable tree", async () => {
    // Named here rather than by `freshWorkspace`, which makes its name unique:
    // the workspace reaches the object by name, as an agent's would.
    const name = `think-tools-${crypto.randomUUID()}`;
    const stub = workspaceNamespace.get(workspaceNamespace.idFromName(name));
    {
      using ws = await openWorkspaceFs(stub);
      await ws.fs.mkdir(`${root}/.git/objects`, { recursive: true });
      for (let d = 0; d < 40; d++)
        await ws.fs.mkdir(`${root}/src/m${d}`, { recursive: true });
      for (let i = 0; i < 1_200; i++)
        await ws.fs.writeFile(`${root}/src/m${i % 40}/f${i}.ts`, body(i));
      for (let i = 0; i < 3_000; i++)
        await ws.fs.writeFile(`${root}/.git/objects/${i}`, "blob");
    }

    const config: ComputerConfig = {
      binding: workspaceNamespace as unknown as ComputerConfig["binding"],
      workspaceName: () => name
    };
    const workspace = computerWorkspace(config);
    const think = createWorkspaceTools(workspace, { bash: false });
    const ours = computer(config).tools!(
      testPluginContext({ workspace: () => workspace })
    );
    const file = `${root}/src/m7/f7.ts`;

    const read = (await run(think.read, { path: file })) as {
      totalLines: number;
    };
    expect(read.totalLines).toBe(61);

    await run(think.write, {
      path: `${root}/src/new/a.ts`,
      content: body(9_999)
    });
    expect(await workspace.readFile(`${root}/src/new/a.ts`)).toBe(body(9_999));

    await run(think.edit, {
      path: file,
      old_string: "value700 = 700",
      new_string: "value700 = -1"
    });
    expect(
      await run(ours.edit, {
        path: file,
        old_string: "value701 = 701",
        new_string: "value701 = -1"
      })
    ).toBe(`edited ${file}`);
    expect(await workspace.readFile(file)).toContain("value700 = -1");
    expect(await workspace.readFile(file)).toContain("value701 = -1");

    expect(
      await run(ours.grep, { query: "value119959 =", path: `${root}/src` })
    ).toContain("f1199.ts");

    const found = (await run(ours.find, {
      path: root,
      pattern: "**/f11*.ts"
    })) as string;
    expect(found).toContain(`${root}/src/m30/f1150.ts`);
    expect(found).not.toContain(".git");

    expect(await run(ours.list, { path: `${root}/src` })).toContain("m7/");

    await run(think.delete, { path: `${root}/src/new/a.ts` });
    expect(await workspace.stat(`${root}/src/new/a.ts`)).toBeNull();
  }, 60_000);
});
