import { DurableObject, tracing } from "cloudflare:workers";
// One Durable Object has one alarm, and this object wakes for more reasons than
// that. A `Scheduler` is the multiplexer; what it does *not* own is what this
// object owes on waking, which is the callbacks registered on it below.
import {
  installScheduler,
  namedDeadline,
  type ScheduledHost
} from "./alarm/index.js";
import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceEgressPolicy,
  type WorkspaceOptions,
  type WorkspaceStub
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import { createGitClient } from "@cloudflare/computer/git";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import { ContainerTrust } from "./ca-trust.js";
import { ContainerDeps } from "./container-deps.js";
import { ContainerGitIdentity } from "./git-identity.js";
import { InstallJob } from "./install-job.js";
import type { WorkspaceWakeHandlers } from "./wake.js";
import { WorkspaceGitHost } from "./git-host.js";
import {
  SYNC_DRAIN_BUDGET_MS,
  SYNC_DRAIN_RESUME_MS,
  WorkspaceSync,
  syncRetryDelayMs,
  type SyncDrainIntent
} from "./sync.js";
// Leaf modules rather than `../index.js` — see the same import in
// {@link file://./install-job.ts} for why the barrel is not reachable from here.
import { deriveAdvisories, type WorkspaceAdvisory } from "../advisory.js";
import { pathExists } from "../read.js";
import type { InstallPlan, InstallState } from "../install.js";
// The shape `/repo` already defines for exactly this: a git failure is data,
// because it means git answered. A throw on this path means the object was
// unreachable, which is a different thing and must stay distinguishable.
import type { RepoGitResult } from "../../repo/index.js";

/**
 * A workspace: one Durable Object, one container, one repository.
 *
 * **Shared by every agent in a Worker that has a container.** Each subclasses
 * {@link WorkspaceObjectBase}, supplies a {@link WorkspaceObjectConfig}, and
 * inherits everything else. Keep that seam narrow: it is the complete answer to
 * "what is different about this agent's container", and anything that does not
 * fit through it becomes a second copy of this file.
 *
 * A directory inside the plugin rather than a subpath beside it, so that one
 * capability stays one import path and a consumer cannot take the tools without
 * the object they address. The bundle cost of that is nothing: `sideEffects` is
 * false, so an agent that only calls `bash` carries no container backend and
 * no isomorphic-git.
 *
 * What this file must not do is import the plugin barrel. The barrel re-exports
 * this module, and the class below is built at import time — a cycle would
 * evaluate its base as `undefined`. The imports above reach the leaf modules
 * beside it instead.
 *
 * `@cloudflare/computer` pairs a SQLite-backed virtual filesystem in *this*
 * object's storage with a container running `computerd`, which mounts it over
 * FUSE at `/workspace`. Commands run against the same tree the Worker reads over
 * RPC, and the tree outlives the container.
 *
 * **One repository per object**, because `computer` is strictly 1 DO ↔ 1
 * container: the id derives from caller *and* repository (see `workspaceName`),
 * so two repositories for one caller are two objects and two containers.
 *
 * **It constructs `Workspace` rather than using `withWorkspace`.** The mixin
 * stores the `Workspace` under a module-private symbol the package does not
 * export, so a method on the object cannot reach it — and what the host is
 * required to do needs exactly that: driving an outstanding pull (the library
 * owns no alarm and schedules nothing of its own), and the direct `runtime`
 * access the detached install needs. So this object owns the `Workspace` and
 * implements the one method the mixin otherwise provides,
 * `__getWorkspaceStub`. Callers outside see no difference.
 *
 * ## What is here, and what is a module next door
 *
 * This file is the Durable Object: the wake map, the deadlines, the RPC surface
 * and the wiring between them. The work each of those drives has its own home,
 * and each carries the reasoning for its own decisions:
 *
 * - `./install-job.ts` — when a dependency install runs, and every guard on it.
 * - `./sync.ts` — the host's half of syncing, which nothing else will do.
 * - `./ca-trust.ts` — making a container able to speak TLS.
 * - `./git-identity.ts` — who a container's commits belong to.
 * - `./git-host.ts` — the operations that hold the forge credential.
 *
 * Each takes a small explicit seam, and that is the test: a module that needed
 * the whole object back would be a module that did not want extracting.
 */

/** Where every checkout lives, inside the container and in the VFS. */
export const WORKSPACE_DIR = "/workspace";

/**
 * The Durable Object name for one caller's checkout of one repository.
 *
 * Exported because several places must agree on it and none can see the others:
 * the plugin that resolves the stub, the agent that hands it down to sub-agents,
 * and the cancellation path. A pipe rather than a slash, so the caller half
 * cannot forge a repository boundary by containing one.
 *
 * `repo` is undefined only before the first `repo_clone` or `scratch_open` of a
 * session — what a task works in is model-chosen, so there is genuinely nothing
 * to key on until it has chosen. That window resolves to a caller-level
 * workspace, which is never worked in: `beforeCheckout` sets the repository
 * before any git runs, and `scratch_open` sets its sentinel before anything
 * resolves a name.
 *
 * `repo` is not always a repository. A host may pass a sentinel through here as
 * one — a scratchpad is modelled that way, which is what keys it to its own
 * object and its own container. Anything that is not a forge name works, as long
 * as no caller could clone something that collides with it.
 */
export function workspaceName(callerKey: string, repo?: string): string {
  return repo ? `${callerKey}|${repo}` : `${callerKey}|<unassigned>`;
}

// --- where the work is ------------------------------------------------------

/**
 * The key the checkout record lives under.
 *
 * Deliberately **not** the install record's: what is on disk and what was
 * installed into it have different lifetimes, and one record cannot answer both.
 * See {@link WorkspaceObjectBase.noteCheckout}.
 */
const CHECKOUT_KEY = "checkout";

/**
 * What is checked out here, recorded by whoever put it there.
 *
 * `kind` is the one field worth arguing for. A scratchpad and a clone are the
 * same shape on disk — a directory with a `.git` in it — and every reader of this
 * record wants the same answer from both. What differs is what may be *said*
 * about them: a scratchpad has no remote, so "nothing was pushed" is a fact
 * rather than a failure. `repo` being absent for one would make that inferrable,
 * but an identity inferred from a missing field is a second meaning for a field
 * that already has one.
 */
interface CheckoutRecord {
  dir: string;
  /** `owner/repo`, absent for a scratchpad. */
  repo?: string;
  kind: "repo" | "scratch";
  at: number;
}

// --- what this object wakes for, and when ----------------------------------

/**
 * Where the idle-reclaim deadline keeps its current schedule id.
 *
 * A schedule is a row the scheduler mints an id for, not a keyed upsert — so
 * "push this deadline back", which `#touch()` does on every single call into
 * this object, is cancel-then-set and needs the id of what stands now. See
 * `namedDeadline`.
 */
const IDLE_RECLAIM_ID = "idle-reclaim-id";

/**
 * How long a workspace survives without being used.
 *
 * A Durable Object is **never** reclaimed by the platform, and a namespace
 * cannot be enumerated from a Worker, so nothing else is coming to clean up.
 * Source-only workspaces are small (6.3 MB for slack-gatekeeper), which makes
 * this hygiene rather than cost control — but unbounded hygiene is still
 * unbounded.
 *
 * Exported because a host keeping work in a workspace has to say how long that
 * work survives untouched.
 */
export const IDLE_RECLAIM_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the container-idle deadline keeps its current schedule id. */
const CONTAINER_IDLE_ID = "container-idle-id";

/** Where the container-warm wake keeps its current schedule id. */
const CONTAINER_WARM_ID = "container-warm-id";

