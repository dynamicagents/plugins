import { DurableObject } from "cloudflare:workers";
import {
  ContainerHarness,
  containerAgent,
  type ContainerEgressBinding,
  type ContainerInstance,
  type ContainerMessage,
  type ContainerOperationResult,
  type EgressRoute
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
import {
  agentEnv,
  asAgent,
  AGENT_GID,
  AGENT_UID,
  shellQuote
} from "./agent-exec.js";
import { deriveAdvisories, type WorkspaceAdvisory } from "./advisory.js";
import { TRUST_CA_COMMAND } from "./ca-trust.js";
import {
  CONTROL_SESSION,
  CONTROL_WAKE,
  EGRESS_READY,
  RUN_DIR,
  SANDBOX_CONTRACT
} from "./constants.js";
import { isUnder, SANDBOX_ROOT } from "./header.js";
import {
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
const LAST_USED_KEY = "sandbox:last-used";

const IDLE_STOP_MS = 5 * 60_000;
/** The harness's own stop is a backstop behind {@link IDLE_STOP_MS}: its longest allowed window. */
const HARNESS_IDLE_MS = 6 * 3_600_000 - 2 * 60_000;
const EGRESS_WATCH_MS = 10_000;
const INSTALL_POLL_MS = 15_000;
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
  /** Non-secret environment for the daemon and the CLI. */
  env?: Readonly<Record<string, string>>;
  egress: {
    /** `ctx.exports.<Entrypoint>`: the consumer's entrypoint calling `sandboxEgress`. */
    binding: ContainerEgressBinding;
    /** Intercepted over HTTP by the harness at every start. */
    routes: readonly EgressRoute[];
    /** Intercepted over HTTPS by this object, once per container, with the CA trusted. */
    https?: readonly EgressRoute[];
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
  readonly #container: Container;
  readonly #harness: ContainerHarness;
  readonly #wake: ScheduledHost<WakeHandlers, Env>;
  readonly #idle;
  readonly #egressWatch;
  readonly #installPoll;
  #runtimePreparing: Promise<void> | undefined;
  #running = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#cfg = this.sandboxConfig();
    this.#container = this.containerFor(ctx);
    this.#harness = new ContainerHarness({
      container: this.#container,
      agent: containerAgent({
        image: this.#image(),
        adapter: this.#cfg.adapter,
        env: { ...this.#cfg.env },
        egress: this.#cfg.egress.routes
      }),
      egress: this.#cfg.egress.binding,
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
      created_at INTEGER NOT NULL
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
    const https = this.#cfg.egress.https ?? [];
    if (https.length > 0) {
      const fetcher = this.#cfg.egress.binding({ props: { routes: https } });
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
    await this.#rootExec([
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

  /** A command as the agent, with no capabilities. */
  async exec(
    argv: readonly string[],
    options: {
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutMs?: number;
    } = {}
  ): Promise<ExecResult> {
    await this.ensureRunning();
    return this.#run(asAgent(argv), { ...options, env: agentEnv(options.env) });
  }

  async #rootExec(argv: readonly string[]): Promise<ExecResult> {
    return this.#run(argv, {});
  }

  async #run(
    argv: readonly string[],
    options: {
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutMs?: number;
    }
  ): Promise<ExecResult> {
    this.#running += 1;
    try {
      const process = await this.#container.exec([...argv], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
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
    } finally {
      this.#running -= 1;
    }
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
    try {
      const response = await this.#files().readFile(path, {
        user: `${AGENT_UID}:${AGENT_GID}`
      });
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#files().writeFile(path, content, {
      user: `${AGENT_UID}:${AGENT_GID}`
    });
  }

  async stat(
    path: string
  ): Promise<{ type: string; size: number; modifiedAt: number } | null> {
    this.#confine(path);
    await this.ensureRunning();
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
  }

  async readDir(path: string): Promise<{ name: string; type: string }[]> {
    this.#confine(path);
    await this.ensureRunning();
    return (
      await this.#files().readDirectory(path, {
        user: `${AGENT_UID}:${AGENT_GID}`
      })
    ).map((entry) => ({ name: entry.name, type: entry.type }));
  }

  async mkdir(path: string): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#files().mkdir(path, {
      recursive: true,
      user: `${AGENT_UID}:${AGENT_GID}`
    });
  }

  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.#confine(path);
    await this.ensureRunning();
    await this.#files().remove(path, {
      force: true,
      ...(options.recursive ? { recursive: true } : {}),
      user: `${AGENT_UID}:${AGENT_GID}`
    });
  }

  // --- runs ------------------------------------------------------------------

  /**
   * The harness session a run lives in, made on first ask.
   *
   * The harness refuses a session id it did not mint, so a run's own id maps to
   * one here. A fork continues another run's conversation as a new branch of it,
   * which only works inside one object: the forked run's files are this one's.
   */
  async createRun(
    runId: string,
    options: { cwd: string; forkOf?: string }
  ): Promise<{ sessionId: string; created: boolean }> {
    this.#confine(options.cwd);
    await this.#touch();
    const existing = this.#runRow(runId);
    if (existing) return { sessionId: existing.session_id, created: false };
    let sessionId: string;
    if (options.forkOf !== undefined) {
      const from = this.#runRow(options.forkOf);
      if (!from)
        throw new Error(`no run ${options.forkOf} in this sandbox to fork`);
      sessionId = (await this.#harness.sessions.fork(from.session_id)).id;
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

  #runRow(runId: string): { session_id: string; cwd: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ session_id: string; cwd: string }>(
        "SELECT session_id, cwd FROM sandbox_runs WHERE run_id = ?",
        runId
      )
      .toArray()[0];
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
   */
  async submit(
    runId: string,
    text: string,
    operationId: string
  ): Promise<{ operationId: string; accepted: boolean }> {
    await this.ensureRunning();
    const receipt = await this.#session(runId).submit(text, { operationId });
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
   */
  async poll(
    runId: string,
    operationId: string,
    waitMs = POLL_WAIT_MS
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
    const messages: PolledMessage[] = [];
    for (const message of await session.messages()) {
      if (message.operationId !== operationId || message.role !== "assistant")
        continue;
      messages.push({
        id: message.id,
        digest: await digest(message.parts),
        message
      });
    }
    return {
      contract: SANDBOX_CONTRACT,
      ...(result ? { result } : {}),
      messages
    };
  }

  /**
   * Stop a run and let its CLI finish leaving.
   *
   * The harness settles an abort at once, while the CLI is still exiting — a
   * SIGINT, a SIGKILL a few seconds later, then one last sync of its session
   * files. Committing or stopping before that loses what it wrote last, or
   * races git's index lock. So this waits for no CLI to be left, and one sync.
   */
  async stopRun(runId: string): Promise<{ stopped: boolean }> {
    await this.#touch();
    const stopped = await this.#session(runId).abort();
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
      "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q -- '--output-format stream-json' && exit 0; done; exit 1"
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

  /** Every recorded checkout to R2, replacing its last backup. */
  async #backupAll(): Promise<void> {
    const backups = this.#backups();
    if (!backups) return;
    for (const row of this.#checkouts()) {
      const present = await this.#rootExec(["test", "-d", row.dir]);
      if (present.exitCode !== 0) continue;
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
   * snapshot — and reinstall what came back without its `node_modules`.
   */
  async #restoreMissing(): Promise<void> {
    const backups = this.#backups();
    if (!backups) return;
    for (const row of this.#checkouts()) {
      if (!row.backup) continue;
      const present = await this.#rootExec(["test", "-d", row.dir]);
      if (present.exitCode === 0) continue;
      await backups.restore(JSON.parse(row.backup) as DirectoryBackupRecord);
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

  /**
   * Back up and stop the container. Its disk is the next start, as a snapshot.
   *
   * Refused while a run is open: stopping the harness re-wakes every open
   * session, which starts the container again.
   */
  async release(): Promise<{ released: boolean; reason?: string }> {
    if ((await this.#harness.pending()).length > 0) {
      return { released: false, reason: "a run is still open" };
    }
    if (this.#container.running) {
      await this.#backupAll();
      await this.#harness.stop();
    }
    await this.#idle.clear();
    return { released: true };
  }

  async #touch(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put(LAST_USED_KEY, now);
    await this.#idle.set(
      new Date(now + (this.#cfg.idleStopMs ?? IDLE_STOP_MS))
    );
  }

  /** Stop a container nobody is using. Anything still working moves the deadline instead. */
  async #onIdle(): Promise<void> {
    const busy =
      (await this.#harness.pending()).length > 0 ||
      this.#running > 0 ||
      (await this.ctx.storage.get<InstallState>(INSTALL_KEY))?.state ===
        "running";
    if (busy) {
      await this.#idle.set(
        new Date(Date.now() + (this.#cfg.idleStopMs ?? IDLE_STOP_MS))
      );
      return;
    }
    await this.release();
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
    const present =
      this.#container.running &&
      (await this.#rootExec(["test", "-d", `${record.dir}/.git`])).exitCode ===
        0;
    return { dir: record.dir, present };
  }

  /** The newest recorded repository checkout, if its `.git` is there. */
  async checkoutDir(): Promise<string | undefined> {
    const row = this.ctx.storage.sql
      .exec<{ dir: string }>(
        "SELECT dir FROM sandbox_checkouts WHERE kind = 'repo' ORDER BY noted_at DESC LIMIT 1"
      )
      .toArray()[0];
    if (!row) return undefined;
    const present = await this.exec(["test", "-d", `${row.dir}/.git`]);
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
  async startInstall(target: {
    dir: string;
    repo?: string;
  }): Promise<InstallState> {
    this.#confine(target.dir);
    await this.ensureRunning();
    return this.#beginInstall(target);
  }

  /** The install, in a container already prepared. */
  async #beginInstall(target: {
    dir: string;
    repo?: string;
  }): Promise<InstallState> {
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
      return skipped;
    }
    const script =
      `rm -f ${RUN_DIR}/install.exit && cd ${shellQuote(target.dir)} && ` +
      `{ ${resolution.command}; } > ${RUN_DIR}/install.log 2>&1; ` +
      `echo $? > ${RUN_DIR}/install.exit`;
    await this.#container.exec(asAgent(["sh", "-c", script]), {
      env: agentEnv(),
      stdout: "ignore",
      stderr: "ignore"
    });
    const running: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt: Date.now()
    };
    await this.ctx.storage.put(INSTALL_KEY, running);
    await this.ctx.storage.put(INSTALL_ARMED_KEY, { dir: target.dir });
    await this.#installPoll.set(new Date(Date.now() + INSTALL_POLL_MS));
    return running;
  }

  async #onInstallPoll(): Promise<void> {
    const state = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
    if (state?.state !== "running") return;
    if (!this.#container.running) {
      await this.ctx.storage.put(INSTALL_KEY, {
        state: "failed",
        command: state.command,
        error: "the container stopped while it installed",
        finishedAt: Date.now()
      } satisfies InstallState);
      return;
    }
    const done = await this.#rootExec([
      "sh",
      "-c",
      `cat ${RUN_DIR}/install.exit 2>/dev/null; echo; tail -c 2000 ${RUN_DIR}/install.log 2>/dev/null`
    ]);
    const [exit = "", ...tail] = done.stdout.split("\n");
    if (exit.trim() === "") {
      await this.#installPoll.set(new Date(Date.now() + INSTALL_POLL_MS));
      return;
    }
    const exitCode = Number(exit.trim());
    const finishedAt = Date.now();
    const next: InstallState =
      exitCode === 0
        ? {
            state: "done",
            command: state.command,
            exitCode,
            finishedAt,
            ms: finishedAt - state.startedAt
          }
        : {
            state: "failed",
            command: state.command,
            exitCode,
            error: `exited ${exitCode}`,
            finishedAt,
            tail: tail.join("\n").trim()
          };
    await this.ctx.storage.put(INSTALL_KEY, next);
    // What a later start begins from, node_modules included.
    if (next.state === "done") await this.checkpoint();
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
      readFile: async (path) => {
        const read = await this.#rootExec(["cat", path]);
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
    const lastUsed = (await this.ctx.storage.get<number>(LAST_USED_KEY)) ?? 0;
    const idleMs = Date.now() - lastUsed;
    if (lastUsed === 0 || idleMs < maxIdleMs)
      return { reclaimed: false, idleMs };
    if ((await this.#harness.pending()).length > 0)
      return { reclaimed: false, idleMs };
    if (this.#container.running) await this.#container.destroy("reclaimed");
    const backups = this.#backups();
    for (const row of this.#checkouts()) {
      if (backups && row.backup) {
        await backups
          .delete(JSON.parse(row.backup) as DirectoryBackupRecord)
          .catch(() => undefined);
      }
    }
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
