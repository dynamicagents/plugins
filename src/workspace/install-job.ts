import { shellQuote, type Workspace } from "@cloudflare/computer";
import type { WorkspaceRuntimeExecHandle } from "@cloudflare/computer";
import type { Scheduler } from "@dynamicagents/core/alarm";
import { JobLifecycle } from "@dynamicagents/core/job";
// Leaf modules rather than `./index.ts`, and that is structural: the barrel
// re-exports this directory, so reaching it from here would be a cycle — through
// a module that builds a class at import time, where initialisation order
// decides whether the base is `undefined`.
import {
  installFingerprint,
  resolveInstallCommand,
  rootFingerprint,
  type InstallPlan,
  type InstallProbe,
  type InstallState
} from "./install.js";
import { pathExists } from "./read.js";
import { deploymentFault } from "./container-fault.js";
import { INSTALLED_MARKER } from "./container-deps.js";
import { truncateOutput } from "./format.js";
import type { WorkspaceWakeHandlers } from "./wake.js";

/**
 * Whether a thrown value is the runtime reporting a replaced container.
 *
 * `code` rather than the message: the property the package sets deliberately,
 * and the one that survives a reworded string. What it means here is narrower
 * than "the command failed" — the container that command was running in is gone,
 * so anything this object believed about *that* container is now about nothing.
 */
function execWasLost(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "EEXEC_LOST";
}

/**
 * The dependency install: when it runs, what it runs, and what it owes on
 * waking.
 *
 * ## The rule every guard here serves
 *
 * `running` is the one install state that **blocks work**: the plugin's gate
 * waits on it and then refuses to run. Every other state is a fact an agent
 * can act on. So a `running` record must never outlive the command it describes,
 * and the ways it can are not all reachable from one place — the spawn can fail
 * before a drain is attached, a drain can be cut short by an eviction, `getExec`
 * can hand back a handle to a container that never answers, and installs can
 * displace each other. Each guard below names the one it closes; the staleness
 * bound in {@link InstallJob.state} is the proof that covers the rest.
 *
 * ## What decides that an install is needed
 *
 * The tree lives on the container's disk (see `./container-deps.ts`), so it goes
 * with the container. {@link CONTAINER_TREE_KEY} records a successful install — or
 * a tree restored with a snapshot of the container that ran one, through
 * {@link InstallJob.adopt} — and is cleared whenever that container is seen gone.
 */

/**
 * The install's job id, which is also the key its state record lives under.
 *
 * Every other key is derived from it by `JobLifecycle`: `install:armed`,
 * `install:last-armed`, `install:context`, and the wake intents `install-run`
 * and `install-watch`. Changing this value renames all of them, which is a
 * storage migration — the specs that read these keys directly would fail first.
 */
const INSTALL_KEY = "install";

/**
 * How long after arming an install before arming another.
 *
 * The bound on a *failing* install. A successful one is self-limiting — it
 * leaves a tree in the workspace, so the arming probe short-circuits every later
 * call — but a failure lands back on `failed` with the tree still absent, and
 * `__getWorkspaceStub` is the busiest entry point in the object, so it would
 * re-arm on essentially every tool call. Five minutes is far longer than an
 * install (88s measured), so a broken install retries at roughly the rate a
 * human would and a later task still gets a fresh attempt.
 */
const INSTALL_ARM_COOLDOWN_MS = 5 * 60_000;

/** How often the watchdog checks on a running install. */
const INSTALL_WATCH_MS = 60_000;

/**
 * How far past its own timeout a `running` install is still given the benefit of
 * the doubt. Generous on purpose: declaring a live install dead costs a
 * duplicate `npm ci`, and the margin only has to cover the slack between the
 * runtime killing a command and this object hearing about it.
 */
const INSTALL_STALE_MS = 5 * 60_000;

/**
 * What the install records about itself, alongside the state record: `dir`
 * because the alarm that re-runs an install has no caller to ask, `repo` so a
 * repository with an `INSTALL_PLAN` override resolves the same command the
 * second time, `fingerprint` for the skip condition, and `command` so a
 * re-attach can name what it is waiting on.
 */
interface InstallContext {
  dir: string;
  repo?: string;
  fingerprint: string | null;
  command: string;
}

/** What `#prepare` leaves: a run it settled, or one ready to spawn. */
type Prepared =
  | { kind: "settled"; state: InstallState }
  | {
      kind: "spawn";
      resolution: { command: string };
      fingerprint: string | null;
      state: InstallState;
    };

/** One install's hold on the record — see core's `/job` `generation`. */
type InstallRun = ReturnType<
  JobLifecycle<{ command: string }, InstallContext>["generation"]
>;

/**
 * What the running container holds: the tree a host install finished, for which
 * directory and lockfile. Written on exit 0, deleted when the container goes.
 */
const CONTAINER_TREE_KEY = "install:tree";

