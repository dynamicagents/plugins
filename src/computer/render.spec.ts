import { describe, it, expect } from "vitest";
import { packBlocks, renderGrepMatches } from "./render.js";

/**
 * How a match list reads.
 *
 * The budget rules here are deliberately not `truncateOutput`'s. Keeping both ends
 * and dropping the middle is right for a build log, where the first error and the
 * final summary are the whole value — and destructive for search results, where the
 * middle is an entire file's worth of hits that disappear without saying so.
 */
describe("renderGrepMatches", () => {
  const match = (path: string, line: number, text: string) => ({
    path,
    line,
    text
  });

  it("names each file once and lists its hits under it", () => {
    const { body } = renderGrepMatches(
      [
        match("/workspace/a.ts", 4, "const x = 1;"),
        match("/workspace/a.ts", 9, "const y = 2;"),
        match("/workspace/b.ts", 2, "const z = 3;")
      ],
      16_000
    );

    // An absolute path costs more than the line it labels; repeating it per hit
    // spends the budget on paths rather than code.
    expect(body.match(/\/workspace\/a\.ts/g)).toHaveLength(1);
    expect(body).toContain("  4: const x = 1;");
    expect(body).toContain("  9: const y = 2;");
    expect(body).toContain("/workspace/b.ts");
  });

  it("distinguishes the matching line from its context, as grep does", () => {
    const { body } = renderGrepMatches(
      [
        {
          path: "/workspace/a.ts",
          line: 5,
          text: "const x = 1;",
          context: [
            { line: 4, text: "// before", isMatch: false },
            { line: 5, text: "const x = 1;", isMatch: true },
            { line: 6, text: "// after", isMatch: false }
          ]
        }
      ],
      16_000
    );

    // `:` is the hit, `-` is context. Without the distinction the model cannot
    // tell which line it actually searched for.
    expect(body).toContain("  5: const x = 1;");
    expect(body).toContain("  4- // before");
    expect(body).toContain("  6- // after");
  });

  /**
   * The minified-bundle case. One match in `dist/` carries a line of megabytes,
   * and `text` is the whole line — so without a cap a single hit is the entire
   * result.
   */
  it("shortens a very long line instead of letting it eat the result", () => {
    const { body, capped } = renderGrepMatches(
      [
        match("/workspace/dist/bundle.js", 1, `x${"y".repeat(50_000)}`),
        match("/workspace/src/a.ts", 3, "readable")
      ],
      16_000
    );

    expect(body.length).toBeLessThan(1_000);
    expect(body).toContain("chars]");
    // The point of capping rather than dropping: the later match survives.
    expect(body).toContain("readable");
    // Reported once, so the caller can say how to reach the full text without
    // repeating the advice on every shortened line.
    expect(capped).toBe(true);
  });

  it("does not claim a line was shortened when none that shipped was", () => {
    const { capped } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "short")],
      16_000
    );
    expect(capped).toBe(false);
  });

  it("stops at the budget and reports exactly how many it showed", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      match("/workspace/a.ts", i + 1, `line ${i} ${"x".repeat(80)}`)
    );

    const { body, shown } = renderGrepMatches(many, 2_000);

    expect(body.length).toBeLessThan(2_400);
    // `shown` is what makes the next offset exact rather than a guess.
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
  });

  it("emits the first match however large, rather than nothing at all", () => {
    const { body, shown } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "x".repeat(5_000))],
      50
    );
    expect(body).toContain("/workspace/a.ts");
    expect(body).toContain("1:");
    expect(shown).toBe(1);
  });
});

/**
 * The budget rule both list tools share.
 *
 * Whole blocks only, because half a match's context reads like a corrupt result —
 * and an exact `shown`, because that number is what the next page's offset is
 * computed from. A `shown` that over-reported by one would silently skip an entry
 * on every subsequent page.
 */
describe("packBlocks", () => {
  it("emits whole blocks and counts them exactly", () => {
    const { body, shown } = packBlocks(
      [["a", "b"], ["c"], ["d", "e", "f"]],
      1_000
    );
    expect(body).toBe("a\nb\nc\nd\ne\nf");
    expect(shown).toBe(3);
  });

  it("drops a block whole rather than splitting it", () => {
    const { body, shown } = packBlocks(
      [["x".repeat(20)], ["y".repeat(20), "z".repeat(20)]],
      30
    );
    expect(shown).toBe(1);
    expect(body).not.toContain("y");
    // Not a partial second block: the line that would have fit is absent too.
    expect(body).not.toContain("z");
  });

  it("always emits the first block, however far over budget", () => {
    const { body, shown } = packBlocks([["x".repeat(5_000)], ["y"]], 10);
    expect(shown).toBe(1);
    expect(body.length).toBeGreaterThan(10);
  });

  it("reports nothing shown for no blocks", () => {
    expect(packBlocks([], 100)).toEqual({ body: "", shown: 0 });
  });
});
