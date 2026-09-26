import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
// The class, not the ambient global of the same name — see `./index.ts`.
import type { DurableObject } from "cloudflare:workers";
import { installScheduler, namedDeadline, HOST_HANDLERS } from "./index.js";
import type {
  DelegatingScheduled,
  PlainScheduled
} from "../../../../test/worker.js";

/**
 * What these pin is the *installation*, not the scheduler.
 *
 * `Scheduler` is the SDK's and has its own suite; re-testing cron parsing here
 * would be someone else's coverage counted twice. What is ours is the assembly:
 * which host gets a working alarm, which one silently does not, and what a
 * Durable Object carrying a legacy `wake` row finds when it boots on this code.
 *
 * Real Durable Objects rather than a fake, because every rule below is a
 * property of `ctx.storage` and the physical alarm — a fake storage would assert
 * that the fake works.
 */

const ns = <T extends Rpc.DurableObjectBranded>(name: string) =>
  (env as unknown as Record<string, DurableObjectNamespace<T>>)[name]!;

const plain = ns<PlainScheduled>("PLAIN_SCHEDULED");
const delegating = ns<DelegatingScheduled>("DELEGATING_SCHEDULED");

const fresh = <T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T>,
  label: string
) => namespace.get(namespace.idFromName(`${label}:${crypto.randomUUID()}`));

/**
 * A stand-in host carrying a real `ctx`.
 *
 * The guard is a question about the prototype chain and needs no Durable Object
 * — but a lifecycle that gets *past* the guard reads `host.ctx` immediately, so
 * the accepting cases have to hand it a real one. Borrowing the `ctx` of an
 * object the test already has is cheaper and truer than faking storage.
 */
const fakeHost = (proto: object, ctx?: DurableObjectState) =>
  Object.assign(
    Object.create(proto) as object,
    ctx ? { ctx } : {}
  ) as never as DurableObject<Cloudflare.Env>;

const OWNS_BOTH = {
  alarm: () => Promise.resolve(),
  fetch: () => new Response()
};

