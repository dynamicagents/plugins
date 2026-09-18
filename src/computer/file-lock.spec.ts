import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

/** A promise the test resolves, created before any lock body runs. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

describe("withFileLock", () => {
  it("releases the key when a holder throws", async () => {
    await expect(
      withFileLock("s", "/a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(withFileLock("s", "/a", async () => "next")).resolves.toBe(
      "next"
    );
  });

  it("does not hold one path behind another", async () => {
    const g = gate();
    const held = withFileLock("s", "/a", () => g.wait);
    await expect(withFileLock("s", "/b", async () => "free")).resolves.toBe(
      "free"
    );
    g.open();
    await held;
  });

  it("holds one lock for two spellings of the same path", async () => {
    const order: string[] = [];
    const g = gate();
    const held = withFileLock("s", "/w/a.ts", async () => {
      await g.wait;
      order.push("first");
    });
    const aliased = ["/w", "src", "..", "a.ts"].join("/");
    const second = withFileLock("s", aliased, async () => {
      order.push("second");
    });
    g.open();
    await Promise.all([held, second]);
    expect(order).toEqual(["first", "second"]);
  });
});
