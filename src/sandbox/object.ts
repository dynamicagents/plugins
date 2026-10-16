import { DurableObject } from "cloudflare:workers";
import {
  ContainerHarness,
  containerAgent,
  type ContainerEgressBinding,
  type ContainerInstance,
  type ContainerMessage,
  type ContainerOperationResult
} from "agents/harness/container";
import {
  installScheduler,
  namedDeadline,
  type ScheduledHost
} from "@dynamicagents/core/alarm";
import {
  DirectoryBackup,
  Files,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupRecord
} from "@cloudflare/sandbox";
import { asAgent, AGENT_GID, AGENT_UID, shellQuote } from "./agent-exec.js";
import { deriveAdvisories, type WorkspaceAdvisory } from "./advisory.js";
import {
  egressPlan,
  type EgressPlan,
  type SandboxEgressRule
} from "./egress.js";
import { humanMs } from "./format.js";
import { TRUST_CA_COMMAND } from "./ca-trust.js";
import {
  CONTROL_SESSION,
  CONTROL_WAKE,
  EGRESS_READY,
  RUN_DIR,
  SANDBOX_CONTRACT
} from "./constants.js";
import {
  isUnder,
  readRunHeader,
  SANDBOX_ROOT,
  withRunHeader
} from "./header.js";
import {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallPlan,
  type InstallProbe,
  type InstallState
} from "./install-plan.js";

/**
 * A Durable Object driving one container through `agents`' `ContainerHarness`.
 *
 * The checkout is the container's own disk. The object holds the durable
 * record — sessions, operations, the transcript, each CLI's resume files — and
 * dials the daemon in the container; the container never dials back. What the
 * harness does not do is closed here, from outside it, and each rule below
 * names what it closes. The approach is measured in the harness spike's
 * `RESULTS.md`; the whole contract is in this subpath's README.
 */

/** The harness's own workspace-snapshot record: read at its next start. Pinned by the contract spec. */
const HARNESS_WORKSPACE_KEY = "container-harness:workspace";

const RUNTIME_READY_KEY = "sandbox:runtime-ready";
const CHECKPOINT_KEY = "sandbox:checkpoint";
const INSTALL_KEY = "sandbox:install";
const INSTALL_ARMED_KEY = "sandbox:install-armed";
const INSTALL_QUEUE_KEY = "sandbox:install-queue";
const LAST_USED_KEY = "sandbox:last-used";

const IDLE_STOP_MS = 5 * 60_000;
/** The harness's own stop is a backstop behind {@link IDLE_STOP_MS}: its longest allowed window. */
const HARNESS_IDLE_MS = 6 * 3_600_000 - 2 * 60_000;
const EGRESS_WATCH_MS = 10_000;
const INSTALL_POLL_MS = 15_000;
/** Past its deadline by this much with no exit written, an install was killed before it could write one. */
const INSTALL_GRACE_MS = 60_000;
/**
 * One marker per checkout whose files are on this disk, on the root filesystem
 * a snapshot keeps. A directory proves nothing: `/workspace` is in every image.
 */
const CHECKOUT_MARKS = "/var/lib/da/checkouts";
/**
 * Per checkout, the fingerprint its last finished install was for, on the
 * same disk as its `node_modules`: it goes with that disk into a snapshot, and
 * into another sandbox seeded from one.
 */
const INSTALL_MARKS = "/var/lib/da/installs";
/** The harness sends SIGKILL this long after SIGINT, then syncs once more. */
const CLI_KILL_MS = 5_000;
const CLI_SYNC_MS = 5_000;
const POLL_WAIT_MS = 20_000;

