/**
 * Reading values out of the CLI's JSON, where every field arrives untyped.
 *
 * A `stream-json` line and a tool's input are both parsed JSON this package
 * does not own the schema of: a field may be absent, renamed between CLI
 * versions, or the wrong type. So a reader coerces rather than asserts, and
 * what each coercion does with a value it rejects is a decision its own caller
 * holds. Only the coercions whose answer is the same for every caller live
 * here.
 */

/**
 * A non-empty string, or nothing.
 *
 * The empty string is rejected along with the wrong type, because every caller
 * reads one of these to put in a sentence or a card's head, and `""` there is a
 * missing value wearing the right type. That makes `??` the way to fall back,
 * which is how the readers in {@link file://./cards.ts cards.ts} and
 * {@link file://./events.ts events.ts} chain their candidates.
 */
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
