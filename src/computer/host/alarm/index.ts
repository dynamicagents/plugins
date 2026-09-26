/**
 * Many deadlines over a Durable Object's one alarm — the workspace host's
 * install, sync and container start each keep one.
 *
 * A Durable Object has exactly **one** alarm, and an object that needs to wake
 * for more than one reason cannot simply call `setAlarm` from each of them: the
 * last writer silently wins, and whatever the loser was waiting on never
 * happens. This module is the fix: a thin assembly over the `agents` SDK.
 *
 * **Scheduling does not require the `Agent` base class.** A `Lifecycle`
 * installs on a **plain** `DurableObject` and a `Scheduler` composes onto it, so
 * nothing in this module pulls `cf_agents_state`, an `MCPClientManager`, or the
 * prototype patching that comes with extending `Agent`.
 *
 * What that buys: retries with backoff, cron and interval schedules, a
 * hung-callback timeout, and per-schedule rows instead of one shared blob. What
 * it costs is named under "The sharp edges" below and in {@link
 * installScheduler} — this is **not** a drop-in for a keyed map.
 *
 * It does import `agents` — far smaller than the whole `Agent` base class, and
 * not zero.
 *
 * **Experimental.** Every type in `agents/schedules` carries "The API surface
 * may change before stabilizing". Keeping the assembly here, with no export,
 * is what makes that churn one file's problem rather than a consumer's.
 *
 * ## The sharp edges
 *
 * **1. A host that defines its own handlers is skipped in silence.**
 * `Lifecycle.installHandlers()` only defines `fetch`, `alarm` and the WebSocket
 * handlers that the host does not already have — by design, so a framework can
 * keep its own dispatch. An object that overrides `alarm()` therefore installs
 * a `Scheduler` that never fires, with no error anywhere. {@link
 * installScheduler} turns that into a throw at construction: a host with its own
 * handler must say so in `hostOwns`, and an `alarm()` it owns must call through.
 *
 * **2. There is no "move this deadline".** A schedule is a row with a minted id,
 * so pushing one later is {@link Scheduler.cancel} then {@link Scheduler.set} —
 * there is no keyed upsert, which is what most callers reach for and expect.
 * One-shot schedules are also **not** idempotent by default, so calling `set`
 * again makes a *second* row rather than replacing the first, and on a hot path
 * that is how an object ends up with thousands of them. Hold the id and cancel
 * it; do not schedule twice and hope. {@link namedDeadline} is that, packaged —
 * reach for it rather than repeating it.
 *
 * **3. A bare number is a delay in seconds, not a moment.** `set(when)` reads a
 * `Date` as an instant, a string as a cron expression, and a **number as a delay
 * in seconds**. A Durable Object's own currency is epoch milliseconds — what
 * `Date.now()` and `storage.setAlarm()` both speak — so passing one straight
 * through schedules roughly fifty thousand years out, and nothing rejects it.
 * Cross every deadline as a `Date`.
 *
 * This owns *when* an object wakes. What it owes on waking is the object's own,
 * named: a callback is registered under a name in
 * {@link SchedulerOptions.callbacks}, and the payload is typed against it.
 */
// The class from `cloudflare:workers`, not the ambient global of the same name:
// the global is a non-generic interface describing the runtime's handler shape,
// while a lifecycle installs on the *class* and is generic in `Env`.
import type { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  Scheduler,
  type Schedule,
  type SchedulerCallbacks,
  type SchedulerHandlers,
  type SchedulerOptions,
  type SchedulerPayload
} from "agents/schedules";

export type {
  Schedule,
  ScheduleCriteria,
  ScheduleOptions,
  SchedulerCallbacks,
  SchedulerEventType,
  SchedulerHandlers,
  SchedulerOptions,
  SchedulerPayload
} from "agents/schedules";
export { Scheduler } from "agents/schedules";

/**
 * The runtime entry points a {@link Lifecycle} wants to own.
 *
 * Spelled out rather than inferred because the whole point is to compare this
 * list against what the host already defines, and an inferred one would shrink
 * silently if the SDK stopped installing something.
 */
