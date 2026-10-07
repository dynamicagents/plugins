import type { Workspace } from "@cloudflare/computer";
import { DEPS_ROOTS_COMMAND, parseDepsRoots } from "./container-deps.js";

/**
 * A snapshot of a container that has just installed, so the next container
 * starts from it instead of installing again.
 *
 * Dependency trees live on the container's disk (see `./container-deps.ts`), so
 * a new container reinstalls before its first command can use them — what that
 * costs is in `./install-job.ts`. A Containers snapshot is that disk: restored,
 * the trees are back. It holds nothing else worth having — the checkout is this
 * object's storage, mounted over FUSE, and a mount is not in a snapshot.
 *
 * ## When a snapshot is restored
 *
 * Only into a start that would otherwise install the same thing, which takes
 * all of:
 *
 * - **The image it was taken on.** A snapshot replaces the image rather than
 *   layering on it, so one from before a deploy boots the old image's
 *   `computerd`, which nothing downstream catches.
 * - **The same checkout and install fingerprint**, so the marker it carries is
 *   the one an install would write now.
 * - **Every package root's inputs unchanged.** A bootstrap installs roots the
 *   fingerprint does not cover — a submodule's lockfile — and a restore brings
 *   all of them back at once.
 *
 * What came up is then checked, not assumed: the setup mounts the restored trees
 * and reads the marker, and only a match is adopted as installed. Anything else —
 * an expired snapshot, which the platform reports as a failed start, after which
 * the backend's restart takes the image — drops the record, and the install runs
 * and snapshots again.
 *
 * ## The record outlives the container, and the snapshot outlives the record
 *
 * Unlike the tree record, which goes with its container, this is what a later
 * container starts from. The platform keeps a snapshot for thirty days from its
 * last restore and offers no way to delete one, so a dropped record leaves its
 * snapshot to expire.
 */

/** Where the record lives. */
const RECORD_KEY = "deps:snapshot";

export interface DepsSnapshotRecord {
  /** The platform's snapshot id. */
  id: string;
  /** In bytes, as the platform reported it. */
  size: number;
  /** The image reference it was taken on — see the file comment. */
  image: string;
  /** Where the install ran. */
  dir: string;
  /** The install fingerprint its marker holds. */
  fingerprint: string;
  /** Every package root with a tree on the disk, and its inputs' digest then. */
  roots: { dir: string; fingerprint: string | null }[];
  at: number;
}

/** What a restore is checked against: the install a cold start would run. */
export interface ExpectedTree {
  dir: string;
  fingerprint: string;
}

export interface DepsSnapshotDeps {
  storage: DurableObjectStorage;
  container: () => Container | undefined;
  /** The image a start from no snapshot would boot. */
  image: () => string | undefined;
  workspace: () => Workspace;
  rootFingerprint: (dir: string) => Promise<string | null>;
  tag: () => string;
  id: () => string;
}

/**
 * The launch options `ContainerBackend` spreads into every start, whose
 * `containerSnapshot` is read at that moment.
 *
 * A getter, because the backend keeps this object for its lifetime and builds
 * each start from it — the initial one and every restart after a failed health
 * check — and only the first of those may restore: a restart is the backend
 * recovering from a start that did not come up, which an expired snapshot is.
 */
function launchOptions(take: () => ContainerSnapshotRestoreParams | undefined) {
  return {
    get containerSnapshot() {
      return take();
    }
  };
}

export class DepsSnapshot {
  /** Restore with the next start, once. */
  #pending?: ContainerSnapshotRestoreParams;
  /** Whether a start has taken {@link #pending} since it was armed. */
  #launched = false;
  #taking?: Promise<void>;

  readonly launch = launchOptions(() => {
    const pending = this.#pending;
    if (!pending) return undefined;
    this.#pending = undefined;
    this.#launched = true;
    return pending;
  });

  constructor(private readonly deps: DepsSnapshotDeps) {}

  /**
   * Restore with the next start if the record fits it, and say which record.
   *
   * `expected` is a thunk because it reads the checkout, and a workspace with no
   * snapshot or one from another image should not pay for that.
   */
  async arm(
    expected: () => Promise<ExpectedTree | undefined>
  ): Promise<DepsSnapshotRecord | undefined> {
    this.disarm();
    const record = await this.get();
    if (!record) return undefined;
    const refused = await this.#refusal(record, expected);
    if (refused) {
      console.info(
        `[${this.deps.tag()}] not restoring the dependency snapshot`,
        {
          id: this.deps.id(),
          snapshot: record.id,
          reason: refused
        }
      );
      return undefined;
    }
    this.#pending = { id: record.id };
    console.info(`[${this.deps.tag()}] restoring the dependency snapshot`, {
      id: this.deps.id(),
      snapshot: record.id,
      bytes: record.size,
      dir: record.dir
    });
    return record;
  }

  /** Forget an armed restore, taken or not. */
  disarm(): void {
    this.#pending = undefined;
    this.#launched = false;
  }

  /**
   * Whether the container that came up holds `record`'s tree, judged by the
   * marker the setup read in it.
   *
   * Drops the record when a start took it and the tree is not there; leaves it
   * when no start did, since nothing was learned about it.
   */
  async restored(
    record: DepsSnapshotRecord,
    marker: string | null | undefined
  ): Promise<boolean> {
    if (!this.#launched) return false;
    if (marker === record.fingerprint) return true;
    await this.#drop(
      record,
      marker === undefined
        ? "the restored container could not be read"
        : "the restored container does not hold the tree"
    );
    return false;
  }

