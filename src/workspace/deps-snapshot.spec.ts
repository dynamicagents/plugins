import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { freshWorkspace } from "../../test/workspace/do.js";
import {
  DepsSnapshot,
  type DepsSnapshotRecord,
  type ExpectedTree
} from "./deps-snapshot.js";

/**
 * The snapshot logic against real Durable Object storage, with the container and
 * the checkout stood in for: the pool runs no container, and what is pinned
 * here is what gets restored, and when a record is let go.
 */

const IMAGE = "registry.cloudflare.com/account/test-workspace-app@sha256:a";
const DIR = "/workspace/repo";
const TREE: ExpectedTree = { dir: DIR, fingerprint: "f".repeat(64) };
const ROOTS: Record<string, string | null> = {
  [DIR]: "root-digest",
  [`${DIR}/core`]: "core-digest"
};

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
  at: 0
};

interface Stand {
  running?: boolean;
  image?: string;
  /** What the roots listing prints. */
  roots?: string;
  /** What each root's inputs hash to now. */
  fingerprints?: Record<string, string | null>;
  snapshot?: (options?: ContainerSnapshotOptions) => Promise<ContainerSnapshot>;
}

/** A `DepsSnapshot` on `storage`, over a stand-in container and checkout. */
function standIn(storage: DurableObjectStorage, stand: Stand = {}) {
  const taken: (ContainerSnapshotOptions | undefined)[] = [];
  const container = {
    running: stand.running ?? true,
    snapshotContainer: async (options?: ContainerSnapshotOptions) => {
      taken.push(options);
      return stand.snapshot
        ? await stand.snapshot(options)
        : { id: "snap-new", size: 42, name: options?.name };
    }
  } as unknown as Container;
  const workspace = {
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
    tag: () => "spec",
    id: () => "spec-id"
  });
  return { snapshot, taken };
}

const expecting = (tree: ExpectedTree | undefined) => async () => tree;

describe("taking a snapshot", () => {
  it("records what it was taken on, and what every root's inputs were", async () => {
    const stub = freshWorkspace("snapshot-take");
    const { record, taken } = await runInDurableObject(stub, async (_i, s) => {
      const { snapshot, taken } = standIn(s.storage);
      await snapshot.take(TREE);
      return { record: await snapshot.get(), taken };
    });
    expect(taken).toEqual([{ name: `deps-${"f".repeat(16)}` }]);
    expect(record).toMatchObject({
      id: "snap-new",
      size: 42,
      image: IMAGE,
      dir: DIR,
      fingerprint: TREE.fingerprint,
      roots: RECORD.roots
    });
  });

  it.each([
    ["a container that is not running", { running: false }],
    ["no prepared image", { image: undefined }],
    ["a disk with no tree on it", { roots: "" }]
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