describe("installScheduler — the undelegated-handler guard", () => {
  /**
   * The failure this exists for produces no error of its own. A lifecycle
   * defines `alarm` only when the host does not already have one, so a host that
   * overrides it keeps its own — and the scheduler it installed then never runs,
   * with nothing anywhere saying so. Turning that into a throw at construction
   * is the whole reason to call this rather than composing the lifecycle and the
   * scheduler
   * by hand.
   */
  it("refuses a host that defines a handler it did not declare", () => {
    const host = fakeHost({ alarm: () => Promise.resolve() });
    expect(() => installScheduler(host)).toThrow(/"alarm"/);
    expect(() => installScheduler(host)).toThrow(/silently unfired/);
  });

  it("names every undeclared handler, not just the first", () => {
    let message = "";
    try {
      installScheduler(fakeHost(OWNS_BOTH));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('"fetch"');
    expect(message).toContain('"alarm"');
  });

  it("accepts the same host once it declares them", async () => {
    await runInDurableObject(fresh(plain, "declared"), (_instance, state) => {
      expect(() =>
        installScheduler(fakeHost(OWNS_BOTH, state), {
          hostOwns: ["alarm", "fetch"]
        })
      ).not.toThrow();
    });
  });

  /**
   * Declaring a handler the host does *not* have is harmless and stays that way
   * deliberately: the list is an acknowledgement, and a host that grows an
   * `alarm()` later should not have to remember to add one.
   */
  it("tolerates a declaration for a handler the host does not have", async () => {
    await runInDurableObject(
      fresh(plain, "overdeclared"),
      (_instance, state) => {
        expect(() =>
          installScheduler(fakeHost({}, state), {
            hostOwns: [...HOST_HANDLERS]
          })
        ).not.toThrow();
      }
    );
  });
});

describe("installScheduler — a host with no handlers of its own", () => {
  it("runs a callback the lifecycle's own alarm dispatches", async () => {
    const stub = fresh(plain, "runs");
    await runInDurableObject(stub, async (instance) => {
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "past"
      });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["past"]);
    });
  });

  /**
   * A Durable Object has one physical alarm, and two deadlines over it must land
   * on the earlier — the whole reason a scheduler is worth having rather than
   * each caller reaching for `setAlarm`. Asserted against `storage.getAlarm()`
   * rather than against the schedule rows, because the rows are not what the
   * runtime wakes on.
   */
  it("points the one physical alarm at the earlier of two deadlines", async () => {
    const stub = fresh(plain, "earliest");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();

      const far = new Date(Date.now() + 3_600_000);
      const near = new Date(Date.now() + 60_000);

      await instance.wake.scheduler.set(far, "mark", { at: "far" });
      const afterFar = await state.storage.getAlarm();
      expect(afterFar).not.toBeNull();

      await instance.wake.scheduler.set(near, "mark", { at: "near" });
      const afterNear = await state.storage.getAlarm();

      expect(afterNear).not.toBeNull();
      expect(afterNear!).toBeLessThan(afterFar!);
      // Seconds are the scheduler's storage unit, so the alarm lands within one
      // of the requested moment rather than exactly on it.
      expect(Math.abs(afterNear! - near.getTime())).toBeLessThanOrEqual(1_000);
    });
  });

  it("clears the alarm once the last schedule is cancelled", async () => {
    const stub = fresh(plain, "cleared");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const only = await instance.wake.scheduler.set(
        new Date(Date.now() + 60_000),
        "mark",
        { at: "only" }
      );
      expect(await state.storage.getAlarm()).not.toBeNull();

      await instance.wake.scheduler.cancel(only.id);
      await instance.wake.rearm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("installScheduler — a host that owns its own alarm", () => {
  /**
   * The shape `starter`'s workspace object has. Both halves must run: the host's
   * own work on waking, and the schedules. A delegation that replaced one with
   * the other would pass any test that only looked at the half it kept.
   */
  it("runs the host's own alarm work and the schedules", async () => {
    const stub = fresh(delegating, "both");
    await runInDurableObject(stub, async (instance) => {
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "past"
      });

      await instance.alarm();

      expect(instance.ownAlarms).toBe(1);
      expect(instance.marks).toEqual(["past"]);
    });
  });

  it("arms the physical alarm from a host that is only ever reached by RPC", async () => {
    const stub = fresh(delegating, "rpc");
    await runInDurableObject(stub, async (instance, state) => {
      // No `fetch` anywhere in this test, which is the point: native RPC bypasses
      // it, so `start()` is the only thing that migrates the scheduler's schema.
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() + 60_000), "mark", {
        at: "later"
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("installScheduler — booting on a legacy wake row", () => {
  /**
   * There is no storage migration, by decision, so this is the test that
   * decision rests on.
   *
   * Deployed objects hold a KV row called `"wake"` holding every deadline, and a
   * physical alarm armed against it. Nothing reads that row here, so such an
   * object boots with both still on disk: a row with no reader, and an alarm that
   * fires once into a handler with no schedule rows behind it. Neither may throw —
   * the runtime retries a throwing `alarm()` a bounded number of times and then
   * stops for good, which would take every *future* schedule down with the
   * orphan.
   */
  it("treats a leftover alarm with no schedules as a no-op, and still schedules after", async () => {
    const stub = fresh(plain, "dirty");
    await runInDurableObject(stub, async (instance, state) => {
      // Exactly what such an object holds: the row, and an alarm armed for it.
      await state.storage.put("wake", {
        "sync-retry:github": { key: "sync-retry:github", notBefore: 1 }
      });
      await state.storage.setAlarm(Date.now() - 1_000);

      await expect(instance.wake.alarm()).resolves.toBeUndefined();
      expect(instance.marks).toEqual([]);

      // And the object is not poisoned by what it found.
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "after"
      });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["after"]);
    });
  });

  /**
   * The orphaned row is left in place rather than drained, and nothing reads it.
   * Pinned so that "orphaned" stays a decision somebody made rather than a
   * detail somebody assumes.
   */
  it("leaves the orphaned row untouched", async () => {
    const stub = fresh(plain, "orphan");
    await runInDurableObject(stub, async (instance, state) => {
      const leftover = {
        "container-idle": { key: "container-idle", notBefore: 1 }
      };
      await state.storage.put("wake", leftover);

      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "x"
      });
      await instance.wake.alarm();

      expect(await state.storage.get("wake")).toEqual(leftover);
    });
  });
});

describe("namedDeadline", () => {
  const deadlineOn = (instance: PlainScheduled, state: DurableObjectState) =>
    namedDeadline({
      storage: state.storage,
      scheduler: instance.wake.scheduler,
      key: "idle-id",
      callback: "mark"
    });

  /**
   * The rule the whole abstraction exists for. `#touch()`-shaped code moves a
   * deadline on every request, and a scheduler has no move — so without the
   * cancel, an object touched a hundred times carries a hundred rows, every one
   * of them due, each waking it to find the work already done.
   */
  it("leaves one schedule behind however often it moves", async () => {
    const stub = fresh(plain, "moves");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await idle.set(new Date(Date.now() + 60_000), { at: "a" });
      await idle.set(new Date(Date.now() + 120_000), { at: "b" });
      await idle.set(new Date(Date.now() + 180_000), { at: "c" });

      const all = await instance.wake.scheduler.list();
      expect(all).toHaveLength(1);
      expect((await idle.get())?.id).toBe(all[0]!.id);
    });
  });

  it("moves the physical alarm with it, later as well as earlier", async () => {
    const stub = fresh(plain, "later");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await idle.set(new Date(Date.now() + 60_000), { at: "near" });
      const near = await state.storage.getAlarm();

      // A lifecycle owns the physical alarm outright, so a deadline pushed back
      // moves the alarm back with it. An implementation that only ever armed
      // earlier would leave the object waking on the old deadline to find
      // nothing due, which is silent and costs a wake-up every time.
      await idle.set(new Date(Date.now() + 600_000), { at: "far" });
      const far = await state.storage.getAlarm();

      expect(far!).toBeGreaterThan(near!);
    });
  });

  it("reads back the payload it scheduled", async () => {
    const stub = fresh(plain, "payload");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await idle.set(new Date(Date.now() + 60_000), { at: "kept" });
      expect((await idle.get())?.payload).toEqual({ at: "kept" });
    });
  });

  it("reports nothing standing before it is ever set", async () => {
    const stub = fresh(plain, "unset");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      expect(await deadlineOn(instance, state).get()).toBeUndefined();
    });
  });

  it("clears, and clearing twice is not an error", async () => {
    const stub = fresh(plain, "cleared-twice");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await idle.set(new Date(Date.now() + 60_000), { at: "x" });
      await idle.clear();
      expect(await idle.get()).toBeUndefined();
      expect(await instance.wake.scheduler.list()).toHaveLength(0);

      await expect(idle.clear()).resolves.toBeUndefined();
    });
  });

  /**
   * The ordinary path, not an error: a one-shot row is dropped when it runs, so
   * the deadline a callback re-arms *from* has nothing left to cancel.
   */
  it("re-arms cleanly after its own schedule has fired", async () => {
    const stub = fresh(plain, "refired");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await idle.set(new Date(Date.now() - 1_000), { at: "due" });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["due"]);

      await expect(
        idle.set(new Date(Date.now() + 60_000), { at: "again" })
      ).resolves.toBeDefined();
      expect(await instance.wake.scheduler.list()).toHaveLength(1);
    });
  });

  /**
   * A rejection from `cancel` is not "already gone".
   *
   * Swallowing it would delete the stored id and then create a replacement, so
   * the original row — which may well still be live — would keep firing with
   * nothing able to reach it: the only handle on it was the id just discarded.
   * Aborting keeps the id, so the next attempt can still cancel.
   */
  it("keeps the standing id when cancelling fails, rather than doubling up", async () => {
    const stub = fresh(plain, "cancel-throws");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      const first = await idle.set(new Date(Date.now() + 60_000), { at: "a" });

      const scheduler = instance.wake.scheduler;
      const realCancel = scheduler.cancel.bind(scheduler);
      scheduler.cancel = () => Promise.reject(new Error("storage gone"));

      await expect(
        idle.set(new Date(Date.now() + 120_000), { at: "b" })
      ).rejects.toThrow("storage gone");

      // No replacement was created, and the id still names the live row.
      expect(await scheduler.list()).toHaveLength(1);
      expect(await state.storage.get("idle-id")).toBe(first.id);

      // So a later attempt still reaches it.
      scheduler.cancel = realCancel;
      await idle.set(new Date(Date.now() + 180_000), { at: "c" });
      expect(await scheduler.list()).toHaveLength(1);
    });
  });

  /**
   * A move is read-cancel-create-write across several awaits, so two of them in
   * flight at once could cancel the same row, create two, and keep one id.
   *
   * Deterministic here in a way the Durable Object level is not: these are
   * genuinely concurrent at the microtask boundaries the implementation awaits
   * on, with no dependence on how a runtime schedules delivery.
   */
  it("leaves one schedule when moves overlap", async () => {
    const stub = fresh(plain, "overlapping");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const idle = deadlineOn(instance, state);

      await Promise.all([
        idle.set(new Date(Date.now() + 60_000), { at: "a" }),
        idle.set(new Date(Date.now() + 120_000), { at: "b" }),
        idle.set(new Date(Date.now() + 180_000), { at: "c" }),
        idle.set(new Date(Date.now() + 240_000), { at: "d" })
      ]);

      expect(await instance.wake.scheduler.list()).toHaveLength(1);
      expect((await idle.get())?.id).toBe(
        (await instance.wake.scheduler.list())[0]!.id
      );
    });
  });

  /**
   * The same, through two handles that name one key. A caller minting a fresh
   * `Deadline` per call — one per backend, say — must serialize with the others
   * on the same key, so anything held on the instance would not be enough.
   */
  it("leaves one schedule when two handles on one key overlap", async () => {
    const stub = fresh(plain, "two-handles");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const a = deadlineOn(instance, state);
      const b = deadlineOn(instance, state);

      await Promise.all([
        a.set(new Date(Date.now() + 60_000), { at: "a" }),
        b.set(new Date(Date.now() + 120_000), { at: "b" })
      ]);

      expect(await instance.wake.scheduler.list()).toHaveLength(1);
    });
  });

  /** Two deadlines differ only by key, and must not disturb each other. */
  it("keeps two deadlines on one object independent", async () => {
    const stub = fresh(plain, "two");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const common = {
        storage: state.storage,
        scheduler: instance.wake.scheduler,
        callback: "mark" as const
      };
      const idle = namedDeadline({ ...common, key: "idle-id" });
      const container = namedDeadline({ ...common, key: "container-id" });

      await idle.set(new Date(Date.now() + 60_000), { at: "idle" });
      await container.set(new Date(Date.now() + 120_000), { at: "container" });

      expect(await instance.wake.scheduler.list()).toHaveLength(2);

      await idle.clear();
      expect((await container.get())?.payload).toEqual({ at: "container" });
      expect(await instance.wake.scheduler.list()).toHaveLength(1);
    });
  });
});
