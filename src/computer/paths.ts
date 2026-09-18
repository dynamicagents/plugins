/**
 * Which paths these tools act on, and the sentence a refused one gets.
 *
 * Both refused directories are also skipped by every walk. `.git` is refused as
 * policy: a model that edits `.git/HEAD` corrupts a checkout in a way that
 * surfaces much later. `node_modules` is refused as a fact: it lives on the
 * container's disk (see `./host/container-deps.ts`), so these tools, which read
 * the workspace, would find it empty.
 *
 * Everything here is a string comparison: no filesystem, no `await`, which is
 * what lets {@link guardPath} run before a tool opens the workspace at all.
 */

/** Whether any segment of `path` is exactly `segment`. */
function hasSegment(path: string, segment: string): boolean {
  return path.split("/").includes(segment);
}

/**
 * Is this path inside git's internal state?
 *
 * Refused because a model that edits `.git/HEAD` or `.git/config` corrupts a
 * checkout in a way that surfaces much later as an inexplicable git failure.
 *
 * Exact segment rather than substring, so `.gitignore`, `.gitattributes` and
 * `.github/` are untouched.
 */
export function isGitInternal(path: string): boolean {
  return hasSegment(path, ".git");
}

/**
 * What every walk steps over. `find` prunes these in the store; `grep` takes no
 * exclusion, so `sb_grep` filters its results instead.
 */
export const WALK_SKIPS = [".git", "node_modules"] as const;

/** Whether a walk carrying `skips` steps over `path`. */
export function isSkipped(skips: readonly string[], path: string): boolean {
  return skips.some((segment) => hasSegment(path, segment));
}

/** The skipped directories, for a sentence: "`.git` and `node_modules`". */
export function skipNames(skips: readonly string[]): string {
  const quoted = skips.map((segment) => `\`${segment}\``);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`
    : (quoted[0] ?? "");
}

/** The sentence a `node_modules` path gets. */
function dependencyTreeNote(path: string, verb: string): string {
  return (
    `${path} is inside node_modules, which lives on the container's disk rather ` +
    `than in the workspace ${verb} works on. Use sb_exec there — ` +
    `\`cat\`, \`ls\`, \`rg\`.`
  );
}

/**
 * The sentence a `.git` path gets.
 *
 * Names a route deliberately: a refusal with no destination is worse than no
 * refusal, because the model retries and then works around it.
 *
 * What it must never name is `sb_exec`. That hands back the exact capability
 * being withheld, in the one place the model is already looking for a way around
 * it, with the tool's own authority behind it. `sb_exec` is unguarded because a
 * shell takes an opaque command string and pattern-matching git out of one is
 * neither reliable nor this guard's job — a fact about the implementation, not a
 * route to advertise.
 */
function gitInternalNote(path: string, verb: string): string {
  return (
    `${path} is inside .git — git's internal state, which ${verb} does not touch. ` +
    `Reading it tells you less than the repository tools do, and writing it ` +
    `corrupts the checkout. Repository work goes through the repo tools ` +
    `(\`repo_status\`, \`repo_diff\`, \`repo_commit\`, \`repo_push\`), which the ` +
    `main agent holds. If this task needs git state you cannot get that way, say ` +
    `so in your result rather than reaching into .git yourself.`
  );
}

/**
 * The path check every file tool makes, before it opens anything.
 *
 * Returns the sentence to hand back, or `undefined` to proceed. One string
 * comparison — no `stat`, no round trip — which is why every file tool can
 * afford to call it before the workspace is opened.
 *
 * ## A redirect, not a boundary
 *
 * The note names the tools repository work belongs to, because the case that
 * actually happens is a model reaching into `.git/HEAD` to fix a merge.
 *
 * It is not containment, and this is the only place worth saying so. `sb_exec`
 * is in the same tool family, granted per family rather than per tool, so every
 * agent holding these file tools also holds a shell that reads and writes `.git`
 * directly.
 *
 * Symlinks are not resolved, for the same reason: a tracked
 * `docs/notes.md -> ../.git/config` only matters to an agent given these tools
 * *without* the shell, which the family granularity makes unbuildable. If that
 * ever becomes buildable, the **write** path is the half to restore —
 * `.git/config` is an input to the credentialed push, and a planted hook runs
 * under a container-side `repo_commit`. Reading `.git` discloses nothing that is
 * not already readable, so the read half is not worth an `lstat` per call. The
 * shape would be to resolve every ancestor rather than the final component,
 * `lstat`ing the prefixes in parallel for one round trip rather than one per
 * segment.
 */
export function guardPath(path: string, verb: string): string | undefined {
  if (isGitInternal(path)) return gitInternalNote(path, verb);
  if (hasSegment(path, "node_modules")) return dependencyTreeNote(path, verb);
  return undefined;
}