export const HOST_HANDLERS = [
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError"
] as const;

/** One of the runtime entry points a host and a `Lifecycle` can both want. */
export type HostHandler = (typeof HOST_HANDLERS)[number];

export interface InstallSchedulerOptions<
  H extends SchedulerHandlers
> extends SchedulerOptions<H> {
  /**
   * Handlers this host defines itself.
   *
   * Required for anything the host already has, because `installHandlers()`
   * skips those without saying so. Listing one is an acknowledgement, not a
   * promise: what the host then does with it is the host's decision, and the
   * two cases genuinely differ.
   *
   * **`alarm` must be delegated.** It is the only one scheduling cannot work
   * without — a host that owns `alarm()` and never calls {@link
   * ScheduledHost.alarm} has a scheduler that never fires.
   *
   * **`fetch` and the WebSocket handlers usually should not be.** A lifecycle's
   * `fetch` claims capability routes, falls through to a host's `onRequest`, and
   * declines any upgrade request no installed capability claims — and this
   * assembly installs none that does. A host serving its own protocol over a
   * WebSocket wants none of that, and delegating would refuse the upgrade.
   * Declare it and keep it.
   */
  readonly hostOwns?: readonly HostHandler[];
}

/**
 * A `Scheduler` and the `Lifecycle` carrying it, bound to one Durable Object.
 *
 * The delegation targets are methods here rather than on the lifecycle so a host
 * has one object to hold and one name to call, and so this module can keep the
 * SDK's shape from reaching the host directly.
 */
export interface ScheduledHost<
  H extends SchedulerHandlers,
  Env extends object = Cloudflare.Env
> {
  /** Set, list and cancel schedules. The reason this object exists. */
  readonly scheduler: Scheduler<H>;
  /** The escape hatch, for capabilities this assembly does not wrap. */
  readonly lifecycle: Lifecycle<Env>;
  /**
   * Start the lifecycle and its capabilities.
   *
   * The runtime entry points do this themselves, so a host that is reached
   * through `fetch` never needs it. An **RPC-only** host does: native RPC
   * bypasses `fetch` entirely, so without an explicit call the `Scheduler`'s
   * storage is never migrated and the first `set` runs against nothing.
   */
  start(): Promise<void>;
  /**
   * Run the lifecycle's alarm phase, which is where due schedules execute.
   *
   * A host that owns `alarm()` **must** call this from it. Nothing else does.
   */
  alarm(): Promise<void>;
  /**
   * The lifecycle's request handling — capability routes, `onRequest`, and
   * connection upgrades. A host serving its own protocol over `fetch` should
   * keep its own rather than delegate here; see {@link
   * InstallSchedulerOptions.hostOwns}.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Recompute the physical alarm from every capability.
   *
   * For the one failure a scheduler cannot see from the inside: the runtime
   * retries a throwing `alarm()` a bounded number of times and then stops for
   * good, and a deleted-class migration takes the alarm with the storage. Both
   * leave rows due with nothing coming for them, and the symptom is silence.
   */
  rearm(): Promise<void>;
  /** Permanently disable and clear alarms, for explicit teardown. */
  disableAlarms(): Promise<void>;
  /** Dispose installed capabilities in reverse registration order. */
  dispose(): Promise<void>;
}

/**
 * One **movable** deadline over a scheduler that has none.
 *
 * The gap this fills is the "no move" edge above. A schedule is a row with a
 * minted id, so "push this deadline back" is cancel-then-set — and a one-shot
 * `set` is not idempotent, so doing only the second half quietly accumulates
 * rows. An idle timer re-armed on every request is the case that bites: it is
 * the busiest path in the object, and every call leaves another row that will
 * wake it.
 *
 * A deadline is named by the storage key that holds its current schedule id.
 * That key is the whole of its durable state, so two deadlines differ only by
 * key and one object may hold as many as it has reasons to wake.
 *
 * Moves on one key are **serialized**, because the read-cancel-create-write a
 * move performs is not atomic and two of them in flight orphan a row. See
 * {@link inFlight}.
 */