/** Records a deployed object may still hold, deleted on the next install. */
const RETIRED_KEYS = ["install:syncing", "install:completed"];

interface ContainerTree {
  dir: string;
  fingerprint: string | null;
  at: number;
}

/**
 * The command a reservation's placeholder names, until the install's own is
 * resolved. The gate renders it while it waits.
 */
const RESOLVING = "(being resolved)";

/**
 * The exec id an install runs under.
 *
 * Fixed rather than generated, because the point is to find it again: an
 * isolate that dies mid-drain leaves the command running in the container, and
 * `getExec(id, { resume: "tail" })` is how the next invocation re-attaches
 * instead of starting a second `npm ci` alongside the first.
 */
const INSTALL_EXEC_ID = "dependency-install";

export interface InstallJobDeps {
  storage: DurableObjectStorage;
  scheduler: Scheduler<WorkspaceWakeHandlers>;
  workspace: () => Workspace;
  /** How this deployment installs dependencies for this agent's checkouts. */
  plan: () => InstallPlan;
  /** How long an install may run before it is killed. */
  timeoutMs: () => number;
  /** Set only when the workspace is over its ceiling. */
  headroom: () => { bytes: number; capBytes: number } | undefined;
  /** The object's own entry-point bookkeeping, which an install still owes. */
  touch: () => Promise<void>;
  ready: () => Promise<void>;
  /** Hand a drain to the invocation, for the caller that can hold one. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** A container was replaced, so nothing believed about it still holds. */
  containerGone: () => Promise<void>;
  /** An install exited 0, so this container now holds the tree for `fingerprint`. */
  installed: (tree: { dir: string; fingerprint: string }) => Promise<void>;
  tag: () => string;
  id: () => string;
}

/** Where an install goes: the checkout, and the repository for its override. */
export interface InstallTarget {
  dir: string;
  repo?: string;
}

export class InstallJob {
  /**
   * The dependency install, as a job this object owns through its alarm.
   *
   * `JobLifecycle` is core's, and what it owns is the choreography that is wrong
   * the same ways every time: arming before anything runs, one job at a time
   * under a staleness bound, a drain that can outlive its job, and a job nobody
   * is draining. The timings below are this install's. The **drain
   * loop stays here**, because an install runs to completion and writes a single
   * verdict rather than reporting progress between bounded windows.
   *
   * **The alarm runs the install, and that is not a detail.** An install takes
   * ~85 seconds and must not be owned by the request that noticed it was needed
   * — a drain handed to `ctx.waitUntil` from a gate poll that returns in
   * milliseconds is disposed mid-`npm ci`. An alarm invocation belongs to the
   * object rather than to any caller, so nothing it awaits can be cut short by a
   * response being sent.
   *
   * **Arming writes `running` before anything is running**, which holds the gate
   * shut in the moments before the alarm fires. The alarm then presents the stamp
   * arming wrote to `reserve`, which recognises its own placeholder and nothing
   * else — taking over any `running` record instead would be displacement again.
   *
   * Every write a run makes goes through the lifecycle's `generation`, under
   * the `startedAt` its reservation returned, so a run that has been displaced
   * writes nothing.
   */
  readonly #job: JobLifecycle<
    { command: string },
    InstallContext,
    WorkspaceWakeHandlers
  >;

