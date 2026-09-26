import type { WorkspaceClient } from "@cloudflare/computer";

/**
 * Reading the workspace without pulling more of it across the boundary than the
 * model will be shown.
 *
 * The obvious version of each function here reads everything and throws most of
 * it away, which is the wrong shape against a Durable Object's 128 MB. So the
 * budget is applied at the source, and the offsets handed back are the *source's*
 * rather than the rendered subset's — which is what makes the next page exact
 * instead of a guess.
 */

/**
 * Fetch a page, drop what is off-limits, and keep the source offsets that make the
 * *next* page exact.
 *
 * The subtle part is why `rawIndex` exists at all. `offset` counts items at the
 * source; the caller renders a filtered, budget-trimmed subset of them. So the
 * obvious `nextOffset = offset + shown` is wrong — it silently skips or repeats
 * whenever anything was dropped, which is precisely when a skipped directory is
 * involved. Keeping each survivor's source index means the next page starts exactly
 * after the last one the model actually saw.
 *
 * Retries because a skipped directory can outnumber a whole page on its own — a
 * dependency tree runs to tens of thousands of files — so one fetch can come back
 * entirely excluded. `maxRounds` is the caller's: a retry re-reads and re-scans
 * every file the last one looked at. For a walk the store can prune instead, see
 * the `find` tool, which passes exclusions to the store and needs none of this.
 *
 * Deliberately no slicing to `want`: the caller needs the extra item to know a next
 * page exists, and its index to say where.
 */
export async function collectVisible<T>(
  fetch: (offset: number, limit: number) => Promise<T[]>,
  pathOf: (item: T) => string,
  skip: (path: string) => boolean,
  want: number,
  offset: number,
  maxRounds: number
): Promise<{
  items: T[];
  /** Source offset of `items[i]`. */
  rawIndex: number[];
  /** Source offset just past everything examined. */
  rawEnd: number;
  /** The source ran out; there is no next page. */
  exhausted: boolean;
  /** Rounds ran out while excluded paths still dominated. */
  crowded: boolean;
}> {
  const items: T[] = [];
  const rawIndex: number[] = [];
  let cursor = offset;
  let exhausted = false;
  let rounds = 0;

  // One past `want`, so a next page is detected without a further round trip.
  while (items.length <= want && rounds < maxRounds) {
    rounds += 1;
    const batch = await fetch(cursor, want + 1);
    batch.forEach((item, i) => {
      if (skip(pathOf(item))) return;
      items.push(item);
      rawIndex.push(cursor + i);
    });
    cursor += batch.length;
    if (batch.length <= want) {
      exhausted = true;
      break;
    }
  }

  return {
    items,
    rawIndex,
    rawEnd: cursor,
    exhausted,
    crowded: !exhausted && items.length <= want
  };
}

/** What a page of a collected listing owes the caller once it knows how much fit. */
interface VisiblePage {
  rawIndex: number[];
  rawEnd: number;
  exhausted: boolean;
  crowded: boolean;
}

/**
 * The "there is more, here is where" line, with an offset that is actually correct.
 *
 * `rawIndex[shown]` rather than `offset + shown`: the first item the model did *not*
 * see, at its source coordinate. Anything else drifts by however many entries the
 * skip filter removed, and drifts silently — the next page would repeat or skip
 * with nothing to indicate it had.
 *
 * Narrowing is still offered, and still first-class, because it is cheaper than
 * paging: `offset` does not skip the walk, it only discards its early results. It is
 * offered as the better option rather than the only one, which is the thing the
 * previous wording got wrong — "narrow it" is no answer at all when the model wants
 * the next page of a list it is working through.
 */
export function listingNote(
  page: VisiblePage,
  shown: number,
  noun: string,
  narrower: string
): string {
  const next =
    shown < page.rawIndex.length
      ? page.rawIndex[shown]
      : page.exhausted
        ? undefined
        : page.rawEnd;
  if (next === undefined) return "";
  return (
    `\n\n… showed ${shown} ${noun}; there are more. Continue with ` +
    `\`offset: ${next}\`, or narrow with ${narrower} — narrowing is cheaper, ` +
    `since an offset still walks everything it skips.`
  );
}

/**
 * Does this path exist?
 *
 * `getWorkspace()` types `fs` as the in-process `WorkspaceFilesystem`, but the
 * value on the far side of a Durable Object boundary is a
 * `WorkspaceFilesystemStub`, which carries a few methods the local class does
 * not — `exists` among them. So the fast path is asked for rather than cast to,
 * and `stat` is the fallback for a host that hands back a local workspace.
 *
 * The fallback treats *any* `stat` failure as absence, which is the honest
 * reading for a tool whose entire answer is a boolean: there is no error channel
 * to distinguish "missing" from "unreadable", and the caller's next move — look
 * somewhere else — is the same either way.
 */
export async function pathExists(
  fs: WorkspaceClient["fs"],
  path: string
): Promise<boolean> {
  // Called as a method, never through `.call`: on an RPC stub `.call` is read as
  // a remote method, and the stub it would pass as `this` cannot be serialised.
  const remote = fs as { exists?: (p: string) => Promise<boolean> };
  if (typeof remote.exists === "function") return remote.exists(path);
  return fs.stat(path).then(
    () => true,
    () => false
  );
}
