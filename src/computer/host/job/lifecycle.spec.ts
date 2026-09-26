import { describe, it, expect } from "vitest";
import type { Scheduler, SchedulerCallbacks } from "agents/schedules";
import { JobLifecycle } from "./lifecycle.js";
import type { JobState } from "./state.js";

/**
 * What these specs pin is the *choreography*, not the job. Every rule here
 * exists because its absence was a production failure in the predecessor, so
 * each one is asserted negatively — that the wrong thing is refused — rather
 * than merely that the right thing works.
 *
 * Driven through fakes rather than a real Durable Object because the rules are
 * about which keys are written in which order and which scheduling calls are
 * made in which order. A real `Scheduler` would make those reachable; a fake
 * makes them assertable, and the scheduler's own behaviour is the SDK's to test.
 */
function fakeStorage(): DurableObjectStorage {
  const rows = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async <T>(key: string): Promise<T | undefined> =>
      rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key: string): Promise<boolean> => rows.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (when: number): Promise<void> => {
      alarm = when;
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    }
  } as unknown as DurableObjectStorage;
}

/**
 * A scheduler that records what it was asked to do.
 *
 * `when` is kept **raw** rather than normalised, because the type it arrives as
 * is itself a rule: `Scheduler.set` reads a number as a delay in seconds, so an
 * epoch-ms deadline passed through as a number schedules fifty thousand years
 * out and nothing rejects it. A fake that normalised would hide exactly that.
 */
function fakeScheduler() {
  const live = new Map<string, { callback: string; when: unknown }>();
  const calls: string[] = [];
  let minted = 0;

  const scheduler = {
    set: async (when: unknown, callback: string) => {
      const id = `sched-${++minted}`;
      calls.push(`set:${callback}`);
      live.set(id, { callback, when });
      return { id, callback, type: "scheduled" };
    },
    cancel: async (id: string) => {
      calls.push(`cancel:${id}`);
      return live.delete(id);
    }
  };

  return {
    scheduler: scheduler as unknown as Scheduler<SchedulerCallbacks>,
    /** Every schedule that has been created and not cancelled. */
    live,
    /** `set` and `cancel` in the order they happened. Ordering is a rule here. */
    calls
  };
}

type Install = { command: string };

function lifecycle(id = "install", over: { watchMs?: number } = {}) {
  const storage = fakeStorage();
  const sched = fakeScheduler();
  return {
    storage,
    ...sched,
    job: new JobLifecycle<Install>({
      id,
      storage,
      scheduler: sched.scheduler,
      run: "jobRun",
      watch: "jobWatch",
      ...over
    })
  };
}

describe("key derivation", () => {
  /**
   * A deployed object's storage holds these strings, so a change here is not a
   * rename — it is every live workspace losing its install record.
   */
  it("reproduces the hand-written keys for id 'install'", () => {
    const { job } = lifecycle();
    expect(job.stateKey).toBe("install");
    expect(job.armedKey).toBe("install:armed");
    expect(job.lastArmedKey).toBe("install:last-armed");
    expect(job.contextKey).toBe("install:context");
    expect(job.watchIdKey).toBe("install:watch-id");
  });

  it("namespaces a second job on the same object", () => {
    const { job } = lifecycle("claude-run");
    expect(job.stateKey).toBe("claude-run");
    expect(job.watchIdKey).toBe("claude-run:watch-id");
  });
});