export interface Deadline<P = unknown> {
  /**
   * Move the deadline, replacing whatever stood before.
   *
   * A `Date`, not a number — see the "a number is a delay" edge above.
   */
  set(when: Date, payload?: P): Promise<Schedule<P>>;
  /**
   * The schedule standing now, or `undefined` if none is.
   *
   * `undefined` covers both "never set" and "already fired": a scheduler drops a
   * one-shot row once it runs, and a caller that needs to tell those apart wants
   * its own state rather than this.
   */
  get(): Promise<Schedule<P> | undefined>;
  /** Cancel the standing schedule and forget its id. */
  clear(): Promise<void>;
}

export interface DeadlineOptions<
  H extends SchedulerHandlers,
  Name extends keyof H & string
> {
  storage: DurableObjectStorage;
  scheduler: Scheduler<H>;
  /** The storage key holding the id of the schedule currently standing. */
  key: string;
  /** The registered callback this deadline fires. */
  callback: Name;
}

/**
 * One in-flight move per storage key, per object.
 *
 * A move is read-cancel-create-write across several awaits, and a Durable
 * Object's input gate does not span them: it closes while a storage operation is
 * *in flight*, not for the stretch between two of them. So two moves on one key
 * genuinely interleave — both read the same id, both cancel that one row, both
 * create a replacement, and the second write of the id orphans the first
 * replacement. It then fires on a deadline the caller has already moved, and
 * nothing holds its id, so nothing can ever cancel it.
 *
 * Keyed by the **storage object and the key**, not by the {@link Deadline}
 * instance: a caller may mint a fresh handle per call — one per backend, say —
 * and two handles naming one key have to take the same turn. A `WeakMap` on
 * storage keeps this per Durable Object, so two objects that happen to use the
 * same key name do not queue behind each other.
 */
const inFlight = new WeakMap<
  DurableObjectStorage,
  Map<string, Promise<unknown>>
>();