/**
 * How long a container stays up after the last command **started**.
 *
 * Ours to schedule: `withWorkspaceContainer` wraps the runtime's raw
 * `ctx.container`, not `@cloudflare/containers`' `Container`, so there is no
 * `sleepAfter` to lean on.
 *
 * **This must exceed the longest command the agent allows**, and breaking that
 * kills work in flight. Measured from when a command *starts*: `#touch()` arms
 * the clock on the way into this object, and a running command touches nothing
 * again until it finishes — `handle.result()` is one long await and the FUSE
 * traffic under it never surfaces as an RPC. Set equal to the computer plugin's
 * `DEFAULT_TIMEOUT_MS`, the two timers race and whichever fires first destroys
 * the container the other depends on. Twenty minutes is double that ceiling;
 * raise it, never lower it, if `bash` is given a longer timeout.
 *
 * **The default, not the policy.** "Longest command" is a fact about the agent,
 * so one whose commands run longer must say so via
 * {@link WorkspaceObjectConfig.containerIdleMs} — `claude-coder` holds a
 * `claude -p` session open for its whole 40-minute timeout.
 */
const CONTAINER_IDLE_MS = 20 * 60_000;

/**
 * Refuse to grow past this, of the 10 GB a Durable Object may hold.
 *
 * Source-only workspaces run at ~6 MB, so this should never fire — which is why
 * it is worth having: if something does start pulling a large tree in, a
 * sentence naming the number beats a write failing somewhere unrelated.
 */
const STORAGE_CAP_BYTES = 8 * 1024 * 1024 * 1024;

/** Where the pending-pull drain keeps its current schedule id. */
const SYNC_DRAIN_ID = "sync-drain-id";

/**
 * How long a container may be kept alive past its idle deadline so an
 * outstanding pull can finish.
 *
 * The deadline defers while a drain is still moving blocks, because destroying
 * the container is what makes unpulled work unrecoverable. It cannot defer
 * forever — a pull that never completes would keep a container billing
 * indefinitely — so this is the wall on that, measured from the last use.
 */
const SYNC_DRAIN_GRACE_MS = 30 * 60_000;

/**
 * How long a container start may take before the calls waiting on it are refused.
 *
 * Late, because refusing a start that was only slow clears `#readying` while it
 * runs, and the next caller starts a second one beside it — and a start pushing
 * a large tree has taken nine minutes. Not later, because a turn is cut at
 * fifteen: past that the model reads no reason, and its next turn joins the
 * same stuck start.
 */
const READY_DEADLINE_MS = 9 * 60_000;

/**
 * `work`, refused once `ms` pass without it settling. The work itself goes on;
 * only the wait for it ends — see {@link READY_DEADLINE_MS}.
 */
