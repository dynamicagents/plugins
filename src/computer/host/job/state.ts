/**
 * The record an alarm-owned job writes about itself, and the shape a gate reads.
 *
 * This is the contract between two halves that do not own each other: the
 * Durable Object *runs* the job, and something else — a shell tool, a subagent
 * executor — refuses to proceed while one is in flight. A shape they agreed on
 * informally would drift, and the drift shows up as a command running halfway
 * through the job it was supposed to wait for.
 *
 * ## Why `TExtra` intersects rather than nests
 *
 * The obvious generic is `{ state: "running"; meta: TExtra }`. It is wrong here,
 * and expensively so: every existing reader spells the job's own field at the
 * top level (`status.command`), so nesting would rewrite every read site and
 * every spec assertion in both consumers to buy nothing. Intersecting keeps
 * `JobState<{ command: string }>` *byte-identical* to the hand-written union it
 * replaces, which is what makes adopting this a type change and not a refactor.
 *
 * The cost of the choice is that `TExtra` must not collide with the field names
 * below. That is a real constraint, and it is why they are named for the
 * mechanism (`startedAt`, `finishedAt`, `exitCode`) rather than for any job.
 */

/**
 * A job's durable state.
 *
 * Five variants, and the two that look redundant are not:
 *
 * - `idle` — nothing has ever run. There is no context recording *where* or
 *   *what*, so a caller cannot re-drive it; that is the owner's job.
 * - `skipped` — something looked and decided there was nothing to do. Terminal
 *   and *correct*, which is why it is not `done`: a gate must not treat a
 *   deliberate no-op as a failure to retry, and an arming path must not re-drive
 *   it forever.
 * - `running` — in flight, or believed to be. Never trusted without the
 *   staleness bound in {@link JobLifecycle.claim}, because the isolate that
 *   wrote it may be long gone.
 * - `done` / `failed` — terminal, carrying enough to explain the outcome without
 *   the caller reaching for the transcript.
 */
/** Nothing has ever run; no context exists naming what would. */
export type IdleJob = { state: "idle" };

/** Something looked and decided there was nothing to do. Terminal and correct. */
export type SkippedJob = { state: "skipped"; reason: string };

/** In flight, or believed to be. Never trusted without the staleness bound. */
export type RunningJob<TExtra = Record<never, never>> = {
  state: "running";
  startedAt: number;
  tail?: string;
} & TExtra;

export type DoneJob<TExtra = Record<never, never>> = {
  state: "done";
  exitCode: number;
  finishedAt: number;
  ms: number;
  tail?: string;
} & TExtra;

export type FailedJob<TExtra = Record<never, never>> = {
  state: "failed";
  finishedAt: number;
  error: string;
  exitCode?: number;
  tail?: string;
} & TExtra;

/**
 * A job's durable state.
 *
 * The variants are named types rather than inlined into the union because
 * `Extract<JobState<TExtra>, { state: "running" }>` cannot narrow while `TExtra`
 * is generic — the compiler has no way to prove `DoneJob & TExtra` does not also
 * carry `state: "running"`. Naming them is what lets a caller say
 * `RunningJob<TExtra>` and get its fields.
 */
export type JobState<TExtra = Record<never, never>> =
  | IdleJob
  | SkippedJob
  | RunningJob<TExtra>
  | DoneJob<TExtra>
  | FailedJob<TExtra>;

/**
 * Whether a state is one a new run may start from.
 *
 * `done` and `failed` both qualify, and the second was a gap worth closing in
 * the predecessor: arming used to require `done`, so one bad run left a record
 * that declined to re-arm forever — one failure poisoning every task after it.
 *
 * `skipped` and `idle` are excluded for different reasons. `skipped` means the
 * answer is already correct and permanent. `idle` means no context exists naming
 * what to run, so there is nothing to re-drive.
 */
export function isRearmable<TExtra extends object>(
  state: JobState<TExtra>
): boolean {
  return state.state === "done" || state.state === "failed";
}

/** Whether a state claims a job is in flight. Never conclusive on its own. */
export function isRunning<TExtra extends object>(
  state: JobState<TExtra>
): state is RunningJob<TExtra> {
  return state.state === "running";
}
