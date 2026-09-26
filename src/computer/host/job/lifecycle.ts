import type {
  Scheduler,
  SchedulerCallbacks,
  SchedulerHandlers
} from "agents/schedules";
import { namedDeadline, type Deadline } from "../alarm/index.js";
import { isRearmable, type JobState, type RunningJob } from "./state.js";

/**
 * The choreography around a long job a Durable Object owns through its alarm.
 *
 * The job itself — what command, where, and what its output means — belongs to
 * the owner. What lives here is the part that is the same every time and is
 * wrong in the same four ways every time:
 *
 * 1. **Arming writes `running` before anything runs.** The alarm has not fired
 *    yet, and a `done` record in that window lets a gated caller through against
 *    a workspace that is not ready. Writing `running` first also makes arming
 *    self-limiting: the next call sees it and stops.
 * 2. **One job at a time**, guarded by a read that goes *through* the staleness
 *    bound — so a `running` record left by a dead isolate resolves rather than
 *    blocking every retry forever.
 * 3. **A drain can outlive the job it watched.** `ctx.waitUntil` keeps running
 *    after the RPC returns, and a late drain writing its verdict over a record
 *    describing a *live* job is silent corruption. {@link generation} is the
 *    marker that makes it harmless.
 * 4. **Nobody may be draining at all.** A watch intent re-attaches to a job
 *    whose isolate went away mid-flight.
 *
 * What is deliberately *not* here is the drain loop. Two real consumers want
 * different ones — an install runs to completion under `waitUntil` and writes a
 * single verdict; a coding-agent run is drained in bounded windows and reports
 * partial progress between them. They share the four rules above and nothing
 * below them, so the loop stays with the owner.
 *
 * ## Storage keys
 *
 * Derived from {@link JobLifecycleOptions.id} so one object can own several
 * jobs. For `id: "install"` they come out as `install`, `install:armed`,
 * `install:last-armed`, `install:context` and `install:watch-id`.
 *
 * The last of those is the one a scheduler forces. A schedule is a row with an
 * id, not a keyed upsert, so re-arming the watchdog means cancelling the
 * previous row and creating another — and cancelling needs the id that only the
 * call which created it ever saw. Holding it in storage is what keeps a watchdog
 * re-armed across a hundred drain windows from leaving a hundred rows behind.
 */

/** What a job's result looks like to the lifecycle. Deliberately minimal. */
export interface JobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A running command, reduced to what the lifecycle needs of it. */
export interface JobHandle {
  result(): Promise<JobResult>;
  [Symbol.dispose](): void;
}

/**
 * The per-job record naming what is running and *which* run it is.
 *
 * `startedAt` is the generation marker, so it is the one required field: a drain
 * compares the stamp it captured against the stamp on disk, and a mismatch means
 * it has been superseded and has nothing useful left to say.
 */
export interface JobContext {
  startedAt: number;
}

export interface JobLifecycleOptions<
  H extends SchedulerHandlers = SchedulerCallbacks