function serialized<T>(
  storage: DurableObjectStorage,
  key: string,
  run: () => Promise<T>
): Promise<T> {
  let byKey = inFlight.get(storage);
  if (byKey === undefined) {
    byKey = new Map();
    inFlight.set(storage, byKey);
  }
  // `then(run, run)` rather than `then(run)`: a move that failed still ends the
  // turn, and a queue that stopped on the first rejection would strand every
  // move behind it for the life of the object.
  const next = (byKey.get(key) ?? Promise.resolve()).then(run, run);
  // What the *next* caller waits on must never reject, or the rejection is
  // reported twice — once to this caller and once to whoever queues behind it.
  byKey.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Bind a {@link Deadline} to one storage key and one registered callback.
 *
 * ```ts
 * const idle = namedDeadline({
 *   storage: this.ctx.storage,
 *   scheduler: this.#wake.scheduler,
 *   key: "idle-reclaim-id",
 *   callback: "reclaim"
 * });
 *
 * await idle.set(new Date(Date.now() + IDLE_MS));  // however often you like
 * ```
 */
export function namedDeadline<
  H extends SchedulerHandlers,
  Name extends keyof H & string
>({
  storage,
  scheduler,
  key,
  callback
}: DeadlineOptions<H, Name>): Deadline<SchedulerPayload<H[Name]>> {
  const standing = () => storage.get<string>(key);

  /**
   * A resolved `false` is the ordinary path, not a failure: the id routinely
   * names a row that is already gone, because a one-shot schedule is dropped
   * when it runs and the deadline a callback re-arms *from* has nothing left to
   * cancel.
   *
   * A **rejection** is a different thing and must not be swallowed. The row may
   * still be live, so forgetting its id here would strand it — firing on a
   * deadline the caller has already moved, with nothing left that could cancel
   * it, because the only handle on it was the id just discarded. Letting this
   * propagate keeps the id and aborts the move, so the next attempt can still
   * reach the row.
   */
  const cancel = async (): Promise<void> => {
    const id = await standing();
    if (id === undefined) return;
    await scheduler.cancel(id);
    await storage.delete(key);
  };

  return {
    set(when, payload) {
      return serialized(storage, key, async () => {
        // Cancel *first*. The reverse order leaves a window in which both rows
        // exist, and a wake-up in it fires the callback against a deadline the
        // caller has already moved.
        await cancel();
        const schedule = await scheduler.set(when, callback, payload);
        await storage.put(key, schedule.id);
        return schedule;
      });
    },
    async get() {
      const id = await standing();
      if (id === undefined) return undefined;
      return (await scheduler.get(id)) as
        Schedule<SchedulerPayload<H[Name]>> | undefined;
    },
    clear: () => serialized(storage, key, cancel)
  };
}

/**
 * Compose a {@link Scheduler} onto a plain Durable Object.
 *
 * ```ts
 * class Worker extends DurableObject<Env> {
 *   readonly #wake = installScheduler(this, {
 *     callbacks: { reclaim: (payload: { name: string }) => this.#reclaim(payload) }
 *   });
 *
 *   async touch(): Promise<void> {
 *     await this.#wake.start();
 *     // A `Date`. A number here would be a delay in *seconds*.
 *     await this.#wake.scheduler.set(new Date(Date.now() + 3_600_000), "reclaim", {
 *       name: "w1"
 *     });
 *   }
 * }
 * ```
 *
 * A host that already owns `alarm()` — because it has work of its own to do on
 * waking — declares it and calls through:
 *
 * ```ts
 * readonly #wake = installScheduler(this, {
 *   callbacks: { ... },
 *   hostOwns: ["alarm"]
 * });
 *
 * override async alarm(): Promise<void> {
 *   await this.#wake.alarm();
 *   // ...the host's own work
 * }
 * ```
 *
 * @throws if the host defines a handler it did not declare in `hostOwns`. That
 * is the whole reason to call this rather than assembling the lifecycle and the
 * scheduler by hand: the failure it prevents produces no error of its own, only
 * a schedule that never fires.
 */
export function installScheduler<
  H extends SchedulerHandlers = SchedulerCallbacks,
  Env extends object = Cloudflare.Env
>(
  host: DurableObject<Env>,
  options: InstallSchedulerOptions<H> = {}
): ScheduledHost<H, Env> {
  const { hostOwns = [], ...schedulerOptions } = options;

  // Read **before** installing, with the same `in` test `installHandlers` uses.
  // Checking own properties afterwards would not be the same question: a host
  // that assigned a handler as an instance field is skipped too, and would look
  // identical to one the lifecycle had just written.
  const declared = new Set<HostHandler>(hostOwns);
  const undeclared = HOST_HANDLERS.filter(
    (name) => name in host && !declared.has(name)
  );
  if (undeclared.length > 0) {
    throw new Error(
      `${host.constructor.name} defines ${undeclared.map((n) => `"${n}"`).join(", ")} ` +
        `and the lifecycle will not replace ${undeclared.length === 1 ? "it" : "them"}. ` +
        `List ${undeclared.length === 1 ? "it" : "each"} in \`hostOwns\` to say so. ` +
        `An "alarm" the host owns must then call through to this object's \`alarm()\`, ` +
        `or every schedule is silently unfired.`
    );
  }

  const scheduler = new Scheduler<H>(schedulerOptions);
  const lifecycle = new Lifecycle<Env>(host);
  lifecycle.use(scheduler);
  lifecycle.installHandlers();

  return {
    scheduler,
    lifecycle,
    start: () => lifecycle.start(),
    alarm: () => lifecycle.alarm(),
    fetch: (request) => lifecycle.fetch(request),
    rearm: () => lifecycle.rearmAlarm(),
    disableAlarms: () => lifecycle.disableAlarms(),
    dispose: () => lifecycle.dispose()
  };
}