export interface SandboxObjectConfig {
  /** Log prefix. */
  label: string;
  /** The adapter the daemon in {@link image} serves CLI sessions with. */
  adapter: string;
  /** The image to start: a key of `ctx.container.images`. Default `app`. */
  image?: string;
  instance: ContainerInstance;
  /**
   * Non-secret environment for every command the agent runs — an `exec`, an
   * install, a CLI turn — under its own. No key a rule's `env` sets.
   */
  env?: Readonly<Record<string, string>>;
  egress: {
    /** `ctx.exports.<Entrypoint>`: the consumer's entrypoint, calling `sandboxEgress` with {@link rules}. */
    entrypoint: ContainerEgressBinding;
    /** The `env` binding this class is reached by, so a rule's handler can reach the sandbox a request came from. */
    self: string;
    /** What the container may reach, each declared by the plugin that needs it (`./egress.ts`). */
    rules: readonly SandboxEgressRule[];
  };
  installPlan: InstallPlan;
  /** Where checkouts are backed up before every stop. Without it an image change loses unpushed work. */
  backups?: {
    binding: string;
    prefix?: string;
    gateway: DirectoryBackupGatewayBinding;
  };
  /** How long after its last use a container is backed up and stopped. */
  idleStopMs?: number;
  /** An `env` binding whose value unlocks {@link SandboxObjectBase.debug}. Absent: no debug RPC. */
  debugSecretBinding?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CheckoutRecord {
  dir: string;
  kind: "repo" | "scratch";
  repo?: string;
}

/** A run's messages as of one poll, each with a digest that changes when the message does. */
export interface PolledMessage {
  id: string;
  digest: string;
  message: ContainerMessage;
}

export interface PollResult {
  contract: number;
  /** Set once the operation settled. */
  result?: ContainerOperationResult;
  messages: PolledMessage[];
  /** The `from` that skips every message sent so far. */
  next: number;
}

export interface SnapshotSeed {
  key: string;
  snapshot: { id: string };
}

type WakeHandlers = {
  sandboxIdle: () => Promise<void>;
  egressWatch: () => Promise<void>;
  installPoll: () => Promise<void>;
};

export abstract class SandboxObjectBase<
  Env extends object = Cloudflare.Env
> extends DurableObject<Env> {
  protected abstract sandboxConfig(): SandboxObjectConfig;

  /** The object's container. A seam so specs can hand in a fake one. */
  protected containerFor(ctx: DurableObjectState): Container {
    if (!ctx.container) {
      throw new Error(
        "this object has no container: give its class a `containers` entry"
      );
    }
    return ctx.container;
  }

  readonly #cfg: SandboxObjectConfig;
  readonly #egress: EgressPlan;
  readonly #container: Container;
  readonly #harness: ContainerHarness;
  readonly #wake: ScheduledHost<WakeHandlers, Env>;
  readonly #idle;
  readonly #egressWatch;
  readonly #installPoll;
  #runtimePreparing: Promise<void> | undefined;
  /** Commands, file calls and submissions under way: each holds the container up. */
  #running = 0;
  /** A stop under way. Work that would start the container waits it out. */
  #stopping: Promise<unknown> | undefined;
  /** Reclaimed: its storage is gone, and this instance is about to be. */
  #gone = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#cfg = this.sandboxConfig();
    this.#egress = egressPlan(
      this.#cfg.egress.rules,
      ctx.id.name === undefined
        ? undefined
        : `${this.#cfg.egress.self}/${ctx.id.name}`
    );
    const clash = Object.keys(this.#cfg.env ?? {}).filter((key) =>
      Object.hasOwn(this.#egress.env, key)
    );
    if (clash.length > 0)
      throw new Error(
        `[${this.#cfg.label}] env sets ${clash.join(", ")}, which an egress rule sets`
      );
    this.#container = this.containerFor(ctx);
    this.#harness = new ContainerHarness({
      container: this.#container,
      agent: containerAgent({
        image: this.#image(),
        adapter: this.#cfg.adapter,
        // The daemon's environment, which each CLI turn inherits.
        env: { ...this.#cfg.env, ...this.#egress.env },
        egress: [...this.#egress.http]
      }),
      egress: this.#cfg.egress.entrypoint,
      instance: this.#cfg.instance,
      idleTimeoutMs: HARNESS_IDLE_MS,
      onContainerLost: "fail"
    });
    this.#wake = installScheduler<WakeHandlers, Env>(this, {
      callbacks: {
        sandboxIdle: () => this.#onIdle(),
        egressWatch: () => this.#onEgressWatch(),
        installPoll: () => this.#onInstallPoll()
      },
      onError: (err: unknown) => {
        console.error(
          `[${this.#cfg.label}] a scheduled callback failed for good`,
          {
            id: this.ctx.id.toString(),
            err: String(err)
          }
        );
      }
    });
    this.#wake.lifecycle.use(this.#harness);
    const deadline = (key: string, callback: keyof WakeHandlers) =>
      namedDeadline({
        storage: this.ctx.storage,
        scheduler: this.#wake.scheduler,
        key,
        callback
      });
    this.#idle = deadline("sandbox:idle-id", "sandboxIdle");
    this.#egressWatch = deadline("sandbox:egress-watch-id", "egressWatch");
    this.#installPoll = deadline("sandbox:install-poll-id", "installPoll");
    /**
     * Started here rather than on first use. A request that wakes a fresh
     * instance and reaches the container without starting the harness's
     * lifecycle leaves it with no inactivity timeout — `onStart` is what re-arms
     * it — and it stops within seconds of the object going quiet (observed). An
     * egress lease or a pool read wakes the object exactly like that.
     */
    void ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
      await this.#wake.start();
    });
  }

  #image(): string {
    const key = this.#cfg.image ?? "app";
    const image = this.#container.images[key];
    if (!image) throw new Error(`[${this.#cfg.label}] no image named ${key}`);
    return image;
  }

  /** What the harness keys its workspace snapshot on, for a custom image. */
  #snapshotKey(): string {
    return `image:${this.#image()}`;
  }

  #migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS sandbox_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      stopped_at INTEGER
    )`);
    // Which run submitted each operation: runs that share a session share its
    // operations, and a stop is one run's.
    sql.exec(`CREATE TABLE IF NOT EXISTS sandbox_operations (
      operation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sandbox_checkouts (
      dir TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      repo TEXT,
      backup TEXT,
      noted_at INTEGER NOT NULL
    )`);
  }

  // --- the container ---------------------------------------------------------

  /**
   * The container, running and ready for a command or a CLI turn.
   *
   * A stopped one is started by a `control:wake` prompt on the root session,
   * which the daemon answers without a CLI: the harness starts containers only
   * for a prompt. Then, once per container, the egress the harness does not
   * register, and any checkout an image change left behind.
   */
  async ensureRunning(): Promise<{ runtimeId: string }> {
    await this.#touch();
    if (!this.#container.running) {
      const woke = await this.#harness
        .session(CONTROL_SESSION)
        .prompt(CONTROL_WAKE);
      if (woke.status !== "done") {
        throw new Error(
          `[${this.#cfg.label}] the container did not start: ${woke.reason ?? "no reason given"}`
        );
      }
    }
    const runtimeId = await this.#prepareRuntime();
    return { runtimeId };
  }

  /** What only a new container needs, done once per runtime id. */
  async #prepareRuntime(): Promise<string> {
    const { runtimeId } = await this.#harness.container();
    if (!runtimeId)
      throw new Error(
        `[${this.#cfg.label}] the harness has no container on record`
      );
    if ((await this.ctx.storage.get<string>(RUNTIME_READY_KEY)) === runtimeId)
      return runtimeId;
    this.#runtimePreparing ??= this.#prepare(runtimeId).finally(() => {
      this.#runtimePreparing = undefined;
    });
    await this.#runtimePreparing;
    return runtimeId;
  }

  async #prepare(runtimeId: string): Promise<void> {
    const container = this.#container;
    await this.#rootExec([
      "sh",
      "-c",
      `mkdir -p ${RUN_DIR} && chown ${AGENT_UID}:${AGENT_GID} ${RUN_DIR}`
    ]);
    const https = this.#egress.https;
    if (https.length > 0) {
      const fetcher = this.#cfg.egress.entrypoint({
        props: { routes: [...https] }
      });
      for (const route of https)
        await container.interceptOutboundHttps(route.host, fetcher);
      const trust = await this.#rootExec(["sh", "-c", TRUST_CA_COMMAND]);
      if (!/^TRUSTED$/m.test(trust.stdout)) {
        throw new Error(
          `[${this.#cfg.label}] the interception CA was not trusted: ${trust.stdout.trim()}`
        );
      }
    }
    await this.#restoreMissing();
    // As the agent, whose directory it is: a write as root would follow a
    // symlink the agent left there. A marker the agent forges only starts its
    // own CLI early.
    await this.#agentExec([
      "sh",
      "-c",
      `printf %s ${shellQuote(runtimeId)} > ${EGRESS_READY}`
    ]);
    await this.ctx.storage.put(RUNTIME_READY_KEY, runtimeId);
  }

  /**
   * The harness starts containers on its own too — a follow-up after a lost one,
   * a snapshot retry — and nothing here is told. While a run is open, this looks
   * again every few seconds, so a CLI waiting on {@link EGRESS_READY} is not
   * left to its timeout.
   */
  async #onEgressWatch(): Promise<void> {
    if ((await this.#harness.pending()).length === 0) return;
    if (this.#container.running)
      await this.#prepareRuntime().catch((err: unknown) => {
        console.warn(`[${this.#cfg.label}] could not prepare a new container`, {
          id: this.ctx.id.toString(),
          err: String(err)
        });
      });
    await this.#egressWatch.set(new Date(Date.now() + EGRESS_WATCH_MS));
  }

  /** A command as the agent, with no capabilities: the host's `env`, its own over that, and every egress rule's over both. */
  async exec(
    argv: readonly string[],
    options: {
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutMs?: number;
    } = {}
  ): Promise<ExecResult> {
    await this.ensureRunning();
    return this.#run(
      asAgent(argv, {
        ...this.#cfg.env,
        ...options.env,
        ...this.#egress.env
      }),
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
      }
    );
  }

  /** `work`, counted as running, so no stop starts under it. */
  async #hold<T>(work: () => Promise<T>): Promise<T> {
    this.#running += 1;
    try {
      return await work();
    } finally {
      this.#running -= 1;
    }
  }

  /** Wait out a stop in progress. */
  async #admit(): Promise<void> {
    while (this.#stopping) await this.#stopping.catch(() => undefined);
    if (this.#gone)
      throw new Error(
        `[${this.#cfg.label}] this sandbox was just reclaimed: call it again`
      );
  }

  /**
   * `stop`, with no other stop beside it and new work held until it is done.
   * The check-then-set has no `await` between, so two cannot both pass.
   */
  async #exclusive<T>(stop: () => Promise<T>): Promise<T> {
    while (this.#stopping) await this.#stopping.catch(() => undefined);
    const run = stop();
    this.#stopping = run;
    try {
      return await run;
    } finally {
      if (this.#stopping === run) this.#stopping = undefined;
    }
  }

  /** Why the container may not stop now, if it may not. */
  async #busy(): Promise<string | undefined> {
    if ((await this.#harness.pending()).length > 0)
      return "a run is still open";
    if (this.#running > 0) return "a command is still running";
    const install = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
    if (install?.state === "running") return "an install is still running";
    return undefined;
  }

  async #rootExec(argv: readonly string[]): Promise<ExecResult> {
    return this.#run(argv, {});
  }

  /**
   * As the agent, in a container already running. Anything that reads or
   * writes a path the agent controls goes through here, never as root.
   */
  async #agentExec(argv: readonly string[]): Promise<ExecResult> {
    return this.#run(asAgent(argv), {});
  }

  /**
   * `argv` as the container's exec starts it, which is as root. No environment
   * is passed here: an agent's travels in its argv, after the drop
   * (`./agent-exec.ts`).
   */
  async #run(
    argv: readonly string[],
    options: { cwd?: string; timeoutMs?: number }
  ): Promise<ExecResult> {
    return this.#hold(async () => {
      const process = await this.#container.exec([...argv], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs
          ? { signal: AbortSignal.timeout(options.timeoutMs) }
          : {}),
        stdout: "pipe",
        stderr: "pipe"
      });
      const output = await process.output();
      const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
      return {
        exitCode: output.exitCode,
        stdout: decode(output.stdout),
        stderr: decode(output.stderr)
      };
    });
  }

  // --- files -----------------------------------------------------------------

  #files(): Files {
    return new Files(this.#container);
  }

  #confine(path: string): string {
    if (!isUnder(path, SANDBOX_ROOT)) {
      throw new Error(
        `${path} is outside ${SANDBOX_ROOT}, which is all a sandbox serves`
      );
    }
    return path;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    this.#confine(path);
    await this.ensureRunning();
    return this.#hold(async () => {
      try {
        const response = await this.#files().readFile(path, {
          user: `${AGENT_UID}:${AGENT_GID}`
        });
        return new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#hold(() =>
      this.#files().writeFile(path, content, {
        user: `${AGENT_UID}:${AGENT_GID}`
      })
    );
  }

  async stat(
    path: string
  ): Promise<{ type: string; size: number; modifiedAt: number } | null> {
    this.#confine(path);
    await this.ensureRunning();
    return this.#hold(async () => {
      try {
        const stat = await this.#files().stat(path, {
          user: `${AGENT_UID}:${AGENT_GID}`
        });
        return {
          type: stat.type,
          size: Number(stat.size),
          modifiedAt: stat.modifiedAt.getTime()
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  }

  async readDir(path: string): Promise<{ name: string; type: string }[]> {
    this.#confine(path);
    await this.ensureRunning();
    return this.#hold(async () =>
      (
        await this.#files().readDirectory(path, {
          user: `${AGENT_UID}:${AGENT_GID}`
        })
      ).map((entry) => ({ name: entry.name, type: entry.type }))
    );
  }

  async mkdir(path: string): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#hold(() =>
      this.#files().mkdir(path, {
        recursive: true,
        user: `${AGENT_UID}:${AGENT_GID}`
      })
    );
  }

  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#hold(() =>
      this.#files().remove(path, {
        force: true,
        ...(options.recursive ? { recursive: true } : {}),
        user: `${AGENT_UID}:${AGENT_GID}`
      })
    );
  }

  // --- runs ------------------------------------------------------------------

  /**
   * The harness session a run lives in, made on first ask.
   *
   * The harness refuses a session id it did not mint, so a run's own id maps to
   * one here. A run may instead carry on another run's conversation: `continues`
   * shares its session, and `forkOf` branches a new one from it. Either only
   * works inside one object, since the conversation's files are this one's, and
   * only in the same `cwd`, since the CLI files a conversation by directory.
   */
  async createRun(
    runId: string,
    options: { cwd: string; forkOf?: string; continues?: string }
  ): Promise<{ sessionId: string; created: boolean }> {
    this.#confine(options.cwd);
    await this.#touch();
    const existing = this.#runRow(runId);
    if (existing) return { sessionId: existing.session_id, created: false };
    if (options.forkOf !== undefined && options.continues !== undefined)
      throw new Error(
        "a run either continues another run or forks it, not both"
      );
    const of = options.forkOf ?? options.continues;
    let sessionId: string;
    if (of !== undefined) {
      const from = this.#runRow(of);
      if (!from) throw new Error(`no run ${of} in this sandbox to carry on`);
      if (from.cwd !== options.cwd)
        throw new Error(
          `run ${of} worked in ${from.cwd}, so a run carrying it on cannot work in ${options.cwd}`
        );
      sessionId =
        options.forkOf !== undefined
          ? (await this.#harness.sessions.fork(from.session_id)).id
          : from.session_id;
    } else {
      sessionId = (await this.#harness.sessions.create()).id;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO sandbox_runs (run_id, session_id, cwd, created_at) VALUES (?, ?, ?, ?)",
      runId,
      sessionId,
      options.cwd,
      Date.now()
    );
    return { sessionId, created: true };
  }

  #runRow(
    runId: string
  ):
    { session_id: string; cwd: string; stopped_at: number | null } | undefined {
    return this.ctx.storage.sql
      .exec<{ session_id: string; cwd: string; stopped_at: number | null }>(
        "SELECT session_id, cwd, stopped_at FROM sandbox_runs WHERE run_id = ?",
        runId
      )
      .toArray()[0];
  }

  /** Record `operationId` as `runId`'s, before it is submitted; refuse one another run submitted. */
  #own(runId: string, operationId: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO sandbox_operations (operation_id, run_id) VALUES (?, ?)",
      operationId,
      runId
    );
    const owner = sql
      .exec<{ run_id: string }>(
        "SELECT run_id FROM sandbox_operations WHERE operation_id = ?",
        operationId
      )
      .one().run_id;
    if (owner !== runId)
      throw new Error(
        `operation ${operationId} is run ${owner}'s, so run ${runId} cannot submit it`
      );
  }

  /** Refuse a turn of a run that was stopped: it takes no more. */
  #refuseStopped(runId: string): void {
    if (this.#runRow(runId)?.stopped_at != null)
      throw new Error(`run ${runId} was stopped, so it takes no more turns`);
  }

  #session(runId: string) {
    const row = this.#runRow(runId);
    if (!row) throw new Error(`no run ${runId} in this sandbox`);
    return this.#harness.session(row.session_id);
  }

  /**
   * Durably submit one turn of a run. `operationId` is the caller's, so a
   * retried submit is the same operation; a settled one comes back as it ended,
   * which is why a caller resubmitting after a lost container uses a new one.
   *
   * Every turn runs in the run's `cwd`: a turn with no run header gets one, and
   * a header naming another directory is refused.
   *
   * A stopped run takes no turn, checked before and after the turn is queued:
   * a submission still starting the container when its run is stopped would
   * otherwise start a CLI after the stop, with nobody left polling it.
   */
  async submit(
    runId: string,
    text: string,
    operationId: string
  ): Promise<{ operationId: string; accepted: boolean }> {
    const row = this.#runRow(runId);
    if (!row) throw new Error(`no run ${runId} in this sandbox`);
    const { header, prompt } = readRunHeader(text);
    if (header && header.cwd !== row.cwd) {
      throw new Error(
        `run ${runId} works in ${row.cwd}, so a turn of it cannot run in ${header.cwd}`
      );
    }
    const turn = header ? text : withRunHeader({ cwd: row.cwd }, prompt);
    this.#refuseStopped(runId);
    this.#own(runId, operationId);
    await this.ensureRunning();
    this.#refuseStopped(runId);
    const session = this.#harness.session(row.session_id);
    const receipt = await this.#hold(() =>
      session.submit(turn, { operationId })
    );
    if (this.#runRow(runId)?.stopped_at != null) {
      await session.abort(receipt.operationId);
      throw new Error(`run ${runId} was stopped, so it takes no more turns`);
    }
    await this.#egressWatch.set(new Date(Date.now() + EGRESS_WATCH_MS));
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  /**
   * One operation's state, waiting up to `waitMs` for it to settle.
   *
   * Only stored messages reach here: the harness keeps a run's messages and
   * nothing it streamed live. Those of this operation only, so a forked run does
   * not report its parent's history, each with a digest, because a message is
   * replaced in place as its tool calls finish.
   *
   * `from` skips that many of them, so a long run is not sent whole on every
   * poll; pass the last poll's `next`. A message replaced behind `from` is not
   * sent again, so a caller passes it only for an adapter that never replaces
   * one.
   */
  async poll(
    runId: string,
    operationId: string,
    waitMs = POLL_WAIT_MS,
    from = 0
  ): Promise<PollResult> {
    await this.#touch();
    const session = this.#session(runId);
    let result: ContainerOperationResult | undefined;
    try {
      result = await session.wait(
        operationId,
        AbortSignal.timeout(Math.min(waitMs, POLL_WAIT_MS))
      );
    } catch (err) {
      if (!isAbort(err)) throw err;
    }
    if (!result && this.#container.running)
      await this.#prepareRuntime().catch(() => undefined);
    const own = (await session.messages()).filter(
      (message) =>
        message.operationId === operationId && message.role === "assistant"
    );
    const messages: PolledMessage[] = [];
    for (const message of own.slice(from)) {
      messages.push({
        id: message.id,
        digest: await digest(message.parts),
        message
      });
    }
    return {
      contract: SANDBOX_CONTRACT,
      ...(result ? { result } : {}),
      messages,
      next: Math.max(from, own.length)
    };
  }

  /**
   * Stop a run and let its CLI finish leaving.
   *
   * The harness settles an abort at once, while the CLI is still exiting — a
   * SIGINT, a SIGKILL a few seconds later, then one last sync of its session
   * files. Committing or stopping before that loses what it wrote last, or
   * races git's index lock. So this waits for no CLI to be left, and one sync.
   *
   * A stopped run takes no more turns. Its conversation goes on, if it does, in
   * a run that `continues` it — whose operations share the session, so only
   * this run's own are aborted.
   */
  async stopRun(runId: string): Promise<{ stopped: boolean }> {
    await this.#touch();
    const row = this.#runRow(runId);
    if (!row) throw new Error(`no run ${runId} in this sandbox`);
    const sql = this.ctx.storage.sql;
    // Marked first, so a submission of it still on its way in refuses itself.
    sql.exec(
      "UPDATE sandbox_runs SET stopped_at = ? WHERE run_id = ? AND stopped_at IS NULL",
      Date.now(),
      runId
    );
    const own = new Set(
      sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM sandbox_operations WHERE run_id = ?",
          runId
        )
        .toArray()
        .map((each) => each.operation_id)
    );
    const session = this.#harness.session(row.session_id);
    let stopped = false;
    for (const open of await this.#harness.pending({
      session: row.session_id
    })) {
      if (own.has(open.operationId))
        stopped = (await session.abort(open.operationId)) || stopped;
    }
    if (this.#container.running) {
      const until = Date.now() + CLI_KILL_MS + 10_000;
      while (Date.now() < until && (await this.#cliAlive())) await sleep(500);
      await sleep(CLI_SYNC_MS);
    }
    return { stopped };
  }

  async #cliAlive(): Promise<boolean> {
    const probe = await this.#rootExec([
      "sh",
      "-c",
      // `[n]` so the pattern does not match this probe's own command line.
      "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q -- '--output-format stream-jso[n]' && exit 0; done; exit 1"
    ]);
    return probe.exitCode === 0;
  }

  // --- snapshots and backups ---------------------------------------------------

  /**
   * Snapshot the container now, as the start the harness will make next.
   *
   * The harness snapshots only when it stops a container, so one that dies mid-run
   * starts from whatever it last stopped as. Writing its record is what makes a
   * checkpoint the next start; the contract spec pins that it reads it.
   */
  async checkpoint(): Promise<SnapshotSeed | undefined> {
    if (!this.#container.running) return undefined;
    const snapshot = await this.#container.snapshotContainer({
      name: `checkpoint-${Date.now()}`
    });
    const seed: SnapshotSeed = {
      key: this.#snapshotKey(),
      snapshot: { id: snapshot.id }
    };
    await this.ctx.storage.put(HARNESS_WORKSPACE_KEY, {
      ...seed,
      usedAt: Date.now()
    });
    await this.ctx.storage.put(CHECKPOINT_KEY, seed);
    return seed;
  }

  /** The last checkpoint, for another sandbox of this class to start from. */
  async snapshotRecord(): Promise<SnapshotSeed | undefined> {
    return this.ctx.storage.get<SnapshotSeed>(CHECKPOINT_KEY);
  }

  /**
   * Start this sandbox's next container from another's checkpoint.
   *
   * Refused while it runs — the record is read at a start — and for a snapshot
   * of another image, which a container cannot start from.
   */
  async seedFrom(
    seed: SnapshotSeed
  ): Promise<{ seeded: boolean; reason?: string }> {
    await this.#touch();
    if (this.#container.running)
      return { seeded: false, reason: "the container is running" };
    if (seed.key !== this.#snapshotKey()) {
      return { seeded: false, reason: "the snapshot is of another image" };
    }
    await this.ctx.storage.put(HARNESS_WORKSPACE_KEY, {
      ...seed,
      usedAt: Date.now()
    });
    return { seeded: true };
  }

  #backups(): DirectoryBackup | undefined {
    const backups = this.#cfg.backups;
    if (!backups) return undefined;
    return new DirectoryBackup(this.#container, backups.gateway, {
      binding: backups.binding,
      ...(backups.prefix ? { prefix: backups.prefix } : {})
    });
  }

  /**
   * Every checkout on this disk to R2, replacing its last backup. Only a marked
   * one: an unmarked directory is the image's, and backing it up would replace
   * the checkout's last backup with nothing.
   */
  async #backupAll(): Promise<void> {
    const backups = this.#backups();
    if (!backups) return;
    for (const row of this.#checkouts()) {
      if (!(await this.#marked(row.dir))) continue;
      const record = await backups.backup({
        dir: row.dir,
        exclude: ["**/node_modules"]
      });
      this.ctx.storage.sql.exec(
        "UPDATE sandbox_checkouts SET backup = ? WHERE dir = ?",
        JSON.stringify(record),
        row.dir
      );
      if (row.backup) {
        await backups
          .delete(JSON.parse(row.backup) as DirectoryBackupRecord)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Bring back any recorded checkout a start lost — an image change drops the
   * snapshot, markers with it — and reinstall what came back without its
   * `node_modules`.
   */
  async #restoreMissing(): Promise<void> {
    const backups = this.#backups();
    if (!backups) return;
    for (const row of this.#checkouts()) {
      if (!row.backup || (await this.#marked(row.dir))) continue;
      await backups.restore(JSON.parse(row.backup) as DirectoryBackupRecord);
      await this.#mark(row.dir);
      console.info(`[${this.#cfg.label}] restored a checkout from its backup`, {
        id: this.ctx.id.toString(),
        dir: row.dir
      });
      if (row.kind === "repo") {
        await this.#beginInstall({
          dir: row.dir,
          ...(row.repo ? { repo: row.repo } : {})
        });
      }
    }
  }

  #mark(dir: string): Promise<ExecResult> {
    return this.#rootExec([
      "sh",
      "-c",
      `mkdir -p ${CHECKOUT_MARKS} && printf %s ${shellQuote(dir)} > ${shellQuote(markOf(dir))}`
    ]);
  }

  async #marked(dir: string): Promise<boolean> {
    return (await this.#rootExec(["test", "-f", markOf(dir)])).exitCode === 0;
  }

  /**
   * The fingerprint `dir`'s last finished install was for, while its
   * `node_modules` is there. Asked as the agent, who can read the mark and
   * not write it: `node_modules` is the agent's, and may be a symlink.
   */
  async #installedAs(dir: string): Promise<string | undefined> {
    const read = await this.#agentExec([
      "sh",
      "-c",
      `test -d ${shellQuote(`${dir}/node_modules`)} && cat ${shellQuote(installMarkOf(dir))}`
    ]);
    return read.exitCode === 0 ? read.stdout.trim() : undefined;
  }

  /**
   * Back up and stop the container. Its disk is the next start, as a snapshot.
   *
   * Refused while anything is working — an open run, a command, an install:
   * stopping the harness re-wakes every open session, which starts the
   * container again. Work that arrives meanwhile waits for the stop, then
   * starts a new container.
   */
  async release(): Promise<{ released: boolean; reason?: string }> {
    return this.#exclusive(async () => {
      const busy = await this.#busy();
      if (busy) return { released: false, reason: busy };
      if (this.#container.running) {
        await this.#backupAll();
        await this.#harness.stop();
      }
      await this.#idle.clear();
      return { released: true };
    });
  }

  /** Mark a use — after any stop, so a reclaim cannot erase what this call writes. */
  async #touch(): Promise<void> {
    await this.#admit();
    const now = Date.now();
    await this.ctx.storage.put(LAST_USED_KEY, now);
    await this.#idle.set(
      new Date(now + (this.#cfg.idleStopMs ?? IDLE_STOP_MS))
    );
  }

  /** Stop a container nobody is using. Anything still working moves the deadline instead. */
  async #onIdle(): Promise<void> {
    const released = await this.release();
    if (!released.released) {
      await this.#idle.set(
        new Date(Date.now() + (this.#cfg.idleStopMs ?? IDLE_STOP_MS))
      );
    }
  }

  // --- checkouts and the install -------------------------------------------------

  async noteCheckout(
    record: CheckoutRecord
  ): Promise<{ dir: string; present: boolean }> {
    this.#confine(record.dir);
    this.ctx.storage.sql.exec(
      `INSERT INTO sandbox_checkouts (dir, kind, repo, noted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(dir) DO UPDATE SET kind = excluded.kind, repo = excluded.repo, noted_at = excluded.noted_at`,
      record.dir,
      record.kind,
      record.repo ?? null,
      Date.now()
    );
    // Noted once it exists, so the mark is what says this disk holds it.
    const present =
      this.#container.running &&
      (await this.#rootExec(["test", "-d", record.dir])).exitCode === 0;
    if (present) await this.#mark(record.dir);
    return { dir: record.dir, present };
  }

  /**
   * The newest recorded checkout, a repository's or a scratchpad's. Starts no
   * container and marks no use, so a sweep asking every sandbox does not keep
   * them alive: a stopped one answers from its record, since a start restores
   * what its disk lost, and a running one only if its `.git` is there.
   */
  async checkoutDir(): Promise<string | undefined> {
    const row = this.ctx.storage.sql
      .exec<{ dir: string }>(
        "SELECT dir FROM sandbox_checkouts ORDER BY noted_at DESC LIMIT 1"
      )
      .toArray()[0];
    if (!row) return undefined;
    if (!this.#container.running) return row.dir;
    const present = await this.#agentExec(["test", "-d", `${row.dir}/.git`]);
    return present.exitCode === 0 ? row.dir : undefined;
  }

  #checkouts(): {
    dir: string;
    kind: string;
    repo: string | null;
    backup: string | null;
  }[] {
    return this.ctx.storage.sql
      .exec<{
        dir: string;
        kind: string;
        repo: string | null;
        backup: string | null;
      }>("SELECT dir, kind, repo, backup FROM sandbox_checkouts")
      .toArray();
  }

  /**
   * Install a checkout's dependencies, in the background.
   *
   * The command runs detached in the container and writes its exit code to a
   * file, which the alarm reads: a container process outlives the request that
   * started it, and the file outlives the object that is waiting for it.
   */
  async startInstall(target: InstallTarget): Promise<InstallState> {
    this.#confine(target.dir);
    await this.ensureRunning();
    return this.#beginInstall(target);
  }

  /**
   * The install, in a container already prepared. One at a time: package
   * managers in one tree race, and the checkpoint after the last must not
   * catch another still writing. A second checkout waits its turn.
   */
  async #beginInstall(target: InstallTarget): Promise<InstallState> {
    const current = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
    if (current?.state === "running") {
      const armed = await this.ctx.storage.get<ArmedInstall>(INSTALL_ARMED_KEY);
      const queue =
        (await this.ctx.storage.get<InstallTarget[]>(INSTALL_QUEUE_KEY)) ?? [];
      if (
        armed?.dir !== target.dir &&
        !queue.some((queued) => queued.dir === target.dir)
      )
        await this.ctx.storage.put(INSTALL_QUEUE_KEY, [...queue, target]);
      return current;
    }
    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      target.dir,
      this.#cfg.installPlan,
      target.repo
    );
    if (resolution.kind === "skip") {
      const skipped: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      await this.ctx.storage.put(INSTALL_KEY, skipped);
      await this.#nextInstall(false);
      return skipped;
    }
    // What this disk already holds needs no install: a fetch that moved no
    // dependency, or a tree a seed brought.
    const fingerprint = await installFingerprint(probe, target.dir, resolution);
    if (
      fingerprint !== null &&
      (await this.#installedAs(target.dir)) === fingerprint
    ) {
      const now = Date.now();
      const current: InstallState = {
        state: "done",
        command: resolution.command,
        exitCode: 0,
        finishedAt: now,
        ms: 0
      };
      await this.ctx.storage.put(INSTALL_KEY, current);
      await this.#nextInstall(false);
      return current;
    }
    // Unmarked while it runs, so an install cut short leaves no tree that
    // passes for a finished one.
    await this.#rootExec(["rm", "-f", installMarkOf(target.dir)]);
    const timeoutMs =
      this.#cfg.installPlan.timeoutMs ?? DEFAULT_INSTALL_PLAN.timeoutMs!;
    const job = `${Date.now().toString(36)}`;
    const { exit, log } = installFiles(job);
    // `timeout` ends a hung install; the deadline below settles one whose shell
    // was killed before it could write its exit.
    const script =
      `cd ${shellQuote(target.dir)} && ` +
      `{ timeout --kill-after=10 ${Math.ceil(timeoutMs / 1000)} sh -c ${shellQuote(resolution.command)}; } > ${log} 2>&1; ` +
      `echo $? > ${exit}`;
    // The host's environment and no rule's: an install reaches what it reaches
    // anonymously, as it would anywhere else.
    await this.#container.exec(asAgent(["sh", "-c", script], this.#cfg.env), {
      stdout: "ignore",
      stderr: "ignore"
    });
    const running: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt: Date.now()
    };
    await this.ctx.storage.put(INSTALL_KEY, running);
    await this.ctx.storage.put(INSTALL_ARMED_KEY, {
      ...target,
      job,
      fingerprint,
      limitMs: timeoutMs,
      runtimeId: (await this.#harness.container()).runtimeId ?? ""
    } satisfies ArmedInstall);
    await this.#installPoll.set(new Date(Date.now() + INSTALL_POLL_MS));
    return running;
  }

  /** Start the next queued install, or — the queue empty after a good one — checkpoint. */
  async #nextInstall(succeeded: boolean): Promise<void> {
    const [next, ...rest] =
      (await this.ctx.storage.get<InstallTarget[]>(INSTALL_QUEUE_KEY)) ?? [];
    if (next) {
      await this.ctx.storage.put(INSTALL_QUEUE_KEY, rest);
      await this.#beginInstall(next);
      return;
    }
    // What a later start begins from, node_modules included.
    if (succeeded) await this.checkpoint();
  }

  async #onInstallPoll(): Promise<void> {
    const state = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
    if (state?.state !== "running") return;
    const armed = await this.ctx.storage.get<ArmedInstall>(INSTALL_ARMED_KEY);
    const fail = async (error: string, tail?: string) => {
      await this.ctx.storage.put(INSTALL_KEY, {
        state: "failed",
        command: state.command,
        error,
        finishedAt: Date.now(),
        ...(tail ? { tail } : {})
      } satisfies InstallState);
      // The container is gone, and the queue with it: a new one restores and
      // installs again from its own start.
      if (!this.#container.running) {
        await this.ctx.storage.delete(INSTALL_QUEUE_KEY);
        return;
      }
      await this.#nextInstall(false);
    };
    if (!this.#container.running || !armed) {
      await fail("the container stopped while it installed");
      return;
    }
    // Another container is not running it: the disk it was writing is gone
    // with the one that was, so it runs again here.
    if ((await this.#harness.container()).runtimeId !== armed.runtimeId) {
      await this.ctx.storage.put(INSTALL_KEY, {
        state: "failed",
        command: state.command,
        error: "the container it ran in was replaced",
        finishedAt: Date.now()
      } satisfies InstallState);
      await this.#beginInstall({
        dir: armed.dir,
        ...(armed.repo ? { repo: armed.repo } : {})
      });
      return;
    }
    const { exit: exitFile, log } = installFiles(armed.job);
    // As the agent: the files are in its directory, and a root read would
    // follow a symlink it left there into a file only root may read.
    const done = await this.#agentExec([
      "sh",
      "-c",
      `cat ${exitFile} 2>/dev/null; echo; tail -c 2000 ${log} 2>/dev/null`
    ]);
    const [exit = "", ...tail] = done.stdout.split("\n");
    if (exit.trim() === "") {
      if (Date.now() > state.startedAt + armed.limitMs + INSTALL_GRACE_MS) {
        await fail(
          "the install was killed before it could report how it ended",
          tail.join("\n").trim()
        );
        return;
      }
      await this.#installPoll.set(new Date(Date.now() + INSTALL_POLL_MS));
      return;
    }
    const exitCode = Number(exit.trim());
    const finishedAt = Date.now();
    if (exitCode !== 0) {
      await fail(
        exitCode === 124
          ? `ran past its limit of ${humanMs(armed.limitMs)}`
          : `exited ${exitCode}`,
        tail.join("\n").trim()
      );
      return;
    }
    if (armed.fingerprint) {
      await this.#rootExec([
        "sh",
        "-c",
        `mkdir -p ${INSTALL_MARKS} && printf %s ${shellQuote(armed.fingerprint)} > ${shellQuote(installMarkOf(armed.dir))}`
      ]);
    }
    await this.ctx.storage.put(INSTALL_KEY, {
      state: "done",
      command: state.command,
      exitCode,
      finishedAt,
      ms: finishedAt - state.startedAt
    } satisfies InstallState);
    await this.#nextInstall(true);
  }

  async advisories(): Promise<readonly WorkspaceAdvisory[]> {
    const install = (await this.ctx.storage.get<InstallState>(INSTALL_KEY)) ?? {
      state: "idle"
    };
    const armed = await this.ctx.storage.get<{ dir: string }>(
      INSTALL_ARMED_KEY
    );
    const treePresent =
      armed !== undefined &&
      this.#container.running &&
      (await this.#rootExec(["test", "-d", `${armed.dir}/node_modules`]))
        .exitCode === 0;
    return deriveAdvisories({ install, dependencyTreePresent: treePresent });
  }

  #probe(): InstallProbe {
    return {
      exists: async (path) =>
        (await this.#rootExec(["test", "-e", path])).exitCode === 0,
      // As the agent: a checkout's files are its own, and may be symlinks.
      readFile: async (path) => {
        const read = await this.#agentExec(["cat", path]);
        if (read.exitCode !== 0)
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return read.stdout;
      }
    };
  }

  // --- reclaim and debug ---------------------------------------------------------

  /** Empty a sandbox nobody has used in `maxIdleMs`: backups, storage and all. */
  async reclaimIfIdle(
    maxIdleMs: number
  ): Promise<{ reclaimed: boolean; idleMs: number }> {
    return this.#exclusive(() => this.#reclaim(maxIdleMs));
  }

  async #reclaim(
    maxIdleMs: number
  ): Promise<{ reclaimed: boolean; idleMs: number }> {
    const lastUsed = (await this.ctx.storage.get<number>(LAST_USED_KEY)) ?? 0;
    const idleMs = Date.now() - lastUsed;
    if (lastUsed === 0 || idleMs < maxIdleMs)
      return { reclaimed: false, idleMs };
    // Last use is when work began, so what is still working is asked directly.
    if (await this.#busy()) return { reclaimed: false, idleMs };
    if (this.#container.running) await this.#container.destroy("reclaimed");
    const backups = this.#backups();
    for (const row of this.#checkouts()) {
      if (backups && row.backup) {
        await backups
          .delete(JSON.parse(row.backup) as DirectoryBackupRecord)
          .catch(() => undefined);
      }
    }
    this.#gone = true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // After the reply: this instance still holds the state just deleted.
    setTimeout(() => this.ctx.abort("sandbox reclaimed"), 0);
    return { reclaimed: true, idleMs };
  }

  /** For acceptance runs only, behind a secret: reset this object, destroy its container, or run as root. */
  async debug(
    secret: string,
    op:
      | { kind: "reset" }
      | { kind: "destroy" }
      | { kind: "root-exec"; argv: string[] }
  ): Promise<ExecResult | { ok: true }> {
    const binding = this.#cfg.debugSecretBinding;
    const expected = binding
      ? (this.env as Record<string, unknown>)[binding]
      : undefined;
    if (
      typeof expected !== "string" ||
      expected === "" ||
      secret !== expected
    ) {
      throw new Error("debug is not enabled for this sandbox");
    }
    switch (op.kind) {
      case "reset":
        setTimeout(() => this.ctx.abort("debug reset"), 0);
        return { ok: true };
      case "destroy":
        await this.#container.destroy("debug destroy");
        return { ok: true };
      case "root-exec":
        return this.#rootExec(op.argv);
    }
  }
}

interface InstallTarget {
  dir: string;
  repo?: string;
}

/** The running install: its checkout, the job its files are named for, its limit, and the container it runs in. */
interface ArmedInstall extends InstallTarget {
  job: string;
  /** What the install is for: written to {@link INSTALL_MARKS} once it succeeds. */
  fingerprint: string | null;
  limitMs: number;
  runtimeId: string;
}

function installFiles(job: string): { exit: string; log: string } {
  return {
    exit: `${RUN_DIR}/install-${job}.exit`,
    log: `${RUN_DIR}/install-${job}.log`
  };
}

function markOf(dir: string): string {
  return `${CHECKOUT_MARKS}/${encodeURIComponent(dir)}`;
}

function installMarkOf(dir: string): string {
  return `${INSTALL_MARKS}/${encodeURIComponent(dir)}`;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /abort/i.test(err.message))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