describe("arm", () => {
  it("writes running before anything runs, and schedules the run callback", async () => {
    const { job, live } = lifecycle();
    await job.write({
      state: "done",
      command: "npm ci",
      exitCode: 0,
      finishedAt: 1,
      ms: 1
    });

    const armedAt = await job.arm({ command: "npm ci" });
    expect(armedAt).toBeTypeOf("number");

    const state = await job.read();
    // `running`, not `done` — a `done` record in this window lets a gated caller
    // through against a workspace that is not ready.
    expect(state.state).toBe("running");
    expect(await job.armedAt()).toBe(armedAt);

    const scheduled = [...live.values()];
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.callback).toBe("jobRun");
    // A `Date`, not the raw stamp — a number would be read as a delay in
    // seconds, putting the run fifty thousand years out with no error.
    expect(scheduled[0]!.when).toBeInstanceOf(Date);
    expect((scheduled[0]!.when as Date).getTime()).toBe(armedAt);
  });

  it("is self-limiting: a second call sees running and declines", async () => {
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("re-arms from failed, not only from done", async () => {
    // Arming used to require `done`, so one bad run left a record that declined
    // to re-arm forever — one failure poisoning every task after it.
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });

  it("refuses to re-arm from skipped or idle", async () => {
    const { job } = lifecycle();
    expect(await job.arm({ command: "npm ci" })).toBeUndefined(); // idle
    await job.write({ state: "skipped", reason: "nothing to install" });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("honours the cooldown floor between attempts", async () => {
    const { job, storage } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");

    // Back to a re-armable state, but still inside the cooldown window.
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 2,
      error: "y"
    });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();

    // Age the cooldown marker past the floor.
    await storage.put("install:last-armed", Date.now() - 10 * 60_000);
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });
});

describe("claim", () => {
  const running = (startedAt: number): JobState<Install> => ({
    state: "running",
    command: "npm ci",
    startedAt
  });
  /** Comfortably longer than any age used below, so staleness never fires. */
  const LIVE = 60 * 60_000;

  it("refuses a second run while one is in flight", () => {
    const { job } = lifecycle();
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
  });

  it("admits the alarm presenting its own placeholder stamp", () => {
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at).ok).toBe(true);
  });

  it("refuses a take-over with any other stamp", () => {
    // This is the displacement bug in a new hat: an exemption keyed on anything
    // looser than the exact stamp becomes "take over any running job".
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at - 1).ok).toBe(false);
    expect(job.claim(running(at), LIVE, undefined).ok).toBe(false);
  });

  it("admits a run when the record is terminal", () => {
    const { job } = lifecycle();
    expect(job.claim({ state: "idle" }, LIVE).ok).toBe(true);
    expect(
      job.claim(
        { state: "done", command: "npm ci", exitCode: 0, finishedAt: 1, ms: 1 },
        LIVE
      ).ok
    ).toBe(true);
  });

  it("applies the staleness bound itself rather than trusting the caller", () => {
    // The previous signature took an "already-repaired" state and said so only
    // in prose. Nothing enforced it, so a caller passing a raw read got a
    // `running` record that could never be claimed and a job wedged forever.
    const { job } = lifecycle();
    // In flight and inside its budget: a second run must wait.
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
    // Written by an isolate that is long gone: claimable, or it blocks forever.
    expect(job.claim(running(0), LIVE).ok).toBe(true);
  });
});

describe("generation", () => {
  it("still mine while the context stamp matches", async () => {
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(true);
    expect(gen.superseded()).toBe(false);
  });

  it("latches superseded once the stamp moves on", async () => {
    // A drain can outlive the job it watched: `ctx.waitUntil` keeps running
    // after the RPC returns, and a late verdict written over a live record is
    // silent corruption.
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    await job.putContext({ startedAt: 900 });

    expect(await gen.stillMine()).toBe(false);
    // Latched, so the drain can ask afterwards whether it may touch the
    // watchdog — which belongs to whichever run owns the record now.
    expect(gen.superseded()).toBe(true);
  });

  it("never hands ownership back once superseded", async () => {
    // The latch must be checked *before* the read. A context that returns to the
    // original stamp does not restore ownership — a drain regaining write
    // access here is exactly the corruption the marker exists to prevent.
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(true);

    await job.putContext({ startedAt: 900 });
    expect(await gen.stillMine()).toBe(false);

    await job.putContext({ startedAt: 500 });
    expect(await gen.stillMine()).toBe(false);
    expect(gen.superseded()).toBe(true);
  });

  it("treats a missing context as superseded rather than owned", async () => {
    const { job } = lifecycle();
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(false);
  });
});

describe("reserved ids", () => {
  /**
   * Empty is the only id that collides: it yields `:armed` and `:context`, which
   * two differently-broken callers would share.
   *
   * Nothing else can, and the second test is what pins that. A schedule lives in
   * its own row under an id the scheduler mints, so no job id reaches the
   * scheduling machinery however it is spelled — which is why an id that reads
   * like scheduler state is accepted rather than reserved.
   */
  it("refuses an empty id", () => {
    const storage = fakeStorage();
    const { scheduler } = fakeScheduler();
    expect(
      () =>
        new JobLifecycle({
          id: "",
          storage,
          scheduler,
          run: "jobRun",
          watch: "jobWatch"
        })
    ).toThrow(/non-empty/);
  });

  it("accepts an id that reads like scheduler state", () => {
    const storage = fakeStorage();
    const { scheduler } = fakeScheduler();
    expect(
      () =>
        new JobLifecycle({
          id: "wake",
          storage,
          scheduler,
          run: "jobRun",
          watch: "jobWatch"
        })
    ).not.toThrow();
  });
});