  // Built here rather than as a field initializer, which would run before the
  // constructor's own parameter property and read `deps` as undefined.
  constructor(private readonly deps: InstallJobDeps) {
    this.#job = new JobLifecycle({
      id: INSTALL_KEY,
      storage: deps.storage,
      scheduler: deps.scheduler,
      run: "installRun",
      watch: "installWatch",
      staleMs: INSTALL_STALE_MS,
      watchMs: INSTALL_WATCH_MS,
      armCooldownMs: INSTALL_ARM_COOLDOWN_MS
    });
  }

  /**
   * Start a dependency install the moment we can see one will be needed.
   *
   * The signal is {@link CONTAINER_TREE_KEY}: a local read, true only while the
   * container that ran the install is the one running.
   *
   * Armed as soon as a container is up or a command is about to start one,
   * because the model's first minute is README-reading and `git status` — an
   * install armed there runs *through* that minute, where one armed on the first
   * `npm` command charges its full time to that command.
   *
   * It writes `running` before anything is running: the alarm has not fired yet,
   * and a `done` record would let an `npm` command through against a tree that
   * is not there. That also makes this self-limiting — the next call sees
   * `running` and stops.
   */
  async armIfTreeMissing(): Promise<void> {
    // Where the install went, and the only record of it: there is no caller here
    // to ask, which is why `repo` is persisted alongside `dir`. Nothing to arm
    // for a workspace that has never installed anything — that is `repo_clone`'s
    // job, not this one's.
    const context = await this.#job.context();
    if (!context?.dir) return;

    // The branch that runs on almost every call, and it costs one local read.
    const tree = await this.#tree();
    if (tree?.dir === context.dir && tree.fingerprint === context.fingerprint)
      return;

    /**
     * `done` **or** `failed`, matching core's `isRearmable`, and narrowed to the
     * pair that carries a `state.command` — the placeholder needs one, since the
     * gate renders it while the alarm is still pending.
     *
     * **`failed` has to be in there.** Leaving it out means a workspace whose
     * install failed once declines to arm ever again, and one bad install
     * poisons every task after it. Re-driving a failure cannot loop here: the
     * arming cooldown is the floor under how often that can happen.
     *
     * `skipped` and `idle` stay out for reasons rather than caution: `skipped`
     * means the resolver found nothing to install, so a missing tree is correct
     * and permanent; `idle` means nothing has ever been installed, so there is
     * no `install:context` naming where to do it.
     *
     * {@link state} rather than the lifecycle's raw `read()`, so a `running`
     * record left by a dead isolate is repaired to `failed` here and can arm.
     */
    const state = await this.state();
    if (state.state !== "done" && state.state !== "failed") return;

    console.info(
      `[${this.deps.tag()}] no dependency tree — arming an install`,
      {
        id: this.deps.id(),
        dir: context.dir
      }
    );

    // Everything the arming handshake needs — the placeholder write, the stamp
    // the alarm presents to `reserve`, the cooldown floor and the run intent — in
    // one call, and unwound as a unit if the intent cannot be scheduled.
    await this.#job.arm({ command: state.command });
  }

  /** `resolveInstallCommand` reads the checkout through this. */
  #probe(): InstallProbe {
    const fs = this.deps.workspace().fs;
    return {
      // The plugin's own, which asks for the stub's `exists` and only falls back
      // to `stat` when there is none — the local `WorkspaceFilesystem` here being
      // exactly that case.
      exists: (path) => pathExists(fs, path),
      readFile: (path) => fs.readFile(path, "utf8")
    };
  }

  async #tree(): Promise<ContainerTree | undefined> {
    return await this.deps.storage.get<ContainerTree>(CONTAINER_TREE_KEY);
  }

  /** Where the last install ran, for the container setup's marker read. */
  async dir(): Promise<string | undefined> {
    return (await this.#job.context())?.dir;
  }

  /** Where the last install ran, and for which repository's override. */
  async target(): Promise<InstallTarget | undefined> {
    const context = await this.#job.context();
    if (!context?.dir) return undefined;
    return {
      dir: context.dir,
      ...(context.repo ? { repo: context.repo } : {})
    };
  }

  /**
   * The fingerprint an install into `target` would write as its marker, from the
   * checkout as it stands — `null` when there is nothing to install there.
   */
  async fingerprintFor(target: InstallTarget): Promise<string | null> {
    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      target.dir,
      this.deps.plan(),
      target.repo
    );
    return await installFingerprint(probe, target.dir, resolution);
  }

  /** What `dir`'s install inputs hash to — see `rootFingerprint`. */
  async rootFingerprint(dir: string): Promise<string | null> {
    return await rootFingerprint(this.#probe(), dir, this.deps.plan());
  }

  /** The tree this container holds, if a finished install says it does. */
  async tree(): Promise<
    { dir: string; fingerprint: string | null } | undefined
  > {
    const tree = await this.#tree();
    return tree && { dir: tree.dir, fingerprint: tree.fingerprint };
  }

  /**
   * Record a tree this container came up holding — restored with a snapshot of
   * the container that installed it — as if this container had installed it.
   *
   * Only for a tree whose marker the setup read and matched against the checkout
   * as it stands; see `./deps-snapshot.ts`. So the last install's context moves
   * to it too: a checkout that moved since that install would otherwise read as
   * missing its tree, and arm an install that finds the tree already there.
   */
  async adopt(tree: { dir: string; fingerprint: string }): Promise<void> {
    await this.deps.storage.put(CONTAINER_TREE_KEY, {
      dir: tree.dir,
      fingerprint: tree.fingerprint,
      at: Date.now()
    } satisfies ContainerTree);
    const context = await this.#job.context();
    if (context?.dir === tree.dir && context.fingerprint !== tree.fingerprint)
      await this.#job.putContext({ ...context, fingerprint: tree.fingerprint });
    console.info(`[${this.deps.tag()}] adopted a restored dependency tree`, {
      id: this.deps.id(),
      dir: tree.dir
    });
  }

  /** The container went away, and its tree with it. */
  async containerGone(): Promise<void> {
    await this.deps.storage.delete(CONTAINER_TREE_KEY);
  }

  /**
   * Check the record against the marker a new isolate's setup read.
   *
   * The record can outlive its container in an isolate that did not watch it
   * exit; the marker cannot.
   */
  async reconcile(marker: string | null): Promise<void> {
    const tree = await this.#tree();
    if (!tree || (tree.fingerprint ?? "none") === marker) return;
    console.warn(
      `[${this.deps.tag()}] the container does not hold the recorded tree`,
      {
        id: this.deps.id(),
        dir: tree.dir
      }
    );
    await this.containerGone();
  }

  /**
   * The record exactly as the job wrote it, with no staleness bound applied.
   *
   * {@link state} is what almost everything wants. This is for the one caller
   * that must not repair anything on the way past: the container-idle handler,
   * which only needs to know whether something is running before it destroys the
   * container underneath it.
   */
  async read(): Promise<InstallState> {
    return await this.#job.read();
  }

  /**
   * Start installing this checkout's dependencies, and return without waiting.
   *
   * Called from `repo_clone` through the repo plugin's `afterCheckout` hook, so
   * it runs inside a model turn and must not block on the install — 225 seconds
   * for slack-gatekeeper, against a turn that is cut at fifteen minutes.
   *
   * That caller is a model turn, which lives long enough to hold the drain handed
   * to `ctx.waitUntil` below. **A short-lived caller cannot**, which is why an
   * install the alarm drives is awaited inside that alarm rather than calling
   * this.
   */
  async start(req: { dir: string; repo?: string }): Promise<InstallState> {
    return this.#beginInstall(req, (handle, startedAt) => {
      // Drained here, in this object, on nobody's step budget. The watchdog picks
      // it up if this isolate does not survive the command.
      this.deps.waitUntil(this.#drainInstall(handle, startedAt));
    });
  }

  /**
   * The same install, drained **inside the caller** rather than after it.
   *
   * For the alarm, which owns no request: nothing it awaits can be cut short by a
   * response being sent, so the drain cannot be disposed out from under an
   * `npm ci` half-way through. Returns once the command has actually finished.
   */
  async #awaited(
    req: { dir: string; repo?: string },
    armedAt: number
  ): Promise<InstallState> {
    await this.#beginInstall(
      req,
      (handle, startedAt) => this.#drainInstall(handle, startedAt),
      { takeOverArmedAt: armedAt }
    );
    return this.state();
  }

  /**
   * Resolve, guard, spawn — and hand the running command to `own`, which decides
   * whether the drain outlives this call or is awaited within it. That choice is
   * the only difference between the two entry points above, and it is the
   * difference that broke production, so it is the one thing this parameterises.
   */
  async #beginInstall(
    req: { dir: string; repo?: string },
    own: (
      handle: WorkspaceRuntimeExecHandle<"utf8">,
      startedAt: number
    ) => void | Promise<void>,
    opts?: { takeOverArmedAt?: number }
  ): Promise<InstallState> {
    await this.deps.touch();
    await this.deps.ready();

    // {@link state} rather than the lifecycle's raw `read()`: a `running` record
    // left by a dead isolate is repaired on the way past, and one nobody is
    // draining is re-attached.
    const current = await this.state();

    /**
     * A full workspace refuses the install and **writes nothing**.
     *
     * Capacity is not an install outcome, and recording it as one costs twice
     * over. `skipped` is the variant meaning "this checkout has nothing to
     * install", so a hard wall about the Durable Object would arrive wearing the
     * label of a routine fact about the repository; and writing any record here
     * erases what the record held, so a real install failure would disappear the
     * moment the object filled up.
     *
     * It travels as its own advisory instead, from {@link advisories}, which
     * reads it fresh on every call and therefore reaches commands that have
     * nothing to do with dependencies.
     */
    const full = this.deps.headroom();
    if (full) {
      console.error(
        `[${this.deps.tag()}] refusing to install: the workspace is full`,
        {
          id: this.deps.id(),
          bytes: full.bytes,
          capBytes: full.capBytes
        }
      );
      return current;
    }

    /**
     * One install at a time — the hazard is displacement.
     *
     * `repo_clone` calls this and a recovered turn calls it again. Every call
     * spawns with the same {@link INSTALL_EXEC_ID}, so without this each would
     * displace the last while the displaced command's drain stayed attached
     * through `ctx.waitUntil` — then wrote *its* outcome over a record
     * describing an install still running perfectly well.
     *
     * Reserved rather than checked: everything between here and the spawn —
     * probing the checkout, hashing the lockfile — awaits the container, and a
     * check that wrote nothing would let a second caller through in that time.
     *
     * `takeOverArmedAt` is the one exemption, narrow on purpose: the alarm's
     * placeholder is a `running` record for an install that has not started, so
     * the alarm must pass its own guard and only its own. Matching the exact
     * `startedAt` it wrote is what stops that becoming "take over any running
     * install", which is displacement again in a new hat.
     */
    const reserved = await this.#job.reserve(
      { command: RESOLVING },
      this.deps.timeoutMs(),
      opts?.takeOverArmedAt
    );
    if (!reserved.ok) {
      console.info(`[${this.deps.tag()}] an install is already in flight`, {
        id: this.deps.id(),
        command: reserved.current.command,
        seconds: Math.round((Date.now() - reserved.current.startedAt) / 1000)
      });
      return reserved.current;
    }
    const { startedAt } = reserved;
    const run = this.#job.generation(startedAt);
    this.#owned.add(startedAt);
    let handed = false;
    try {
      return await this.#spawnReserved(req, run, reserved, own, () => {
        handed = true;
      });
    } finally {
      if (!handed) this.#owned.delete(startedAt);
    }
  }

  /**
   * Everything after the reservation: prepare, spawn, and hand the command to
   * `own`. Split out so {@link #beginInstall} can hold the generation for exactly
   * this long — `handing` is called as the drain takes it over.
   */
  async #spawnReserved(
    req: { dir: string; repo?: string },
    run: InstallRun,
    reserved: { startedAt: number; previous: InstallState },
    own: (
      handle: WorkspaceRuntimeExecHandle<"utf8">,
      startedAt: number
    ) => void | Promise<void>,
    handing: () => void
  ): Promise<InstallState> {
    const { startedAt } = reserved;

    // Nothing trusts the interception CA here, deliberately: the workspace's own
    // `ready` does it, above every early return in this method. An install
    // already in flight and a full workspace both return before this line, and
    // neither of them means the container cannot speak TLS — the full workspace
    // least of all, since egress is what the agent needs to dig itself out.

    let prepared: Prepared;
    try {
      prepared = await this.#prepare(req, run, startedAt);
    } catch (err) {
      await this.#release(run, reserved.previous, err);
      throw err;
    }
    if (prepared.kind === "settled") return prepared.state;
    const { resolution, fingerprint, state } = prepared;

    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      // The marker lets a new isolate check {@link CONTAINER_TREE_KEY} against
      // the container; see `reconcile`.
      const marked =
        `${resolution.command} && printf %s ` +
        `${shellQuote(fingerprint ?? "none")} > node_modules/${INSTALLED_MARKER}`;
      handle = await this.deps.workspace().runtime.exec(marked, {
        id: INSTALL_EXEC_ID,
        cwd: req.dir,
        encoding: "utf8",
        timeoutMs: this.deps.timeoutMs()
      });
    } catch (err) {
      // The command never started, so nothing will ever drain it and no
      // re-attach can find it. Close the record here: a `failed` install is
      // recoverable — the agent is told what happened and can run the command
      // itself — where a `running` one that nobody owns is not.
      //
      // Which sentence, though, depends on why. The default advice — run it
      // yourself with `bash` — is good for a container that is merely
      // unreachable, and useless for a deployment fault: the same container is
      // what `bash` would have to reach. Under one of those, say what an
      // operator has to do and do not send the agent after a command that
      // cannot run either.
      const fault = deploymentFault(err);
      console.error(
        `[${this.deps.tag()}] ${fault?.summary ?? "the install could not be started"}`,
        {
          id: this.deps.id(),
          command: resolution.command,
          ...(fault ? { remedy: fault.remedy } : {}),
          err: String(err)
        }
      );
      const failed: InstallState = {
        state: "failed",
        command: resolution.command,
        finishedAt: Date.now(),
        error: fault
          ? `the install could not be started: ${fault.remedy}`
          : `the install could not be started (${String(err)}). The container ` +
            "was most likely unreachable. Run the command yourself with bash, " +
            "or clone again to retry it."
      };
      return await this.#settle(run, failed);
    }

    handing();
    await own(handle, startedAt);

    return state;
  }

  /**
   * Everything between a reservation and the spawn: resolve the command, and
   * settle the run here when there is nothing to install or the tree is already
   * this lockfile's. Otherwise write this install's own `running` record and
   * context, and arm the watchdog.
   */
  async #prepare(
    req: { dir: string; repo?: string },
    run: InstallRun,
    startedAt: number
  ): Promise<Prepared> {
    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      req.dir,
      this.deps.plan(),
      req.repo
    );

    if (resolution.kind === "skip") {
      const state: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      /**
       * The common branch, and the one whose absence is indistinguishable from
       * never having been called.
       *
       * Every other outcome here leaves a line — an install in flight, a full
       * workspace, a spawn that failed, each end of the drain — so a workspace
       * that skipped and a workspace that never installed read identically in the
       * logs, and any checkout without a `package.json` takes this path. A skip
       * is routine; establishing that one happened should not require an argument
       * from silence.
       */
      console.info(`[${this.deps.tag()}] install skipped`, {
        id: this.deps.id(),
        dir: req.dir,
        ...(req.repo ? { repo: req.repo } : {}),
        reason: resolution.reason
      });
      return { kind: "settled", state: await this.#settle(run, state) };
    }

    const fingerprint = await installFingerprint(probe, req.dir, resolution);

    // Skipped only for this container's own tree, for this lockfile.
    const tree = await this.#tree();
    if (
      fingerprint &&
      tree?.dir === req.dir &&
      tree.fingerprint === fingerprint
    ) {
      const state: InstallState = {
        state: "done",
        command: resolution.command,
        exitCode: 0,
        finishedAt: Date.now(),
        ms: 0,
        tail: "dependencies already installed in this container for this lockfile"
      };
      return { kind: "settled", state: await this.#settle(run, state) };
    }

    // The tree is rebuilt from here, so nothing vouches for it until exit 0.
    await this.deps.storage.delete([CONTAINER_TREE_KEY, ...RETIRED_KEYS]);

    const state: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt
    };
    if (!(await run.write(state))) {
      return { kind: "settled", state: await this.#job.read() };
    }
    await this.#job.putContext({
      dir: req.dir,
      // Kept so a reinstall the alarm drives — which has no caller to ask —
      // resolves the same command this one did. Without it a repository
      // with an `INSTALL_PLAN` override would silently fall back to the default
      // on every later run, installing a different tree than the first time.
      ...(req.repo ? { repo: req.repo } : {}),
      fingerprint,
      command: resolution.command
    });

    /**
     * Armed **before** the spawn — the hazard is an isolate that dies between
     * the two.
     *
     * The record above already says `running`, so from here until something
     * writes a terminal state the gate is shut and the alarm is the only thing
     * that can open it. Arming afterwards leaves a window with nothing scheduled
     * to recover: a `runtime.exec` that threw on the container's WebSocket left
     * a workspace `running` for half an hour, refusing every command.
     *
     * Arming early is free — the handler clears the intent if the record is not
     * `running`, so finishing first costs one wake-up.
     */
    await this.#job.armWatch();

    return { kind: "spawn", resolution, fingerprint, state };
  }

  /** Settle `run` with `state`, or say what stands if it was displaced. */
  async #settle(run: InstallRun, state: InstallState): Promise<InstallState> {
    return (await run.write(state)) ? state : await this.#job.read();
  }

  /**
   * Hand a reservation back when nothing was spawned under it: the record as it
   * was, unless that was a run of its own — the alarm's placeholder — which
   * nothing would now finish, so `failed`.
   */
  async #release(
    run: InstallRun,
    previous: InstallState,
    err: unknown
  ): Promise<void> {
    const back: InstallState =
      previous.state === "running"
        ? {
            state: "failed",
            command: previous.command,
            finishedAt: Date.now(),
            error:
              `the install could not be prepared (${String(err)}). Run the ` +
              "command yourself with bash, or clone again to retry it."
          }
        : previous;
    try {
      await run.write(back);
    } catch (rollback) {
      throw new AggregateError(
        [err, rollback],
        "the install could not be prepared, and its reservation could not be released"
      );
    }
  }

  /**
   * Whether this container holds a finished tree, asked only when it qualifies a
   * `deps-broken` advisory (see `deriveAdvisories`).
   */
  async treePresentIfItMatters(install: InstallState): Promise<boolean> {
    if (install.state !== "failed") return false;
    const dir = await this.dir();
    return dir !== undefined && (await this.#tree())?.dir === dir;
  }

  /**
   * The install record itself, with its staleness bound and re-attach applied.
   *
   * Split from {@link advisories} so `startInstall` can consult the record
   * without going through the `node_modules` probe, which needs a container and
   * has nothing to say about whether an install may start.
   *
   * Re-attaches on the way past. An isolate reset leaves the record saying
   * `running` with nothing draining it, and without this the state would say
   * `running` forever while the command had long since finished.
   */
  async state(): Promise<InstallState> {
    const state = await this.#job.read();

    if (state.state !== "running") return state;

    /**
     * `running` has an expiry — the proof the file header refers to.
     *
     * The command carries a `timeoutMs` the runtime enforces, so past that plus
     * a wide margin a live install is not a possibility: whatever the record
     * says, nobody is coming back with an exit code. Writing `failed` here is
     * not a guess about what happened, it is the only accurate thing left to
     * say — which is what makes it a bound rather than another guard.
     */
    if (this.#job.isStale(state, this.deps.timeoutMs())) {
      const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
      console.error(`[${this.deps.tag()}] abandoning a stale install`, {
        id: this.deps.id(),
        command: state.command,
        minutes
      });
      const failed: InstallState = {
        state: "failed",
        command: state.command,
        finishedAt: Date.now(),
        error:
          `the install has been running for ${minutes} minutes without ` +
          "reporting, which is past its timeout — it is not going to finish. " +
          "Run the command yourself with bash if you still need it."
      };
      // Under the record's own generation, so a reservation that took the record
      // since it was read is not overwritten.
      const repaired = await this.#job
        .generation(state.startedAt)
        .write(failed);
      return repaired ? failed : await this.#job.read();
    }

    if (await this.#drivenHere(state.startedAt)) return state;
    await this.#reattachInstall(state.startedAt);
    return await this.#job.read();
  }

  /**
   * When a reinstall was queued, if one is waiting to run.
   *
   * Read by {@link file://./advisory.ts deriveAdvisories}, which is the only
   * caller that needs it: a `failed` record with a repair already queued is a
   * transient condition wearing a permanent record's clothes.
   */
  async reinstallArmedAt(): Promise<number | undefined> {
    return await this.#job.armedAt();
  }

  /**
   * The generations this isolate is driving: reserved, taken over from the
   * alarm's placeholder, or draining — until the drain ends.
   *
   * The re-attach is for a `running` record nobody here is driving, which is one
   * a dead isolate left. Asked of a generation that is reserved but not yet
   * spawned, it finds no exec, or the last container's, and writes `failed` over
   * an install about to start, whose own verdict is then discarded as
   * superseded. Owning from the reservation rather than from the drain is what
   * closes that window: resolving and spawning await the container for seconds.
   */
  readonly #owned = new Set<number>();

  /**
   * Whether a `running` record's install is this isolate's to finish: one it
   * owns, or the alarm's placeholder still waiting for the alarm, whose
   * `startedAt` is the arming stamp.
   */
  async #drivenHere(startedAt: number): Promise<boolean> {
    return (
      this.#owned.has(startedAt) || (await this.#job.armedAt()) === startedAt
    );
  }

  async #drainInstall(
    handle: WorkspaceRuntimeExecHandle<"utf8">,
    /**
     * The generation this drain writes under: the `startedAt` its reservation
     * returned, or — re-attached — the running record's.
     *
     * Passed in rather than read below: this method's first `await` is reached
     * long after `#beginInstall` returned, and a record read then may already be
     * a later install's, whose generation this drain would adopt.
     */
    startedAt: number
  ): Promise<void> {
    this.#owned.add(startedAt);
    const context = await this.#job.context();
    const command = context?.command ?? "(unknown)";

    /**
     * Whether this drain still owns the record.
     *
     * The reservation in `#beginInstall` stops two installs overlapping in the
     * first place; this makes it harmless if one ever does. A drain can outlive
     * the command it was watching — `ctx.waitUntil` keeps running after the RPC
     * returns — and the damage a late one does is silent: it writes a verdict
     * about a finished command over a record describing a live one, and every
     * `bash` then reads a result that belongs to nothing.
     *
     * Every write goes through `run.write`, which checks and writes in one step
     * and clears the watchdog with a verdict. `stillMine` is asked only before
     * this drain's own side effects. The superseded line is logged once — a
     * superseded drain can be refused on both the success and the error path.
     */
    const run = this.#job.generation(startedAt);
    let logged = false;
    const superseded = async (): Promise<void> => {
      if (logged) return;
      logged = true;
      const current = await this.#job.read();
      console.warn(
        `[${this.deps.tag()}] discarding a superseded install drain`,
        {
          id: this.deps.id(),
          command,
          startedAt,
          current:
            current.state === "running" ? current.startedAt : current.state
        }
      );
    };
    const stillMine = async (): Promise<boolean> => {
      if (await run.stillMine()) return true;
      await superseded();
      return false;
    };
    const settle = async (
      verdict: InstallState,
      also?: Record<string, unknown>
    ): Promise<boolean> => {
      if (await run.write(verdict, also)) return true;
      await superseded();
      return false;
    };

    try {
      const result = await handle.result();
      // Middle-out rather than a tail cut, and it marks what it dropped: an
      // install's diagnosis is split between the two ends — the first error and
      // the summary that follows it — and a plain `slice(-n)` silently keeps
      // only the half that happens to be last.
      const tail = truncateOutput(result.stdout + result.stderr, 2000);
      if (!(await stillMine())) return;

      if (result.exitCode === 0) {
        // With the verdict, in the same write: the tree is this install's only if
        // the verdict is.
        const tree: ContainerTree | undefined = context?.dir
          ? {
              dir: context.dir,
              fingerprint: context.fingerprint,
              at: Date.now()
            }
          : undefined;
        console.info(`[${this.deps.tag()}] install finished`, {
          id: this.deps.id(),
          command,
          seconds: Math.round((Date.now() - startedAt) / 1000)
        });
        const kept = await settle(
          {
            state: "done",
            command,
            exitCode: 0,
            finishedAt: Date.now(),
            ms: Date.now() - startedAt,
            tail
          },
          tree ? { [CONTAINER_TREE_KEY]: tree } : undefined
        );
        // Outside the verdict: a host that cannot act on the news must not turn
        // a finished install into a failed one, which the catch below would.
        if (kept && tree?.fingerprint)
          await this.deps
            .installed({ dir: tree.dir, fingerprint: tree.fingerprint })
            .catch((err: unknown) => {
              console.warn(
                `[${this.deps.tag()}] could not act on a finished install`,
                { id: this.deps.id(), err: String(err) }
              );
            });
      } else {
        // Logged, and this line is not optional. This is the *ordinary* way an
        // install fails — the other paths are all exceptional — and it used to
        // write the record and say nothing, so an operator looking at why the
        // agent was complaining found the complaint and no cause. The tail
        // is the install's own last words; without it the only copy is inside a
        // Durable Object nobody can query.
        console.error(`[${this.deps.tag()}] install failed`, {
          id: this.deps.id(),
          command,
          exitCode: result.exitCode,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          tail: truncateOutput(tail, 1000)
        });
        await settle({
          state: "failed",
          command,
          finishedAt: Date.now(),
          exitCode: result.exitCode,
          error: `the install command exited ${result.exitCode}`,
          tail
        });
      }
    } catch (err) {
      // Superseded drains fail here constantly — replacing an exec is what
      // breaks the old handle — so this check matters more on the error path
      // than on the success one.
      if (!(await stillMine())) return;
      // The drain itself broke — the container went away mid-install, most
      // likely. Distinct from a non-zero exit above, and worth telling apart in
      // the logs, because this one says nothing about the repository.
      //
      // If it went away, nothing this isolate believes about it holds any more.
      if (execWasLost(err)) await this.deps.containerGone();
      console.error(`[${this.deps.tag()}] install drain failed`, {
        id: this.deps.id(),
        command,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        err: String(err)
      });
      await settle({
        state: "failed",
        command,
        finishedAt: Date.now(),
        error: String(err)
      });
    } finally {
      this.#owned.delete(startedAt);
      handle[Symbol.dispose]();
    }
  }

  /**
   * Pick up an install this isolate did not start.
   *
   * `getExec` with `resume: "tail"` re-opens the stream of a command that is
   * still running in the container — or replays the end of one that finished
   * while nobody was listening, which is the case that would otherwise leave the
   * record stuck at `running` and every `bash` blocked behind it.
   */
  async #reattachInstall(
    /** The running record's `startedAt`: the generation it picks up. */
    startedAt: number
  ): Promise<void> {
    if (await this.#drivenHere(startedAt)) return;
    try {
      const handle = await this.deps
        .workspace()
        .runtime.getExec(INSTALL_EXEC_ID, {
          encoding: "utf8",
          resume: "tail"
        });
      this.deps.waitUntil(this.#drainInstall(handle, startedAt));
    } catch (err) {
      // The exec is gone entirely — the container was replaced under it. Say so
      // rather than leaving the gate closed forever; the next checkout starts a
      // new install, and `bash` can run in the meantime.
      if (execWasLost(err)) await this.deps.containerGone();
      // Same split as the spawn path: a replaced container is worth re-running
      // into, a deployment fault is not, and only one of them is the container's
      // own doing.
      const fault = deploymentFault(err);
      if (fault)
        console.error(`[${this.deps.tag()}] ${fault.summary}`, {
          id: this.deps.id(),
          remedy: fault.remedy,
          err: String(err)
        });
      else
        console.warn(
          `[${this.deps.tag()}] could not re-attach to the install`,
          {
            id: this.deps.id(),
            err: String(err)
          }
        );
      const context = await this.#job.context();
      await this.#job.generation(startedAt).write({
        state: "failed",
        command: context?.command ?? "(unknown)",
        finishedAt: Date.now(),
        error: fault
          ? `the install stopped without reporting: ${fault.remedy}`
          : "the install stopped without reporting — its container was most " +
            "likely replaced. Re-run it with bash, or clone again to restart it."
      });
    }
  }

  /**
   * The armed reinstall came due.
   *
   * `clearArmed` first and unconditionally: this handler runs for minutes, and
   * the stamp left in place is what a second arming would recognise as its own.
   * The reservation in `#beginInstall` would catch a double, but the cheaper
   * answer is not to schedule one.
   */
  async onRun(): Promise<void> {
    const context = await this.#job.context();
    const armedAt = await this.#job.armedAt();
    // Owned before the arm is cleared: from then until the reservation takes it
    // over, the placeholder is a `running` record that only this call will finish.
    if (armedAt !== undefined) this.#owned.add(armedAt);
    try {
      await this.#job.clearArmed();
      if (!context?.dir || armedAt === undefined) return;

      const state = await this.#awaited(
        {
          dir: context.dir,
          ...(context.repo ? { repo: context.repo } : {})
        },
        armedAt
      );
      console.info(`[${this.deps.tag()}] armed reinstall finished`, {
        id: this.deps.id(),
        dir: context.dir,
        state: state.state
      });
    } finally {
      if (armedAt !== undefined) this.#owned.delete(armedAt);
    }
  }

  /** The watchdog: an install still running that nobody is draining. */
  async onWatch(): Promise<void> {
    const state = await this.#job.read();
    if (state.state !== "running") return;
    // Still running and nobody draining it: this isolate is new since the
    // command started. Re-attach, and come back if it is still going.
    await this.#reattachInstall(state.startedAt);
    await this.#job.armWatch();
  }
}
