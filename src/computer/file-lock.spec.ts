import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

describe("withFileLock", () => {
  it("releases the key when a holder throws", async () => {
    await expect(
      withFileLock("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(withFileLock("k", async () => "next")).resolves.toBe("next");
  });

  it("does not hold one key behind another", async () => {
    let release!: () => void;
    const held = withFileLock(
      "a",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await expect(withFileLock("b", async () => "free")).resolves.toBe("free");
    release();
    await held;
  });
});