export function readyWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `the workspace container did not become ready within ${ms / 1000}s; the next call starts it again`
          )
        ),
      ms
    );
  });
  // The loser still settles, and a rejection nobody holds fails the request.
  work.catch(() => {});
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Set once the synced dependency trees are gone from this object's storage —
 * see {@link WorkspaceObjectBase.#purgeSyncedTrees}.
 */
const SYNCED_TREES_PURGED_KEY = "deps:purged";

// --- the object -------------------------------------------------------------

/**
 * Named rather than the anonymous class expression an app would write here.
 *
 * This package emits declarations, and `DurableObject` brings `ctx` and `env` in
 * protected — which makes the mixin's return type unnameable in a `.d.ts` and
 * fails the build with TS4094. A named base gives the emitted type something to
 * refer to. It costs one identifier and is invisible to a consumer.
 */
class WorkspaceContainerHost extends DurableObject<Cloudflare.Env> {}

/**
 * `withWorkspaceContainer` adds one method, `getWorkspaceContainer()`, over
 * `this.ctx.container` — the runtime's own container handle. There is no
 * `@cloudflare/containers` `Container` subclass here and so no `sleepAfter`:
 * idle shutdown is this object's job, and it lands on the wake map with
 * everything else.
 */
const WorkspaceContainerBase = withWorkspaceContainer(WorkspaceContainerHost);

/**
 * The forge credential, and who a commit made on this side is attributed to.
 *
 * Config rather than an env read, because this class cannot name a consumer's
 * ambient `Env` — it is an interface `wrangler types` generates into *their*
 * app, and a plugin that named it would compile only against the one Worker that
 * happened to spell its bindings that way.
 *
 * It is also the honest direction. These are the repo plugin's secrets, declared
 * by that plugin's `requires.secrets`, and a workspace holds them only because
 * git runs on this side of the container boundary — see
 * {@link file://./git-host.ts} for why it has to.
 */
export interface WorkspaceGitConfig {
  /**
   * The **name** of the binding holding the forge credential — never the
   * credential itself.
   *
   * `workspaceConfig()` is an ordinary method on the prototype, and on a Durable
   * Object `protected` is a typechecker's opinion rather than a runtime
   * boundary: anything holding the namespace can call it. A config carrying the
   * token would therefore hand it to any caller that asked — exactly what
   * {@link file://./git-host.ts} exists to prevent, since the credential is
   * supposed to be unreachable from anywhere but the moment git authenticates.
   *
   * So the config names the binding and the object reads it. Naming a secret by
   * string is what the plugin contract's `requires.secrets` already does, and it
   * is the only form available here: this package cannot name a consumer's
   * ambient `Env`.
   *
   * An unset binding reads `undefined`, which means an unauthenticated request
   * rather than a throw — that is what lets a workspace with no token still
   * clone a public repository.
   */
  tokenBinding: string;
  /**
   * Who a commit is attributed to — on this side, and in the container.
   *
   * Two things read it: this object's git client, and `./git-identity.ts`,
   * which writes it into the container's system config so a repository the
   * container made for itself is attributed rather than nameless.
   *
   * **The repo plugin is not one of them.** It resolves `RepoConfig.author`
   * independently, with a generic fallback of its own, and nothing in either
   * package checks the two agree — so a commit *can* be attributed differently
   * depending on which side made it, and the only thing preventing that is a
   * consumer answering both from one place. A deployment's fallback for an
   * unset binding belongs where that binding is read; this takes the resolved
   * answer.
   */
  author: { name: string; email: string };
}

/**
 * What one workspace object does not share with the next.
 *
 * Everything else about a workspace is identical between agents, which is why
 * this interface is short and why it is worth having at all: a seam this narrow
 * makes "what is different about this agent's container" a question with a
 * complete answer in one place.
 */
export interface WorkspaceObjectConfig {
  /**
   * The wrangler Durable Object binding this class is bound as.
   *
   * Not cosmetic and not derivable: `computerd` dials **back** through it. The
   * backend builds the container's loopback from this name plus the object id,
   * so a wrong one produces a container that starts, mounts nothing and fails
   * at the first command with no mention of a binding.
   */
  binding: string;
  /**
   * Where this workspace's container may send traffic, and through what.
   *
   * `direct` is the plain behaviour: the container's own network position.
   * `http-gateway` routes **everything** through a `Fetcher` this Worker
   * supplies, which is what puts the Worker on the model path — see
   * `@dynamicagents/plugins/claude-code`.
   *
   * **Required in practice, and its absence is silent.** It is a policy that
   * defaults to `{ mode: "none" }`, and the backend derives the container's
   * network flag from it. Omit it and the container
   * comes up with no network at all: the workspace mounts, commands run, and
   * the install dies on a registry it cannot reach with nothing naming egress
   * as the cause.
   */
  egress: WorkspaceEgressPolicy;
  /** How this deployment installs dependencies for this agent's checkouts. */
  installPlan: InstallPlan;
  /** Log prefix — `coder-workspace`, `claude-coder-workspace`. */
  label: string;
  /**
   * How long this agent's container stays up after the last command **started**.
   *
   * A per-agent value because the invariant on {@link CONTAINER_IDLE_MS} — it
   * must exceed the longest command the shell allows — is an invariant about the
   * *agent*, and the two differ by a factor of four. The coder's longest command
   * is a tool call; `claude-coder`'s is a whole `claude -p` session that runs
   * detached for its entire timeout.
   *
   * Omit it for the default. Raise it, never lower it, and raise it whenever the
   * agent's longest command grows.
   */
  containerIdleMs?: number;
  /** The forge credential and commit identity — see {@link WorkspaceGitConfig}. */
  git: WorkspaceGitConfig;
}

/**
 * One caller's checkout of one repository, and the container that mounts it.
 *
 * Abstract because a Durable Object class takes no constructor arguments, so
 * per-agent configuration cannot arrive that way. {@link workspaceConfig} is the
 * seam, for the same reason Think's own hooks are methods rather than options.
 *
 * ## Why `backend` and `#workspace` are lazy
 *
 * **Base class fields run before subclass fields**, so as plain fields they
 * would read `undefined` from any `workspaceConfig()` that touches a subclass
 * field — which `ClaudeCoderWorkspaceDO`'s does, for its credential store.
 * Memoised getters remove the hazard rather than documenting it, which is what
 * lets a subclass implement the seam however it likes.
 */
export abstract class WorkspaceObjectBase<
  TEnv extends Cloudflare.Env = Cloudflare.Env
> extends WorkspaceContainerBase {
  /**
   * This Worker's bindings, as the host's own generated `Env` spells them.
   *
   * Re-declared rather than inherited so a subclass reading a binding of its own
   * — `claude-coder`'s reaches for its credential pool — gets its real type
   * instead of the base's. `declare` because the field is the runtime's; this
   * only narrows what TypeScript believes about it.
   */
  declare readonly env: TEnv;

  /**
   * Everything this agent's workspace does differently. Called once, lazily.
   *
   * Read through {@link #cfg}, never directly: an implementation may build
   * something real — `claude-coder`'s constructs its egress gateway — and this
   * is consulted on the busiest path in the object.
   */
  protected abstract workspaceConfig(): WorkspaceObjectConfig;

  #configMemo?: WorkspaceObjectConfig;

  get #cfg(): WorkspaceObjectConfig {
    return (this.#configMemo ??= this.workspaceConfig());
  }

  /** This object's log prefix, so one workspace stays tellable from another. */
  get #tag(): string {
    return this.#cfg.label;
  }

  /** This agent's container-idle window — see {@link WorkspaceObjectConfig}. */
  get #containerIdleMs(): number {
    return this.#cfg.containerIdleMs ?? CONTAINER_IDLE_MS;
  }

  /**
   * How long an install may run before it is killed.
   *
   * A getter because the fallback has to be the same number at every site an
   * install is bounded, and a `??` repeated at each is a chance to write a
   * different one.
   */
  get #installTimeoutMs(): number {
    return this.#cfg.installPlan.timeoutMs ?? 20 * 60_000;
  }

  /**
   * The one alarm, multiplexed across every reason this object wakes.
   *
   * A callback is registered under a **name**, and a schedule row persists that
   * name rather than a closure: the object is re-created on every wake, so
   * anything captured here would not survive one. Registration therefore happens
   * unconditionally, in a field initializer, every time.
   *
   * `hostOwns` is the acknowledgement that this class defines `alarm()` and
   * `fetch()` itself. A lifecycle installs its handlers only where the host has
   * none, so without saying so here the scheduler would be installed and never
   * fire, with no error anywhere. `alarm()` below calls through, which is what
   * makes the declaration true. **`fetch()` deliberately does not** — it serves
   * `computerd`'s capnweb WebSocket upgrade, and a lifecycle's `fetch` declines
   * any upgrade no installed capability claims.
   */
  readonly #wake: ScheduledHost<WorkspaceWakeHandlers, Cloudflare.Env> =
    installScheduler<WorkspaceWakeHandlers>(this, {
      hostOwns: ["alarm", "fetch"],
      callbacks: {
        installRun: () => this.#install.onRun(),
        installWatch: () => this.#install.onWatch(),
        idleReclaim: () => this.#onIdleReclaim(),
        containerIdle: (payload) => this.#onContainerIdle(payload),
        containerWarm: () => this.#onContainerWarm(),
        syncRetry: (payload?: SyncDrainIntent) => this.#onSyncDrain(payload)
      },
      onError: (err: unknown) => {
        console.error(`[${this.#tag}] a scheduled callback failed for good`, {
          id: this.ctx.id.toString(),
          err: String(err)
        });
      }
    });

  /** Reclaim a workspace nobody has touched. Moved forward by every `#touch`. */
  readonly #idleReclaim = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: IDLE_RECLAIM_ID,
    callback: "idleReclaim"
  });

  /** Stop a container nobody is using. Moved forward by every `#touch`. */
  readonly #containerIdle = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: CONTAINER_IDLE_ID,
    callback: "containerIdle"
  });

  /**
   * Start a cold container in the background — see {@link #warmIfCold}.
   *
   * A deadline rather than a bare `scheduler.set`, for the reason {@link #touch}
   * gives: armed per tool call, so anything that did not cancel the row standing
   * would leave one per call.
   */
  readonly #containerWarm = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: CONTAINER_WARM_ID,
    callback: "containerWarm"
  });

  /**
   * Come back and move the next block of an outstanding pull.
   *
   * **The callback name is on disk in deployed objects, so it may not change.**
   * A schedule row persists its callback by name, and the scheduler drops a row
   * whose callback it cannot find with one line in the log — a rename would
   * strand every pull already scheduled.
   */
  readonly #syncDrain = namedDeadline({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    key: SYNC_DRAIN_ID,
    callback: "syncRetry"
  });

  /**
   * The dependency install — see `./install-job.ts`, which owns every guard on it.
   *
   * The seam is what only this object can answer: where its storage and its
   * scheduler are, what the workspace is, and the entry-point bookkeeping an
   * install still owes on the way in.
   */
  readonly #install: InstallJob = new InstallJob({
    storage: this.ctx.storage,
    scheduler: this.#wake.scheduler,
    workspace: () => this.#workspace,
    plan: () => this.#cfg.installPlan,
    timeoutMs: () => this.#installTimeoutMs,
    headroom: () => this.#storageHeadroom(),
    touch: () => this.#touch(),
    ready: () => this.#ready(),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    containerGone: () => this.#containerGone(),
    tag: () => this.#tag,
    id: () => this.ctx.id.toString()
  });

  /**
   * The forge credential, read at the moment it would be handed over.
   *
   * `#`-private, which is the only spelling actually unreachable over RPC — see
   * {@link WorkspaceGitConfig.tokenBinding} for why that matters here and not
   * for the rest of the config.
   *
   * Indexed rather than named: the subclass says which binding holds it, because
   * this package cannot name a consumer's `Env`.
   */
  #token(): string | undefined {
    const env = this.env as unknown as Record<string, string | undefined>;
    return env[this.#cfg.git.tokenBinding];
  }

  /** Clone, fetch and push, with the credential — see `./git-host.ts`. */
  readonly #gitHost = new WorkspaceGitHost({
    git: () => this.#workspace.git,
    token: () => this.#token(),
    tag: () => this.#tag
  });

  /** The host's half of syncing — see `./sync.ts`. */
  readonly #sync = new WorkspaceSync({
    workspace: () => this.#workspace,
    containerRunning: () => this.ctx.container?.running === true,
    deadline: () => this.#syncDrain,
    tag: () => this.#tag,
    id: () => this.ctx.id.toString()
  });

  /**
   * The container backend.
   *
   * `container: () => this` hands the backend this object's own container.
   * `workspace` is how `computerd` dials *back* in: the runtime builds a loopback
   * binding from the exported `WorkspaceProxy` class and the values below, which
   * is why the consuming Worker's entry point must re-export `WorkspaceProxy`
   * and why dropping that export breaks the container with no compile error.
   *
   * Nothing sets `egressHost`; the default `computer.internal` is the host the
   * container's outbound HTTP is intercepted on, internal to that loopback.
   *
   * The binding name and the egress policy are the subclass's — see
   * {@link WorkspaceObjectConfig}, which carries the warnings on both.
   */
  #backendMemo?: CloudflareContainerBackend;

  get backend(): CloudflareContainerBackend {
    return (this.#backendMemo ??= new CloudflareContainerBackend({
      container: () => this,
      workspace: {
        binding: this.#cfg.binding,
        id: this.ctx.id.toString()
      },
      egress: this.#cfg.egress
    }));
  }

  #workspaceMemo?: Workspace;

  get #workspace(): Workspace {
    return (this.#workspaceMemo ??= new Workspace(this.#workspaceOptions()));
  }

  /**
   * The container's TLS trust, which `#ready` below keeps current.
   *
   * See `./ca-trust.ts` for why the answer lives in memory and what clears it.
   */
  readonly #trust = new ContainerTrust({
    workspace: () => this.#workspace,
    container: () => this.ctx.container,
    tag: () => this.#tag,
    id: () => this.ctx.id.toString(),
    onExit: () => void this.#containerGone()
  });

  /**
   * The identity every repository in the container starts out attributed to.
   *
   * See `./git-identity.ts` for why the container needs one of its own when
   * `/repo` already configures the checkouts it clones.
   */
  readonly #gitIdentity = new ContainerGitIdentity({
    workspace: () => this.#workspace,
    author: () => this.#cfg.git.author,
    tag: () => this.#tag,
    id: () => this.ctx.id.toString()
  });

  /** Where installs write — see `./container-deps.ts`. */
  readonly #deps = new ContainerDeps({
    workspace: () => this.#workspace,
    workspaceDir: WORKSPACE_DIR,
    tag: () => this.#tag,
    id: () => this.ctx.id.toString()
  });

  /** Everything believed about a container, dropped when it goes. */
  async #containerGone(): Promise<void> {
    this.#trust.forget();
    this.#gitIdentity.forget();
    this.#deps.forget();
    await this.#install.containerGone();
  }

  /**
   * Set once {@link reclaimIfIdle} has emptied storage, until the alarm it armed
   * resets the isolate. Anything reaching this instance in between is addressing
   * storage that is gone.
   */
  #reclaimed = false;

  /**
   * The start already in flight, shared by everyone who asks for one.
   *
   * In memory, like {@link file://./ca-trust.ts}'s flag and for the same reason:
   * it describes a container, and an isolate that lost it asks again.
   */
  #readying?: Promise<void>;

  /**
   * Open the workspace, and make sure the container behind it can speak TLS and
   * installs onto its own disk.
   *
   * **Every path that might start a container goes through here**, and the CA
   * install hangs off container *liveness* rather than off the install job.
   * Whether a container is new and whether it is due dependencies are different
   * questions: an install declines to arm for a `skipped` or `idle` state,
   * returns early when one is already in flight, and again when the workspace is
   * full — so hanging trust off it leaves a replaced container talking to an
   * untrusted CA with nothing pending that would fix it, and leaves it worst
   * exactly when egress is what the agent needs to dig itself out.
   *
   * `ctx.container?.running` is read **before** `ready()`, because `ready()` is
   * what starts a stopped container — afterwards every container looks running
   * and the distinction is gone.
   *
   * Cheap enough to sit on the busiest entry point in the object: at most one
   * extra exec per isolate, plus one per container it sees start. An unchanged
   * container costs a boolean.
   *
   * Private, like everything else in here that is not an RPC: every non-`#`
   * method is reachable over RPC — see {@link WorkspaceGitConfig.tokenBinding}.
   *
   * **One start at a time**, because {@link #warmIfCold} makes overlap ordinary:
   * a warm and the first `bash` want the container at the same moment, as do
   * a warm and the install alarm. Two starts means two trust commands through a
   * half-established connection, the second pushing the tree again behind the
   * first. Cleared on settle, so the next caller asks about the container that
   * is there now — and on {@link READY_DEADLINE_MS}, so a start that hangs holds
   * its callers for that long and no longer.
   */
  async #ready(): Promise<void> {
    this.#readying ??= readyWithin(this.#readyNow(), READY_DEADLINE_MS).finally(
      () => {
        this.#readying = undefined;
      }
    );
    return this.#readying;
  }

  /** One start, run for whoever got there first — see {@link #ready}. */
  async #readyNow(): Promise<void> {
    // Read **before** `ready()`, which starts a stopped container.
    if (!this.ctx.container?.running) await this.#containerGone();
    await this.#workspace.ready();
    // Before the first exec, which pushes the whole tree into a new container.
    await this.#purgeSyncedTrees();
    await this.#trust.ensure();
    await this.#gitIdentity.ensure();
    const found = await this.#deps.ensure(await this.#install.dir());
    if (found) await this.#install.reconcile(found.marker);
  }

  /**
   * Delete every `node_modules` that was synced into this object, once.
   *
   * Left in place, each is pushed into every new container — where the bind
   * mount hides it but computerd still holds it in memory.
   */
  async #purgeSyncedTrees(): Promise<void> {
    if (await this.ctx.storage.get(SYNCED_TREES_PURGED_KEY)) return;
    const startedAt = Date.now();
    const fs = this.#workspace.fs;
    try {
      const trees = await fs
        .find(WORKSPACE_DIR, "**/node_modules", {
          exclude: ["**/.git", "**/node_modules/*"]
        })
        // No workspace directory yet, so nothing was ever synced.
        .catch((err: { code?: string }) => {
          if (err?.code === "ENOENT") return [];
          throw err;
        });
      for (const tree of trees) {
        if (tree.type === "dir") await fs.rm(tree.path, { recursive: true });
      }
      await this.ctx.storage.put(SYNCED_TREES_PURGED_KEY, Date.now());
      if (trees.length > 0)
        console.info(`[${this.#tag}] purged synced dependency trees`, {
          id: this.ctx.id.toString(),
          trees: trees.map((t) => t.path),
          ms: Date.now() - startedAt
        });
    } catch (err) {
      // Left unmarked, so the next start tries again; a command must not fail
      // for it.
      console.warn(`[${this.#tag}] could not purge synced dependency trees`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  #workspaceOptions(): WorkspaceOptions {
    return {
      // `ctx.storage.sql.exec` returns a narrower row type than
      // `DurableObjectStorageLike` declares and the two are invariant, so the
      // cast goes through `unknown`. The runtime shapes match; this is the
      // pattern the package's own example uses.
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.backend],
      // One line per committed sync block and one per finished operation, into
      // the same Workers Observability view as the spans below — blocks,
      // entries, bytes, and the CPU headroom each block left.
      //
      // **It covers the syncs this object drives, not the ones a command drives
      // for itself.** `pull()` and `push()` log; the push a `runtime.exec` does
      // before it spawns — the expensive one, since a fresh container takes the
      // whole tree — logs nothing. Its cost shows up as a `workspace.sync.push`
      // span, and on `ca-trust.ts`'s line.
      syncTelemetryEnabled: true,
      // One span per sync push, sync pull, exec spawn and filesystem op, into
      // the same Workers Observability view the rest of this Worker traces to.
      // Needs `observability.traces.enabled` in wrangler.jsonc; without the
      // feature flag `tracing` is undefined and this degrades to a no-op.
      observer: createCloudflareObserver({ tracing }),
      // Git, running **here** rather than in the container.
      //
      // This is what lets the forge token stay on this side of the boundary.
      // `createGitClient` binds isomorphic-git to `provider()` — the local
      // SQLite store, not the wire — so a clone, fetch or push executes next to
      // the data it writes, and the container never holds a credential at all.
      // Credentialed `git` in the container cannot: it executes whatever
      // `.git/config` and `.git/hooks` in the checkout name.
      //
      // Needs `@platformatic/vfs`, an optional peer of `@cloudflare/computer`:
      // the adapter that wraps `provider()` into an isomorphic-git FsClient
      // imports it lazily and throws a named error when it is absent.
      git: createGitClient(),
      // Only the commit-producing subcommands read this, and the three
      // operations driven from here — clone, fetch, push — are not among them.
      // Set anyway so that a `pull` or `merge` added later fails on the merge
      // itself rather than on `MissingIdentityError`, and set to the same pair
      // `/repo` writes into the checkout's own config at clone time (see
      // `author` in each agent's `plugins.ts`), so a commit cannot be
      // attributed differently depending on which side made it.
      defaultGitIdentity: this.#cfg.git.author
    };
  }

  /**
   * Repair a lost alarm on the way in.
   *
   * The one failure a scheduler cannot defend against from the inside: the
   * runtime retries a throwing `alarm()` a bounded number of times and then
   * stops for good, and a deleted-class migration takes the alarm with the
   * storage. Both leave schedule rows due with nothing coming for them, and the
   * symptom is silence.
   *
   * So every RPC into this object checks. That fully covers the sync drain,
   * `install-watch` and `container-idle`, which only matter while somebody is
   * using the workspace. It does **not** cover `idle-reclaim`, which by
   * definition fires when nobody is — that one has the agent's weekly cron
   * poking `reclaimIfIdle` as its backstop.
   */
  async #repairAlarm(): Promise<void> {
    try {
      await this.#wake.start();
      await this.#wake.rearm();
    } catch (err) {
      console.error(`[${this.#tag}] could not repair the alarm`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * What `getWorkspace(stub)` calls from outside this object.
   *
   * The one piece of `withWorkspace` reimplemented here — see the file comment
   * for why the mixin is not used. `ready()` first, because the stub is only
   * meaningful once the workspace has opened its store.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    // The busiest entry point by far, and therefore the one that keeps both the
    // idle clock and the alarm honest.
    await this.#touch();
    await this.#repairAlarm();
    await this.#ready();
    await this.#install.armIfTreeMissing();
    return this.#workspace.stub();
  }

  /**
   * The same workspace, for a caller that will only touch the filesystem.
   *
   * **The container is not started, and that is the whole difference.** The
   * filesystem is this object's own SQLite, so a read or write of it needs no
   * container and an absent one cannot block it. {@link __getWorkspaceStub} adds
   * `#ready()`, and the first command in a fresh container re-pushes the whole
   * tree before it runs, with `timeoutMs` reaching the spawned process and
   * nothing earlier.
   *
   * A stub cannot enforce what the caller does with it: `runtime.exec` on this
   * one would run against a container with no CA. The exec paths take the other
   * method — see `openWorkspaceFs` in `@dynamicagents/plugins/computer`.
   */
  async __getWorkspaceFsStub(): Promise<WorkspaceStub> {
    await this.#touch();
    await this.#repairAlarm();
    await this.#warmIfCold();
    // Indexes mounts and nothing else — no backend connects here, which is what
    // makes this cheap enough to sit in front of every file tool.
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  /**
   * Ask the alarm to start the container, so the first `bash` finds one that
   * is up and already holding the tree.
   *
   * What this avoids is the push, not the boot — see {@link __getWorkspaceFsStub}.
   * Moving it to the alarm overlaps it with the model's reading.
   *
   * **Only for a workspace with a checkout in it**, since an empty one has
   * nothing to push and nothing to run, and a container it never uses still
   * bills.
   *
   * Only the arming is awaited. A warm that fails costs the next `bash` the
   * start it would have paid for anyway.
   */
  async #warmIfCold(): Promise<void> {
    // The case on every call but the first, which is what keeps the reads below
    // off the per-tool-call cost.
    if (this.ctx.container?.running) return;
    // Already starting — `#ready()` dedupes that, but arming again would queue a
    // wake-up for work in progress.
    if (this.#readying) return;
    const record = await this.ctx.storage.get<CheckoutRecord>(CHECKOUT_KEY);
    if (!record?.dir) return;
    await this.#containerWarm.set(new Date());
  }

  /**
   * Clone, fetch and push — the operations that need the forge token.
   *
   * The work is `./git-host.ts`, which owns why the credential stays on this
   * side of the boundary. What stays here is what only this object can do: the
   * entry-point bookkeeping, and making the workspace current before git reads
   * it.
   */
  async gitClone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult> {
    const behind = await this.#beforeGit();
    return behind ?? (await this.#gitHost.clone(req));
  }

  async gitFetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult> {
    const behind = await this.#beforeGit();
    return behind ?? (await this.#gitHost.fetch(req));
  }

  async gitPush(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult> {
    const behind = await this.#beforeGit();
    return behind ?? (await this.#gitHost.push(req));
  }

  /**
   * Bring the workspace up to date, or say why git must not run.
   *
   * **Git here reads this object's storage**, so it has to be current first. The
   * commits these operations push were made by `git` *in the container*, and
   * they reach this side on that command's own post-exec pull. When that pull
   * did not finish, the workspace still holds the tree as it was before the
   * commit — and isomorphic-git, running here, would push a branch that does not
   * include it. That is the one failure worth stopping for: the push reports
   * success, the forge shows an older tree, and nothing in either account says
   * why.
   *
   * Refused rather than attempted, because every alternative is worse. Pushing
   * anyway publishes a tree the agent did not produce; pushing "what is here"
   * silently redefines what the caller asked for. A refusal is recoverable — the
   * pull resumes on its own schedule and the operation works when retried.
   *
   * Returns the refusal to hand back, or `undefined` to proceed.
   */
  async #beforeGit(): Promise<RepoGitResult | undefined> {
    await this.#touch();
    await this.#repairAlarm();

    /**
     * Drained **before** `#ready()`, which is what starts a stopped container.
     *
     * An outstanding pull belongs to the runtime that ran the command. Start a
     * replacement first and the drain can no longer tell: `pull()` reconnects to
     * whatever is running now, finds a filesystem that matches this object
     * because the workspace just pushed it there, and reports a clean
     * completion — for writes that are gone.
     *
     * Asked while the old container is still the only one there, the same call
     * either moves the writes or says plainly there is nothing to move them
     * from.
     */
    const synced = await this.#sync.drain(SYNC_DRAIN_BUDGET_MS);
    // `failed` refuses alongside `incomplete`, and the reason is that the two
    // differ only in what the *drain* should do next. To git they are one thing:
    // writes that may exist and are not here. Letting a failure through would
    // push the tree this check exists to refuse.
    if (synced === "incomplete" || synced === "failed") {
      // Plain, rather than carrying the failure ladder: a git operation is
      // somebody waiting, which is fresh evidence that the next attempt is worth
      // making soon. The ladder rebuilds from there if the fault persists, and
      // the rate is bounded by how often a model can call a tool.
      await this.#sync.arm();
      console.error(`[${this.#tag}] refusing git: the workspace is behind`, {
        id: this.ctx.id.toString(),
        outcome: synced
      });
      return {
        ok: false,
        message:
          "the container's most recent changes have not reached the workspace " +
          "yet, and git runs against the workspace — so this would act on a " +
          "tree that is missing them. The transfer resumes on its own; try " +
          "again in a moment."
      };
    }

    await this.#ready();
    return undefined;
  }

  /**
   * Start this checkout's dependency install, and return without waiting.
   *
   * Called from `repo_clone` through the repo plugin's `afterCheckout` hook, so
   * it runs inside a model turn — see `./install-job.ts` for why the drain's owner
   * is the thing that matters here.
   */
  async startInstall(req: {
    dir: string;
    repo?: string;
  }): Promise<InstallState> {
    return await this.#install.start(req);
  }

  // --- lifecycle ---------------------------------------------------------------

  /**
   * Mark this workspace as in use, and push its reclamation back.
   *
   * Every entry point calls this, which is what makes the idle clock measure
   * *use* rather than "when the agent last said this name". The agent hands a
   * workspace name to a sub-agent once and then never sees the traffic; the
   * workspace sees all of it.
   */
  async #touch(): Promise<void> {
    // A reclaim emptied this instance and its reset has not landed yet.
    // Scheduling below would write to a table that is gone, so fail this call
    // and let the caller come back on a fresh object.
    if (this.#reclaimed) {
      this.ctx.abort("workspace reclaimed", { retryAlarm: false });
    }

    const now = Date.now();
    // Everything reaches this object by RPC, which bypasses `fetch` — so this
    // is where the lifecycle gets started, and without it the scheduler's schema
    // is never migrated and the first `set` below runs against nothing. Guarded
    // internally, so calling it on every touch costs one resolved promise.
    await this.#wake.start();
    await this.ctx.storage.put("lastUsedAt", now);
    // Two deadlines *moved*, not two schedules added. This is the hottest path
    // in the object — every entry point calls it — so a bare `scheduler.set`
    // here would leave one row per request, every one of them due.
    await this.#idleReclaim.set(new Date(now + IDLE_RECLAIM_MS));
    await this.#containerIdle.set(new Date(now + this.#containerIdleMs));
  }

  /**
   * Stop the container, and **keep everything on disk**.
   *
   * The counterpart to {@link reclaimIfIdle}, and the difference is the whole
   * reason both exist. A reclaim is for a workspace nobody wants again: it empties
   * storage, so the checkout and the dependency tree go with the container. This is
   * for a workspace that will be worked in again — the next task on the same
   * repository has to skip the clone and the install, which is the cost the whole
   * design is arranged around.
   *
   * **Why a caller needs this at all.** The idle deadline would eventually do it,
   * but it cannot be tuned down to meet a cost target: `containerIdleMs` must
   * exceed the longest command the agent allows, and a container that outlives its
   * work by that much bills for the difference. So a host that knows the work is
   * finished says so, and the deadline goes back to being a backstop for the case
   * where nothing got to say anything.
   *
   * Deliberately does **not** touch: `#touch()` would push the very deadline this
   * is standing in for.
   *
   * `released: false` means the container is still up and the standing deadline
   * still owns it — an install is running, or a pull is still moving blocks. Both
   * resolve themselves: the drain re-arms the deadline to come back and finish,
   * which is the same path `#onContainerIdle` takes.
   */
  async releaseContainer(): Promise<{ released: boolean }> {
    // An install in flight is "in use" even though nothing has called in.
    // Same rule, and same reason, as `#onContainerIdle`.
    const install = await this.#install.read();
    if (install.state === "running") return { released: false };

    // Never stop a container with a pull still moving: that is what turns an
    // outstanding write from late into lost. `#drainBeforeStop` carries the
    // reasoning and re-arms the deadline when it defers.
    const lastUsedAt = (await this.ctx.storage.get<number>("lastUsedAt")) ?? 0;
    if (await this.#drainBeforeStop(lastUsedAt, 0)) return { released: false };

    // Dropped rather than left standing: the container is about to be gone, and an
    // alarm that fires afterwards logs a stop against a container that is not
    // running. `#touch` re-arms it the next time this workspace is used.
    await this.#containerIdle.clear();
    await this.#stopContainer("idle");
    return { released: true };
  }

  /**
   * Throw this workspace away if nothing has touched it for `maxIdleMs`.
   *
   * Re-checks the clock rather than trusting the caller: the alarm may have been
   * armed a week ago, and a use since then must win. Safe to call from anywhere
   * for the same reason, which is what lets the agent's cron poke it as a
   * backstop without needing to know anything.
   */
  async reclaimIfIdle(
    maxIdleMs: number = IDLE_RECLAIM_MS
  ): Promise<{ reclaimed: boolean; idleMs: number; bytes: number }> {
    const lastUsedAt = await this.ctx.storage.get<number>("lastUsedAt");
    const bytes = this.ctx.storage.sql.databaseSize;

    // Nothing has ever used this object, so there is nothing to reclaim.
    //
    // Load-bearing, not defensive. `lastUsedAt` is written by `#touch()` and
    // removed by the `deleteAll()` below, so an *already reclaimed* workspace
    // reads exactly like a brand new one. Defaulting it to 0 makes both "idle
    // since the epoch", and the weekly sweep then re-reclaims every workspace it
    // has ever reclaimed, recreating storage just to empty it again.
    if (lastUsedAt === undefined) return { reclaimed: false, idleMs: 0, bytes };

    const idleMs = Date.now() - lastUsedAt;
    if (idleMs < maxIdleMs) return { reclaimed: false, idleMs, bytes };

    console.info(`[${this.#tag}] reclaiming an idle workspace`, {
      id: this.ctx.id.toString(),
      idleDays: Math.round(idleMs / 86_400_000),
      bytes
    });

    await this.#stopContainer("reclaim");
    // `deleteAll` does not take the alarm with it, so the alarm goes first —
    // otherwise a reclaimed object wakes once more into empty storage.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // It *also* takes the lifecycle's job queue table, which this instance has
    // already created and will not create again — so the next schedule set from
    // this isolate would fail against a table that is gone, and the workspace
    // would stop arming its timers until something evicted it. The answer is to
    // stop using this instance: a later call constructs the object fresh on empty
    // storage, and every table comes back with it.
    //
    // **The reset runs from its own alarm invocation, never from here.** An
    // `abort()` on the way out of an RPC races that RPC's response, and the
    // weekly sweep reads this result to decide whether to forget the workspace —
    // so a reset that beat the response would report a failed reclaim for one
    // that had already emptied the object. A timer would race it the same way;
    // only a separate invocation is ordered after the response.
    //
    // Nothing durable records this. The flag exists to reset *this* isolate, and
    // an isolate that went away on its own has already achieved that: a fresh
    // instance creates the tables it needs on the way in.
    this.#reclaimed = true;
    await this.ctx.storage.setAlarm(Date.now());

    return { reclaimed: true, idleMs, bytes };
  }

  /**
   * Stop the container, keeping nothing. The workspace is what persists.
   *
   * Logged first because `@cloudflare/computer` reports this exit as
   * `expected: false`: its own stop is not public, so a raw `destroy()` reads
   * as a crash in its log.
   */
  async #stopContainer(reason: "idle" | "reclaim"): Promise<void> {
    console.info(`[${this.#tag}] stopping the container`, {
      id: this.ctx.id.toString(),
      reason,
      running: this.ctx.container?.running ?? false
    });
    try {
      await this.ctx.container?.destroy();
    } catch (err) {
      // Already gone, most likely, and a container that cannot be stopped must
      // not turn a clean reclaim into a failed alarm.
      console.warn(`[${this.#tag}] could not stop the container`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
    await this.#containerGone();
  }

  /**
   * Whether this object is out of room, and by how much.
   *
   * Read on **two** paths, and the second is load-bearing. The install job
   * consults it because an install is the operation that can move the number
   * meaningfully. {@link advisories} consults it on every call, which is what
   * lets a full workspace reach commands that have nothing to do with
   * dependencies — the write being lost is rarely a dependency's, so a capacity
   * fact delivered only alongside install state reaches everything except what
   * it is about.
   *
   * Cheap enough for that: `databaseSize` is a local property read, not a query.
   */
  #storageHeadroom(): { bytes: number; capBytes: number } | undefined {
    const bytes = this.ctx.storage.sql.databaseSize;
    if (bytes < STORAGE_CAP_BYTES) return undefined;
    return { bytes, capBytes: STORAGE_CAP_BYTES };
  }

  // --- the dependency install ------------------------------------------------

  /**
   * Record what was checked out here, and say whether it is actually visible.
   *
   * **The single writer of {@link CHECKOUT_KEY}**, called by the two paths that
   * know a checkout landed: the repo plugin's `afterCheckout` hook, which fires
   * only once a tree is established, and `scratch_open`, which fires once
   * `git init` has exited 0.
   *
   * **Why the checkout is recorded apart from the install**, which call sites
   * point here for rather than restating: an install is conditional and a
   * checkout is not. `resolveInstallCommand` skips a checkout it finds nothing
   * to install in — any without a `package.json` — so a path written only as
   * part of an install is missing exactly there. What that costs is not an
   * optimisation: {@link checkoutDir} is how a delegated session is told where
   * to work, so a repository can clone perfectly, report itself correctly
   * through the repo tools, and never be worked in. The install keeps its own
   * context for the mirror-image reason — what to re-run on a cold container has
   * a different lifetime from what is on disk.
   *
   * Returns the probe as well as the path, so a caller learns in one round trip
   * whether the tree is visible rather than discovering it a delegation later.
   */
  async noteCheckout(req: {
    dir: string;
    repo?: string;
    kind: "repo" | "scratch";
  }): Promise<{ dir: string; present: boolean }> {
    await this.#touch();
    const record: CheckoutRecord = {
      dir: req.dir,
      ...(req.repo ? { repo: req.repo } : {}),
      kind: req.kind,
      at: Date.now()
    };
    await this.ctx.storage.put(CHECKOUT_KEY, record);
    const present = await this.#isCheckout(req.dir);
    console.info(`[${this.#tag}] checkout recorded`, {
      id: this.ctx.id.toString(),
      dir: req.dir,
      kind: req.kind,
      ...(req.repo ? { repo: req.repo } : {}),
      present
    });
    return { dir: req.dir, present };
  }

  /**
   * Where the work is — a directory holding a git repository, or nothing.
   *
   * Two callers depend on that being the meaning rather than "a path somebody
   * wrote down once": a Claude Code session takes it as its cwd, and
   * `discardWorkingTree` runs `git reset --hard` in it. Both want the same
   * question answered, and neither can recover from a confident wrong answer.
   *
   * So it is **probed, not remembered**. A record is where to look; `.git` being
   * there is what makes the answer true. That costs one local read of this
   * object's own SQLite — everything under the checkout is durable, `.git`
   * included — and it is what turns a stale record into `undefined` instead of
   * into a session started in a directory that is no longer a checkout.
   *
   * The record is the only source. A workspace that has never recorded one
   * answers `undefined` until its next checkout does, which `repo_clone` does on
   * any tree it can fetch and reset.
   */
  async checkoutDir(): Promise<string | undefined> {
    const record = await this.ctx.storage.get<CheckoutRecord>(CHECKOUT_KEY);
    const dir = record?.dir;
    if (!dir) return undefined;
    if (await this.#isCheckout(dir)) return dir;
    // Said out loud because the return value cannot say it: a caller reads
    // `undefined` as "nothing has been cloned", which is also the right answer
    // for a workspace nobody ever cloned into. Only this line separates them.
    console.warn(`[${this.#tag}] a recorded checkout is no longer there`, {
      id: this.ctx.id.toString(),
      dir,
      recorded: record?.kind,
      // The rest of the record, because this line is read during an incident and
      // "the checkout for acme/spike went missing forty minutes ago" is a
      // different investigation from a bare path. It is also the only reader
      // these two fields have.
      ...(record?.repo ? { repo: record.repo } : {}),
      ...(record ? { ageMs: Date.now() - record.at } : {})
    });
    return undefined;
  }

  /**
   * Whether `dir` holds a git repository, as this object's own storage sees it.
   *
   * `.git` rather than the directory: an empty directory is not a checkout, and
   * every caller of {@link checkoutDir} needs git to be there — to reset the
   * tree, or to run a session that will commit in it. It is
   * also the one probe a scratchpad and a clone answer identically, which is
   * what lets them share every path below this line.
   */
  async #isCheckout(dir: string): Promise<boolean> {
    try {
      return await pathExists(this.#workspace.fs, `${dir}/.git`);
    } catch (err) {
      // A read of local SQLite that threw says nothing about the tree. Treat it
      // as absent: refusing a delegation costs a tool call, starting a session in a
      // directory that may not exist costs the run.
      console.warn(`[${this.#tag}] could not probe a checkout`, {
        id: this.ctx.id.toString(),
        dir,
        err: String(err)
      });
      return false;
    }
  }

  /**
   * Everything currently true about this workspace that a caller must not assume
   * away — the array `bash`, `edit` and the workspace's writes all consult.
   *
   * The policy is not here. `deriveAdvisories` decides which facts matter and
   * how they are worded; this method gathers what only the object can see and
   * hands it over. That split is why a host cannot get the severity of its own
   * workspace wrong.
   *
   * **Nothing that starts a long job belongs on this path**, and the rule is
   * sharper here than anywhere else in the object because every tool call reads
   * it. `startInstall` in particular must never be reached from here: it hands
   * its drain to `ctx.waitUntil`, whose lifetime is the invocation's, and an
   * invocation on this path is a tool call that returns in milliseconds. The
   * drain outlives its owner, dies mid-`npm ci` with "WritableStream RPC stub
   * was disposed without calling close()", and leaves a half-written tree.
   *
   * A missing dependency tree arms an install here, which runs in the alarm,
   * which owns no request and outlives every RPC. Here because a command reads
   * this before its `#ready()` starts a container, so the gate holds it for the
   * install rather than letting it outrun one.
   */
  async advisories(): Promise<readonly WorkspaceAdvisory[]> {
    if (!this.ctx.container?.running) await this.#containerGone();
    await this.#install.armIfTreeMissing();
    const install = await this.#install.state();
    const storage = this.#storageHeadroom();
    // Only when the record says failed: it is the one state whose reading a
    // queued repair changes, and every other one would pay a storage read for an
    // answer nothing looks at.
    const reinstallArmedAt =
      install.state === "failed"
        ? await this.#install.reinstallArmedAt()
        : undefined;
    return deriveAdvisories({
      install,
      ...(storage ? { storage } : {}),
      ...(reinstallArmedAt === undefined ? {} : { reinstallArmedAt }),
      // The probe qualifies `deps-broken` and nothing else, and a queued
      // reinstall turns a failed record into `deps-building`, which does not
      // read it. `failed` alone is no longer the condition under which the
      // question is worth asking, so the caller narrows it — see
      // `InstallJob.treePresentIfItMatters`, whose contract this keeps true.
      dependencyTreePresent:
        reinstallArmedAt === undefined
          ? await this.#install.treePresentIfItMatters(install)
          : false
    });
  }

  /**
   * `computerd`'s outbound WebSocket upgrade, on its way back in.
   *
   * The container dials the loopback rather than the other way round, so this
   * object is the server for its own container's capnweb session. Everything
   * else on this object is RPC; this is the only HTTP it speaks.
   */
  override fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }

  /**
   * Every durable wake-up this object has, dispatched from the one alarm.
   *
   * **This must not throw.** The runtime retries a failing alarm handler a
   * bounded number of times and then stops for good — so a throw here would
   * eventually take every *future* wake-up down with it, permanently, and the
   * only symptom is that nothing ever happens again.
   *
   * Nothing else belongs here. Each reason to wake is a registered callback the
   * scheduler dispatches by name, so this method neither matches on keys nor
   * catches per-callback failures — the scheduler retries a failing callback and
   * reports one that fails for good through `onError`. Nor does it sweep for a
   * schedule that neither rescheduled nor cleared itself: a one-shot row is
   * dropped when it runs, so it cannot stay due forever.
   */
  override async alarm(): Promise<void> {
    // The reset a reclaim asked for, in the invocation it asked for it in.
    // Nothing else may run on this instance: its storage is gone, and the job
    // queue's table with it.
    if (this.#reclaimed) {
      this.ctx.abort("workspace reclaimed", { retryAlarm: false });
      return;
    }

    try {
      await this.#wake.alarm();
    } catch (err) {
      // A reclaim that ran *from* this alarm emptied storage, the job queue with
      // it, so settling the job that ran it fails. That is the reclaim working,
      // and the reset it armed is the next thing to happen here.
      if (this.#reclaimed) return;
      console.error(`[${this.#tag}] the alarm failed`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      // One missed wake rather than every future one: re-arm from whatever
      // survived, since the throw above is what the runtime counts against the
      // bounded retry that ends in the alarm being abandoned.
      await this.#wake.rearm().catch(() => {});
    }
  }

  /**
   * An outstanding pull came due.
   *
   * The three answers want three different next moves, which is why the drain
   * distinguishes them. Progress comes straight back for the next block. A
   * failure backs off, carrying its own count in the schedule's payload — the
   * object does not survive between wake-ups, so there is nowhere else to keep
   * it. Nothing reachable ends the attempt: a container that is gone took the
   * unpulled writes with it.
   */
  async #onSyncDrain(payload?: SyncDrainIntent): Promise<void> {
    const outcome = await this.#sync.drain(SYNC_DRAIN_BUDGET_MS);
    if (outcome === "incomplete") {
      await this.#sync.arm();
      return;
    }
    if (outcome === "failed") {
      await this.#sync.arm((payload?.attempt ?? 0) + 1);
    }
  }

  /** The idle-reclaim deadline came due. */
  async #onIdleReclaim(): Promise<void> {
    const { reclaimed, idleMs } = await this.reclaimIfIdle();
    // Not idle after all — something used it since this was armed, and that
    // `#touch` already moved the deadline to a row of its own. So there is
    // nothing to re-arm here, and re-arming would create a second one.
    if (reclaimed) return;
    console.info(`[${this.#tag}] idle reclaim deferred`, {
      id: this.ctx.id.toString(),
      idleMinutes: Math.round(idleMs / 60_000)
    });
  }

  /**
   * The container-warm wake came due — see {@link #warmIfCold}.
   *
   * **Swallows its own failure.** Every other wake here is work somebody waits
   * for; this one is early, so a container that will not start must cost the
   * next `bash` a start rather than put the scheduler's retry ladder behind a
   * deployment fault that will refuse for as long as it stands.
   */
  async #onContainerWarm(): Promise<void> {
    // Started between the arming and now, so there is nothing to be early for.
    // Trust it may still be missing is `#ready()`'s, on the next call that wants
    // the container.
    if (this.ctx.container?.running) return;
    try {
      await this.#ready();
      await this.#install.armIfTreeMissing();
    } catch (err) {
      console.warn(`[${this.#tag}] could not warm the container`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /** The container-idle deadline came due. */
  async #onContainerIdle(payload?: SyncDrainIntent): Promise<void> {
    // An install still running is "in use" even though nothing has called in —
    // stopping the container under it would throw away the work and leave the
    // gate closed until something noticed.
    const state = await this.#install.read();
    if (state.state === "running") {
      await this.#containerIdle.set(
        new Date(Date.now() + this.#containerIdleMs)
      );
      return;
    }

    // Re-read the clock rather than trusting the alarm, the same way
    // `reclaimIfIdle` does. `#touch` moves the deadline forward, but an alarm
    // already in flight cannot be recalled — so without this a workspace that
    // was used a second ago can still have its container stopped by a wake-up
    // that was scheduled before that use.
    const lastUsedAt = (await this.ctx.storage.get<number>("lastUsedAt")) ?? 0;
    const idleMs = Date.now() - lastUsedAt;
    if (idleMs < this.#containerIdleMs) {
      await this.#containerIdle.set(
        new Date(lastUsedAt + this.#containerIdleMs)
      );
      return;
    }

    /**
     * The last chance to move anything the container still holds.
     *
     * Destroying it is what turns an outstanding pull from late into lost, and
     * this is the only moment that is knowable in advance — every other way a
     * container goes away is something happening *to* it. So the drain runs
     * here, and the deadline defers while it is still making progress.
     *
     * The deferral has a wall, because a pull that cannot finish must not keep
     * a container billing forever. Past it the container goes and the unpulled
     * writes go with it, which is the honest outcome: they were unreachable
     * either way, and the alternative is an idle container nobody stops.
     */
    if (await this.#drainBeforeStop(lastUsedAt, payload?.attempt ?? 0)) return;

    await this.#stopContainer("idle");
  }

  /**
   * Whether the idle deadline deferred to let an outstanding pull finish.
   *
   * `attempt` is how many times the drain has failed in a row, carried on the
   * schedule because nothing in memory survives a wake-up.
   */
  async #drainBeforeStop(
    lastUsedAt: number,
    attempt: number
  ): Promise<boolean> {
    const outcome = await this.#sync.drain(SYNC_DRAIN_BUDGET_MS);
    if (outcome === "complete" || outcome === "unavailable") return false;

    if (Date.now() - lastUsedAt > this.#containerIdleMs + SYNC_DRAIN_GRACE_MS) {
      console.error(
        `[${this.#tag}] stopping a container with an unfinished pull`,
        {
          id: this.ctx.id.toString(),
          outcome,
          graceMinutes: Math.round(SYNC_DRAIN_GRACE_MS / 60_000)
        }
      );
      return false;
    }

    /**
     * How soon to come back, and the two outcomes want different answers for the
     * same reason they do on the drain's own schedule — except that here the
     * deferral holds a **container** open, so getting it wrong bills as well as
     * spins. `incomplete` is progress and clears the count; `failed` is a pull
     * that threw, and returning in a second would put an alarm and an error line
     * against a broken transport every second until the grace wall, half an hour
     * later.
     */
    const failed = outcome === "failed";
    const next = failed ? attempt + 1 : 0;
    console.info(`[${this.#tag}] holding a container for an unfinished pull`, {
      id: this.ctx.id.toString(),
      outcome
    });
    await this.#containerIdle.set(
      new Date(
        Date.now() + (failed ? syncRetryDelayMs(next) : SYNC_DRAIN_RESUME_MS)
      ),
      { attempt: next }
    );
    return true;
  }
}