> {
  /** Namespaces every storage key. Also the state record's own key. */
  id: string;
  storage: DurableObjectStorage;
  /**
   * The object's scheduler. Owned by the host, because the callbacks are.
   *
   * Taken directly rather than through an adapter: the only consumer of this
   * module is a Durable Object that already has one, and a narrow interface
   * that `Scheduler` happens to satisfy would buy nothing but a second name for
   * it.
   */
  scheduler: Scheduler<H>;
  /**
   * The registered callback that **runs** a job.
   *
   * A name rather than a function, because that is what a schedule row persists
   * — the callback is re-bound on every wake of the Durable Object, and a
   * closure captured here would not survive one. The host registers it; this
   * only ever schedules it.
   */
  run: keyof H & string;
  /** The registered callback that re-attaches to a job nobody is draining. */
  watch: keyof H & string;
  /**
   * How long a `running` record may stand before it is presumed dead.
   *
   * Measured from `startedAt` and compared against the job's own timeout plus
   * this, never against this alone — the point is to outlast a job that is
   * merely slow, and only then to declare one that is gone.
   */
  staleMs?: number;
  /** How often the watch intent re-checks a job nobody is draining. */
  watchMs?: number;
  /**
   * The floor between two arming attempts.
   *
   * Without it a job that cannot start re-arms on every call into the object.
   */
  armCooldownMs?: number;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_WATCH_MS = 60_000;
const DEFAULT_ARM_COOLDOWN_MS = 5 * 60_000;

export class JobLifecycle<
  TExtra extends object = Record<never, never>,
  TContext extends JobContext = JobContext,
  H extends SchedulerHandlers = SchedulerCallbacks
> {
  readonly #o: Required<Omit<JobLifecycleOptions<H>, "storage" | "scheduler">> &
    Pick<JobLifecycleOptions<H>, "storage" | "scheduler">;

  /** `install` — the state record. */
  readonly stateKey: string;
  /** `install:armed` — the stamp the arming path wrote, for the alarm to match. */
  readonly armedKey: string;
  /** `install:last-armed` — the cooldown floor. */
  readonly lastArmedKey: string;
  /** `install:context` — where the generation marker lives. */
  readonly contextKey: string;
  /** `install:watch-id` — the schedule the watchdog must cancel to re-arm. */
  readonly watchIdKey: string;

  /** The watchdog's one movable deadline, over {@link watchIdKey}. */
  readonly #watch: Deadline;

  constructor(options: JobLifecycleOptions<H>) {
    /**
     * An id is a storage key, so a bad one is not a bad name — it is a write
     * landing on somebody else's row. Empty is the case that actually collides:
     * it yields `:armed` and `:context`, which two differently-broken callers
     * would share.
     *
     * Only empty: a schedule carries an id the scheduler mints and lives in its
     * own row, so no job id can collide with the scheduling machinery however it
     * is spelled. The keys derived here are the only ones worth guarding.
     */
    if (!options.id) throw new Error("a job id must be a non-empty string");
    this.#o = {
      ...options,
      staleMs: options.staleMs ?? DEFAULT_STALE_MS,
      watchMs: options.watchMs ?? DEFAULT_WATCH_MS,
      armCooldownMs: options.armCooldownMs ?? DEFAULT_ARM_COOLDOWN_MS
    };
    this.stateKey = options.id;
    this.armedKey = `${options.id}:armed`;
    this.lastArmedKey = `${options.id}:last-armed`;
    this.contextKey = `${options.id}:context`;
    this.watchIdKey = `${options.id}:watch-id`;
    this.#watch = namedDeadline({
      storage: options.storage,
      scheduler: options.scheduler,
      key: this.watchIdKey,
      callback: options.watch
    });
  }

  // --- the record ------------------------------------------------------------

  /** The raw record, with no staleness repair. `idle` when nothing is written. */
  async read(): Promise<JobState<TExtra>> {
    return (
      (await this.#o.storage.get<JobState<TExtra>>(this.stateKey)) ??
      ({ state: "idle" } as JobState<TExtra>)
    );
  }

  async write(state: JobState<TExtra>): Promise<void> {
    await this.#o.storage.put(this.stateKey, state);
  }

  async context(): Promise<TContext | undefined> {
    return await this.#o.storage.get<TContext>(this.contextKey);
  }

  /**
   * Record which run this is, **before** spawning.
   *
   * The order is the whole point: a drain captures `startedAt` after the spawn,
   * so a context written afterwards would let two runs share a generation.
   */
  async putContext(context: TContext): Promise<void> {
    await this.#o.storage.put(this.contextKey, context);
  }

  // --- arming ----------------------------------------------------------------

  /**
   * Hand a cold job to the alarm, if one is not already pending.
   *
   * Returns the stamp it armed with, or `undefined` when it declined — the
   * caller needs the stamp because it is what the alarm must present to
   * {@link claim} to get past the single-flight guard.
   *
   * An arming caller must **not** own the run. Hand one to `ctx.waitUntil` from
   * a gate poll that returns in milliseconds and the drain is disposed
   * underneath it mid-command. An alarm invocation belongs to the object rather
   * than to any request, so nothing it awaits can be cut short.
   */
  async arm(
    placeholder: Omit<RunningJob<TExtra>, "state" | "startedAt">
  ): Promise<number | undefined> {
    const state = await this.read();
    if (!isRearmable(state)) return undefined;

    const lastArmed = await this.#o.storage.get<number>(this.lastArmedKey);
    if (
      lastArmed !== undefined &&
      Date.now() - lastArmed < this.#o.armCooldownMs
    )
      return undefined;

    const armedAt = Date.now();
    await this.write({
      ...placeholder,
      state: "running",
      startedAt: armedAt
    } as JobState<TExtra>);
    await this.#o.storage.put(this.armedKey, armedAt);
    // Kept even if the scheduling below fails, deliberately: a floor that only
    // applied to *successful* arming would let a persistently failing schedule
    // re-arm on every call into the object, which is what it exists to prevent.
    await this.#o.storage.put(this.lastArmedKey, armedAt);

    /**
     * The placeholder and the schedule that owns it are two writes, and between
     * them is the one window where this can strand a job: a `running` record no
     * schedule points at, which every later {@link arm} then declines to replace
     * *because* it is running.
     *
     * The staleness bound in {@link claim} would eventually free it, but only
     * after a full timeout — so unwind instead, and leave the record exactly as
     * re-armable as it was found.
     */
    try {
      // A `Date`, never the bare number. `set` reads a number as a **delay in
      // seconds** — an epoch-ms stamp passed straight through becomes a delay of
      // roughly fifty thousand years, and nothing rejects it. Every deadline in
      // this module is epoch ms, so every one of them crosses as a `Date`.
      await this.#o.scheduler.set(new Date(armedAt), this.#o.run);
    } catch (err) {
      await this.write(state);
      await this.#o.storage.delete(this.armedKey).catch(() => {});
      throw err;
    }
    return armedAt;
  }

  /** The stamp {@link arm} wrote, so the alarm can recognise its own placeholder. */
  async armedAt(): Promise<number | undefined> {
    return await this.#o.storage.get<number>(this.armedKey);
  }

  async clearArmed(): Promise<void> {
    await this.#o.storage.delete(this.armedKey);
  }

  // --- the single-flight guard ------------------------------------------------

  /**
   * Decide whether a new run may start.
   *
   * `takeOverArmedAt` is the one exemption and it is narrow on purpose. The
   * alarm's placeholder *is* a `running` record for a job that has not started,
   * so the alarm has to pass its own guard — and only its own. Matching the
   * exact stamp it wrote is what stops this becoming "take over any running
   * job", which is the displacement bug the guard exists to prevent: three
   * callers spawning under one exec id in fifty seconds, each displacing the
   * last, every displaced drain still attached and still writing verdicts.
   *
   * Applies the staleness bound **itself**, rather than trusting the caller to
   * have repaired the record first. An earlier draft took an
   * "already-repaired" state and said so in prose, which enforced nothing: the
   * repaired and raw types are identical, so a caller passing a raw read got a
   * `running` record that could never be claimed and a job wedged forever.
   * `timeoutMs` is the job's own budget; see {@link isStale}.
   */
  claim(
    state: JobState<TExtra>,
    timeoutMs: number,
    takeOverArmedAt?: number
  ): { ok: true } | { ok: false; current: RunningJob<TExtra> } {
    if (state.state !== "running") return { ok: true };
    // The alarm presenting its own placeholder — the one narrow exemption.
    if (state.startedAt === takeOverArmedAt) return { ok: true };
    // A record whose isolate is gone must not block every later run.
    if (this.isStale(state, timeoutMs)) return { ok: true };
    return { ok: false, current: state };
  }

  // --- staleness and re-attach -------------------------------------------------

  /**
   * Whether a `running` record has stood long enough to be presumed dead.
   *
   * `timeoutMs` is the job's own budget; the bound is that plus `staleMs`, so a
   * job that is merely slow is never declared gone.
   */
  isStale(
    state: RunningJob<TExtra>,
    timeoutMs: number,
    now: number = Date.now()
  ): boolean {
    return now - state.startedAt > timeoutMs + this.#o.staleMs;
  }

  /**
   * Arm the watchdog that re-attaches to a job nobody is draining.
   *
   * A {@link Deadline} rather than a bare `scheduler.set`, because a drain
   * re-arms on every window and a schedule is a row rather than a keyed upsert.
   * Scheduling without cancelling would leave one row per window, every one of
   * them due, each waking the object to discover the others already handled it.
   */
  async armWatch(now: number = Date.now()): Promise<void> {
    // A `Date`: a number would be read as a delay in seconds.
    await this.#watch.set(new Date(now + this.#o.watchMs));
  }

  /**
   * Disarm the watchdog.
   *
   * Never call this from a superseded drain: the watchdog belongs to whichever
   * run owns the record *now*, and clearing it there disarms the one recovery
   * path the live run has.
   */
  async clearWatch(): Promise<void> {
    await this.#watch.clear().catch(() => {});
  }

  // --- generation --------------------------------------------------------------

  /**
   * A predicate a drain calls before every write, to ask whether it still owns
   * the record.
   *
   * Captures the stamp once, at drain start, and compares it against disk each
   * time. The closure also latches, so a drain can ask afterwards whether it was
   * superseded — which is what decides if it may touch the watchdog.
   */
  generation(startedAt: number): {
    stillMine: () => Promise<boolean>;
    superseded: () => boolean;
  } {
    let superseded = false;
    return {
      stillMine: async (): Promise<boolean> => {
        // The latch is checked *before* the read, not after. Ownership is not
        // recoverable: once another run has owned this record, a stamp that
        // happens to match again does not hand it back, and a drain that
        // regained write access here would be the corruption the marker exists
        // to prevent.
        if (superseded) return false;
        const now = await this.context();
        if (now?.startedAt === startedAt) return true;
        superseded = true;
        return false;
      },
      superseded: () => superseded
    };
  }
}
