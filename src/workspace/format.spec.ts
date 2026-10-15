import { describe, it, expect } from "vitest";
import { cancelledNote } from "./format.js";

/**
 * Everything this module decides about what a result *looks like* by the time a
 * model sees it.
 *
 * Pure functions over strings, so there is no workspace stub here and none is
 * wanted: every assertion below is about a budget being spent the way its
 * content deserves, and a container would only make that slower to find out.
 *
 * The output bound itself is `@dynamicagents/core`'s `truncateOutput` now, and
 * its specs are there — including the small-budget inversion that was a real
 * defect in a copy of it.
 */

/**
 * `renderResult` says this on its verdict line, so `bash` has always had it.
 * `computerExec` has no verdict line and dropped `status` entirely — and a killed
 * process writes nothing, so `/repo` reported `clone failed:` with nothing after
 * the colon for a clone that hit the ceiling.
 */
describe("cancelledNote", () => {
  it("explains a command that was killed, naming both usual causes", () => {
    const note = cancelledNote("cancelled", 137, 600_000);

    expect(note).toContain("killed");
    // The ceiling as the model would have to state it to change it, and the
    // other cause of a 137 — the exit code cannot tell them apart.
    expect(note).toContain("10m00s");
    expect(note).toMatch(/out of memory/);
  });

  it("says nothing about an ordinary failure", () => {
    // A non-zero exit is the command's own business, and its stderr explains it
    // better than a note could. Anything here would be noise on every failure.
    expect(cancelledNote("failed", 1, 600_000)).toBeUndefined();
    expect(cancelledNote("completed", 0, 600_000)).toBeUndefined();
    expect(cancelledNote(undefined, 1, 600_000)).toBeUndefined();
  });
});
