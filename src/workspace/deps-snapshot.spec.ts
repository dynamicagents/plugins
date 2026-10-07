import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { freshWorkspace } from "../../test/workspace/do.js";
import {
  DepsSnapshot,
  packageRootSet,
  type DepsSnapshotRecord,
  type ExpectedTree,
  type InstalledTree
} from "./deps-snapshot.js";

/**
 * The snapshot logic against real Durable Object storage, with the container and
 * the checkout stood in for: the pool runs no container, and what is pinned
 * here is what gets restored, and when a record is let go.
 */

const IMAGE = "registry.cloudflare.com/account/test-workspace-app@sha256:a";
const DIR = "/workspace/repo";
const TREE: InstalledTree = { dir: DIR, fingerprint: "f".repeat(64), at: 1 };
const ROOTS: Record<string, string | null> = {
  [DIR]: "root-digest",
  [`${DIR}/core`]: "core-digest"
};
const PACKAGES = [`${DIR}/package.json`, `${DIR}/core/package.json`];
const GITMODULES = '[submodule "core"]\n\tpath = core\n';

/** The checkout's filesystem, as far as {@link packageRootSet} reads it. */
function checkoutFs(packages = PACKAGES, gitmodules = GITMODULES) {
  return {
    find: async () => packages.map((path) => ({ path, type: "file" })),
    readFile: async (path: string) => {
      if (path === `${DIR}/.gitmodules`) return gitmodules;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
  } as unknown as Workspace["fs"];
}

const ROOT_SET = await packageRootSet(checkoutFs(), DIR);

const RECORD: DepsSnapshotRecord = {
  id: "snap-1",
  size: 1_000_000,
  image: IMAGE,
  dir: DIR,
  fingerprint: TREE.fingerprint,
  roots: [
    { dir: DIR, fingerprint: "root-digest" },
    { dir: `${DIR}/core`, fingerprint: "core-digest" }
  ],
  rootSet: ROOT_SET,
  at: 0
};

interface Stand {
  running?: boolean;
  image?: string;
  /** What the roots listing prints. */
  roots?: string;
  /** What each root's inputs hash to now. */
  fingerprints?: Record<string, string | null>;
  /** The `package.json` files the checkout has now. */
  packages?: string[];
  gitmodules?: string;
  /** The tree the install record names; changeable as a test runs. */
  tree?: InstalledTree;
  snapshot?: (options?: ContainerSnapshotOptions) => Promise<ContainerSnapshot>;
}

/** A `DepsSnapshot` on `storage`, over a stand-in container and checkout. */
function standIn(storage: DurableObjectStorage, stand: Stand = {}) {
  const taken: (ContainerSnapshotOptions | undefined)[] = [];
  const current = { tree: "tree" in stand ? stand.tree : TREE };
  const container = {
    running: stand.running ?? true,
    snapshotContainer: async (options?: ContainerSnapshotOptions) => {
      taken.push(options);
      return stand.snapshot
        ? await stand.snapshot(options)
        : { id: `snap-${taken.length + 1}`, size: 42, name: options?.name };
    }
  } as unknown as Container;
  const workspace = {
    fs: checkoutFs(stand.packages, stand.gitmodules),
    runtime: {
      exec: async () => ({
        result: async () => ({
          exitCode: 0,
          stdout: stand.roots ?? `${DIR}\n${DIR}/core\n`,
          stderr: ""
        }),
        [Symbol.dispose]: () => {}
      })
    }
  } as unknown as Workspace;
  const fingerprints = stand.fingerprints ?? ROOTS;
  const snapshot = new DepsSnapshot({
    storage,
    container: () => container,
    image: () => ("image" in stand ? stand.image : IMAGE),
    workspace: () => workspace,
    rootFingerprint: async (dir) => fingerprints[dir] ?? null,
    tree: async () => current.tree,
    tag: () => "spec",
    id: () => "spec-id"
  });
  return { snapshot, taken, current };
}

const expecting = (tree: ExpectedTree | undefined) => async () => tree;

describe("taking a snapshot", () => {
  it("records what it was taken on, every root's inputs, and which roots there are", async () => {
    const stub = freshWorkspace("snapshot-take");
    const { record, taken } = await runInDurableObject(stub, async (_i, s) => {
      const { snapshot, taken } = standIn(s.storage);
      await snapshot.take(TREE);
      return { record: await snapshot.get(), taken };
    });
    expect(taken).toEqual([{ name: `deps-${"f".repeat(16)}` }]);
    expect(record).toMatchObject({
      id: "snap-2",
      size: 42,
      image: IMAGE,
      dir: DIR,
      fingerprint: TREE.fingerprint,
      roots: RECORD.roots,
      rootSet: ROOT_SET
    });
  });

  it.each([
    ["a container that is not running", { running: false }],
    ["no prepared image", { image: undefined }],
    ["a disk with no tree on it", { roots: "" }],
    ["a tree the install record no longer names", { tree: { ...TREE, at: 2 } }]
  ])("takes nothing from %s", async (_name, stand: Stand) => {
    const stub = freshWorkspace("snapshot-take-nothing");
    const { record, taken } = await runInDurableObject(stub, async (_i, s) => {
      const { snapshot, taken } = standIn(s.storage, stand);
      await snapshot.take(TREE);
      return { record: await snapshot.get(), taken };
    });
    expect(taken).toEqual([]);
    expect(record).toBeUndefined();
  });

  it("keeps the record it had when the platform refuses", async () => {
    const stub = freshWorkspace("snapshot-take-refused");
    const record = await runInDurableObject(stub, async (_i, s) => {
      await s.storage.put("deps:snapshot", RECORD);
      const { snapshot } = standIn(s.storage, {
        snapshot: () => Promise.reject(new Error("snapshots are unavailable"))
      });
      await snapshot.take(TREE);
      return await snapshot.get();
    });
    expect(record).toEqual(RECORD);
  });

  /** A reinstall empties the tree before it rebuilds it. */
  it("records nothing when the tree changed while it was taken", async () => {
    const stub = freshWorkspace("snapshot-take-changed");
    const after = await runInDurableObject(stub, async (_i, s) => {
      let reinstall = () => {};
      const { snapshot, taken, current } = standIn(s.storage, {
        snapshot: async () => {
          reinstall();
          return { id: "snap-torn", size: 1 };
        }
      });
      reinstall = () => {
        current.tree = undefined;
      };
      await snapshot.take(TREE);
      return { taken: taken.length, record: await snapshot.get() };
    });
    expect(after).toEqual({ taken: 1, record: undefined });
  });

  it("takes a later install's snapshot after the one in flight, not instead of it", async () => {
    const stub = freshWorkspace("snapshot-take-queued");
    const later: InstalledTree = {
      ...TREE,
      fingerprint: "e".repeat(64),
      at: 2
    };
    const record = await runInDurableObject(stub, async (_i, s) => {
      let finish = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let calls = 0;
      const { snapshot, current } = standIn(s.storage, {
        snapshot: async () => {
          calls += 1;
          if (calls === 1) await gate;
          return { id: `snap-${calls}`, size: 1 };
        }
      });
      const first = snapshot.take(TREE);
      await scheduler.wait(1);
      // The second install finishes while the first snapshot is still taken.
      current.tree = later;
      const second = snapshot.take(later);
      finish();
      await Promise.all([first, second]);
      return await snapshot.get();
    });
    expect(record).toMatchObject({
      id: "snap-2",
      fingerprint: later.fingerprint
    });
  });

  /** A stop destroys the container a snapshot is still reading. */
  it("is waited for by whatever stops the container", async () => {
    const stub = freshWorkspace("snapshot-settled");
    const order = await runInDurableObject(stub, async (_i, s) => {
      const order: string[] = [];
      let finish = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { snapshot } = standIn(s.storage, {
        snapshot: async () => {
          await gate;
          order.push("snapshot");
          return { id: "snap-slow", size: 1 };
        }
      });
      const taking = snapshot.take(TREE);
      const stopped = snapshot.settled().then(() => void order.push("stop"));
      await scheduler.wait(1);
      finish();
      await Promise.all([taking, stopped]);
      return order;
    });
    expect(order).toEqual(["snapshot", "stop"]);
  });
});

describe("the snapshot an install asks for", () => {
  /** Ask for `TREE`, then take what is due while the install record names `held`. */
  async function due(name: string, held: InstalledTree | undefined) {
    const stub = freshWorkspace(name);
    return await runInDurableObject(stub, async (_i, s) => {
      const { snapshot, taken } = standIn(s.storage, { tree: held });
      await s.storage.put(snapshot.dueEntries(TREE));
      await snapshot.takeDue();
      // Asked once: a second take finds nothing due.
      await snapshot.takeDue();
      return {
        taken: taken.length,
        record: await snapshot.get(),
        stillDue: await s.storage.get("deps:snapshot-due")
      };
    });
  }

  it("is taken once, while the install record names the tree it was asked for", async () => {
    const after = await due("due-held", TREE);
    expect(after.taken).toBe(1);
    expect(after.record?.fingerprint).toBe(TREE.fingerprint);
    expect(after.stillDue).toBeUndefined();
  });

  it.each([
    ["names another tree", { ...TREE, fingerprint: "other" }],
    ["names the same lockfile installed again", { ...TREE, at: 2 }],
    ["names none", undefined]
  ])("is let go when the install record %s", async (_name, held) => {
    const after = await due("due-moved", held);
    expect(after.taken).toBe(0);
    expect(after.stillDue).toBeUndefined();
  });

  it("is forgotten with the container", async () => {
    const stub = freshWorkspace("due-forgotten");
    const stillDue = await runInDurableObject(stub, async (_i, s) => {
      const { snapshot } = standIn(s.storage);
      await s.storage.put(snapshot.dueEntries(TREE));
      await snapshot.forgetDue();
      return await s.storage.get("deps:snapshot-due");
    });
    expect(stillDue).toBeUndefined();
  });
});

describe("restoring a snapshot", () => {
  /** Arm on `stand`, then read what the next two starts would launch with. */
  async function launches(
    name: string,
    expected: ExpectedTree | undefined,
    stand: Stand = {}
  ) {
    const stub = freshWorkspace(name);
    return await runInDurableObject(stub, async (_i, s) => {
      await s.storage.put("deps:snapshot", RECORD);
      const { snapshot } = standIn(s.storage, stand);
      const armed = await snapshot.arm(expecting(expected));
      const first = { ...snapshot.launch };
      const restart = { ...snapshot.launch };
      return { armed, first, restart };
    });
  }

  it("restores into the first start only, so a restart boots the image", async () => {
    const { armed, first, restart } = await launches("restore-fits", TREE);
    expect(armed).toEqual(RECORD);
    expect(first).toEqual({ containerSnapshot: { id: "snap-1" } });
    expect(restart).toEqual({ containerSnapshot: undefined });
  });

  it.each([
    ["taken on another image", TREE, { image: "another" }],
    ["with nothing to install", undefined, {}],
    ["for another checkout", { ...TREE, dir: "/workspace/other" }, {}],
    ["whose install inputs changed", { ...TREE, fingerprint: "changed" }, {}],
    [
      "when a root's inputs changed",
      TREE,
      { fingerprints: { ...ROOTS, [`${DIR}/core`]: "moved" } }
    ],
    [
      "when a package root was added",
      TREE,
      { packages: [...PACKAGES, `${DIR}/plugins/package.json`] }
    ],
    [
      "when a submodule was declared",
      TREE,
      { gitmodules: `${GITMODULES}[submodule "plugins"]\n\tpath = plugins\n` }
    ]
  ])(
    "boots the image for a snapshot %s",
    async (_name, expected, stand: Stand) => {
      const { armed, first } = await launches(
        "restore-refused",
        expected,
        stand
      );
      expect(armed).toBeUndefined();
      expect(first).toEqual({ containerSnapshot: undefined });
    }
  );

  /** What `restored` decides, after a start took the snapshot or did not. */
  async function judged(
    name: string,
    marker: string | null | undefined,
    start = true
  ) {
    const stub = freshWorkspace(name);
    return await runInDurableObject(stub, async (_i, s) => {
      await s.storage.put("deps:snapshot", RECORD);
      const { snapshot } = standIn(s.storage);
      const armed = await snapshot.arm(expecting(TREE));
      if (start) void { ...snapshot.launch };
      const ok = await snapshot.restored(armed!, marker);
      return { ok, record: await snapshot.get() };
    });
  }

  it("adopts what came up when its marker is the snapshot's", async () => {
    expect(await judged("restored-match", TREE.fingerprint)).toEqual({
      ok: true,
      record: RECORD
    });
  });

  it.each([
    ["holds no tree", null],
    ["could not be read", undefined],
    ["holds another tree", "other"]
  ])(
    "drops the record when the container that came up %s",
    async (_name, marker) => {
      expect(await judged("restored-mismatch", marker)).toEqual({
        ok: false,
        record: undefined
      });
    }
  );

  it("learns nothing, and keeps the record, when no start took it", async () => {
    expect(await judged("restored-unlaunched", null, false)).toEqual({
      ok: false,
      record: RECORD
    });
  });
});

describe("seeding another workspace's snapshot", () => {
  async function seeded(
    name: string,
    offered: unknown,
    stand: Stand = {},
    own?: DepsSnapshotRecord
  ) {
    const stub = freshWorkspace(name);
    return await runInDurableObject(stub, async (_i, s) => {
      if (own) await s.storage.put("deps:snapshot", own);
      const { snapshot } = standIn(s.storage, stand);
      const result = await snapshot.seed(
        offered as DepsSnapshotRecord,
        expecting(TREE)
      );
      return { result, record: await snapshot.get() };
    });
  }

  it("takes one that fits this checkout", async () => {
    expect(await seeded("seed-fits", RECORD)).toEqual({
      result: { seeded: true },
      record: RECORD
    });
  });

  it("refuses one from another image", async () => {
    const { result, record } = await seeded("seed-image", RECORD, {
      image: "another"
    });
    expect(result).toEqual({ seeded: false, reason: "taken on another image" });
    expect(record).toBeUndefined();
  });

  it("keeps this workspace's own when it fits", async () => {
    const own = { ...RECORD, id: "snap-own" };
    const { result, record } = await seeded("seed-own", RECORD, {}, own);
    expect(result.seeded).toBe(false);
    expect(record).toEqual(own);
  });

  it("replaces this workspace's own when it no longer fits", async () => {
    const own = { ...RECORD, id: "snap-own", fingerprint: "stale" };
    const { result, record } = await seeded("seed-stale", RECORD, {}, own);
    expect(result).toEqual({ seeded: true });
    expect(record).toEqual(RECORD);
  });

  it("refuses something that is not a record", async () => {
    const { result } = await seeded("seed-garbage", { id: 7 });
    expect(result).toEqual({ seeded: false, reason: "not a snapshot" });
  });
});