  /**
   * Snapshot the running container, which has just installed `tree`.
   *
   * Never throws: a container that cannot be snapshotted installs again next
   * time, which is today's cost and no worse.
   */
  async take(tree: ExpectedTree): Promise<void> {
    if (this.#taking) return;
    this.#taking = this.#take(tree).finally(() => {
      this.#taking = undefined;
    });
    await this.#taking;
  }

  /** A snapshot in flight, finished — for whatever is about to stop the container. */
  async settled(): Promise<void> {
    await this.#taking;
  }

  async get(): Promise<DepsSnapshotRecord | undefined> {
    return await this.deps.storage.get<DepsSnapshotRecord>(RECORD_KEY);
  }

  /**
   * Start from another workspace's snapshot — one taken for the same checkout
   * path on the same image, as a worktree shares with the checkout it was cut
   * from.
   *
   * Kept out when this workspace's own snapshot already fits, and refused when
   * the offered one does not.
   */
  async seed(
    record: DepsSnapshotRecord,
    expected: () => Promise<ExpectedTree | undefined>
  ): Promise<{ seeded: boolean; reason?: string }> {
    if (!isRecord(record)) return { seeded: false, reason: "not a snapshot" };
    const now = await expected();
    const fits = async () => now;
    const own = await this.get();
    if (own && !(await this.#refusal(own, fits)))
      return { seeded: false, reason: "this workspace's own snapshot fits" };
    const refused = await this.#refusal(record, fits);
    if (refused) return { seeded: false, reason: refused };
    await this.deps.storage.put(RECORD_KEY, record);
    console.info(`[${this.deps.tag()}] seeded a dependency snapshot`, {
      id: this.deps.id(),
      snapshot: record.id,
      dir: record.dir
    });
    return { seeded: true };
  }

  /** Why `record` must not be restored now, or `undefined` if it may. */
  async #refusal(
    record: DepsSnapshotRecord,
    expected: () => Promise<ExpectedTree | undefined>
  ): Promise<string | undefined> {
    if (record.image !== this.deps.image()) return "taken on another image";
    const tree = await expected();
    if (!tree) return "there is nothing to install here";
    if (record.dir !== tree.dir) return "taken for another checkout";
    if (record.fingerprint !== tree.fingerprint)
      return "the install's inputs have changed";
    for (const root of record.roots) {
      if ((await this.deps.rootFingerprint(root.dir)) !== root.fingerprint)
        return `${root.dir} has changed`;
    }
    return undefined;
  }

  async #drop(record: DepsSnapshotRecord, reason: string): Promise<void> {
    // Only this record: a later install may have put a newer one there.
    if ((await this.get())?.id === record.id)
      await this.deps.storage.delete(RECORD_KEY);
    console.warn(`[${this.deps.tag()}] dropped the dependency snapshot`, {
      id: this.deps.id(),
      snapshot: record.id,
      reason
    });
  }

  async #take(tree: ExpectedTree): Promise<void> {
    const container = this.deps.container();
    const image = this.deps.image();
    if (!container?.running || image === undefined) return;
    const startedAt = Date.now();
    try {
      const roots = await this.#roots();
      // Without a root to mount, a restore would read no marker and be dropped.
      if (roots.length === 0) {
        console.warn(
          `[${this.deps.tag()}] no dependency tree to snapshot on this disk`,
          { id: this.deps.id(), dir: tree.dir }
        );
        return;
      }
      const fingerprinted = [];
      for (const dir of roots)
        fingerprinted.push({
          dir,
          fingerprint: await this.deps.rootFingerprint(dir)
        });
      const snapshot = await container.snapshotContainer({
        name: `deps-${tree.fingerprint.slice(0, 16)}`
      });
      await this.deps.storage.put(RECORD_KEY, {
        id: snapshot.id,
        size: snapshot.size,
        image,
        dir: tree.dir,
        fingerprint: tree.fingerprint,
        roots: fingerprinted,
        at: Date.now()
      } satisfies DepsSnapshotRecord);
      console.info(`[${this.deps.tag()}] took a dependency snapshot`, {
        id: this.deps.id(),
        snapshot: snapshot.id,
        bytes: snapshot.size,
        roots,
        ms: Date.now() - startedAt
      });
    } catch (err) {
      console.warn(
        `[${this.deps.tag()}] could not take a dependency snapshot`,
        {
          id: this.deps.id(),
          err: String(err)
        }
      );
    }
  }

  /** The package roots whose trees are on this container's disk. */
  async #roots(): Promise<string[]> {
    using handle = await this.deps
      .workspace()
      .runtime.exec(DEPS_ROOTS_COMMAND, {
        cwd: "/",
        encoding: "utf8",
        timeoutMs: 30_000
      });
    const result = await handle.result();
    if (result.exitCode !== 0)
      throw new Error(
        `could not list the dependency trees: ${result.stderr || `exit ${result.exitCode}`}`
      );
    return parseDepsRoots(result.stdout ?? "");
  }
}

/** Enough of a record's shape to restore from — it arrives over RPC. */
function isRecord(value: unknown): value is DepsSnapshotRecord {
  const r = value as Partial<DepsSnapshotRecord> | null;
  return (
    typeof r?.id === "string" &&
    typeof r.image === "string" &&
    typeof r.dir === "string" &&
    typeof r.fingerprint === "string" &&
    Array.isArray(r.roots) &&
    r.roots.every((root) => typeof root?.dir === "string")
  );
}