describe("arm rollback", () => {
  /**
   * The placeholder and the alarm that owns it are two writes. A failure
   * between them leaves a `running` record no run intent points at, which every
   * later `arm()` then declines to replace *because* it is running.
   */
  it("restores the prior state when scheduling fails", async () => {
    const { job, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };

    const before: JobState<Install> = {
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    };
    await job.write(before);

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow(
      "scheduler unavailable"
    );

    // Left exactly as re-armable as it was found, rather than wedged at
    // `running` until a full timeout elapses.
    expect(await job.read()).toEqual(before);
    expect(await job.armedAt()).toBeUndefined();
  });

  it("keeps the cooldown floor even when scheduling failed", async () => {
    // A floor that applied only to *successful* arming would let a persistently
    // failing schedule re-arm on every call into the object.
    const { job, storage, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow();
    expect(await storage.get("install:last-armed")).toBeTypeOf("number");
  });
});

describe("the watchdog", () => {
  it("schedules the watch callback at the watch deadline", async () => {
    const { job, live, storage } = lifecycle();
    const now = 1_000_000;
    await job.armWatch(now);

    const scheduled = [...live.values()];
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.callback).toBe("jobWatch");
    // Default watchMs is 60s; the deadline is what a dead drain is recovered by.
    expect(scheduled[0]!.when).toBeInstanceOf(Date);
    expect((scheduled[0]!.when as Date).getTime()).toBe(now + 60_000);
    // The id is held so the next re-arm can cancel this row.
    expect(await storage.get("install:watch-id")).toBeTypeOf("string");
  });

  it("honours a configured watchMs", async () => {
    const { job, live } = lifecycle("install", { watchMs: 5_000 });
    await job.armWatch(1_000_000);
    expect(([...live.values()][0]!.when as Date).getTime()).toBe(1_005_000);
  });

  /**
   * A schedule is a row, not a keyed upsert, so re-arming *adds* unless the
   * previous one is cancelled first — and a drain re-arms on every window. Left
   * alone, a job drained for an hour leaves sixty rows, every one of them due,
   * each waking the object to find the others already handled it.
   */
  it("leaves one schedule behind however often it re-arms", async () => {
    const { job, live, calls } = lifecycle();
    await job.armWatch(1_000_000);
    await job.armWatch(1_060_000);
    await job.armWatch(1_120_000);

    expect(live.size).toBe(1);
    expect(([...live.values()][0]!.when as Date).getTime()).toBe(1_180_000);
    // Cancel *then* set, not the other way round: the reverse order would leave
    // the window in which both rows exist and the object wakes twice.
    expect(calls).toEqual([
      "set:jobWatch",
      "cancel:sched-1",
      "set:jobWatch",
      "cancel:sched-2",
      "set:jobWatch"
    ]);
  });

  it("disarms on request", async () => {
    const { job, live, storage } = lifecycle();
    await job.armWatch(1_000_000);
    expect(live.size).toBe(1);

    await job.clearWatch();
    expect(live.size).toBe(0);
    // The id goes too, so a later re-arm does not try to cancel a row that is
    // gone and, worse, one whose id has since been minted again.
    expect(await storage.get("install:watch-id")).toBeUndefined();
  });

  it("swallows a failure to disarm", async () => {
    // Called from a `finally`, so a throw here would mask the drain's own
    // outcome — which is the thing the caller actually needs to report.
    const { job, scheduler } = lifecycle();
    await job.armWatch(1_000_000);
    scheduler.cancel = async () => {
      throw new Error("storage gone");
    };
    await expect(job.clearWatch()).resolves.toBeUndefined();
  });

  /**
   * A schedule the scheduler has already run and removed is the ordinary case,
   * not an error: the watchdog fires, and the drain that it woke re-arms.
   */
  it("re-arms cleanly when the previous schedule is already gone", async () => {
    const { job, scheduler, live } = lifecycle();
    await job.armWatch(1_000_000);
    live.clear();

    await expect(job.armWatch(1_060_000)).resolves.toBeUndefined();
    expect(live.size).toBe(1);
    expect(await scheduler.cancel("nothing")).toBe(false);
  });
});
