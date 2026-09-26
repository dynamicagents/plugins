/**
 * A long job a Durable Object owns through its alarm — the workspace host's
 * dependency install.
 *
 * **The sibling of {@link file://../alarm/index.ts}, and the pairing is the
 * point.** A `Scheduler` owns *when* an object wakes; this owns *what a job owes
 * on waking*. Neither depends on the other's reason for existing.
 *
 * **Mechanism only.** Nothing here knows what a job *does*: no command, no
 * container, no filesystem, no vendor library. A consumer supplies the handle
 * and the meaning; this supplies the four rules that are wrong in the same way
 * every time — arming before the work starts, one job at a time, a drain that
 * can outlive its job, and a job nobody is draining. See {@link JobLifecycle}.
 *
 * Deliberately **not** called `task`. The A2A task already has that name, with
 * its own lifecycle, its own guarded writes and its own table — and two
 * unrelated meanings in one namespace is a cost paid forever by every reader.
 */

export {
  isRearmable,
  isRunning,
  type DoneJob,
  type FailedJob,
  type IdleJob,
  type JobState,
  type RunningJob,
  type SkippedJob
} from "./state.js";

export {
  JobLifecycle,
  type JobContext,
  type JobHandle,
  type JobLifecycleOptions,
  type JobResult
} from "./lifecycle.js";
