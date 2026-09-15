/**
 * Which paths these tools act on, and the sentence a refused one gets.
 *
 * Two questions that look alike and are not. **Refusal** is about access, and
 * only `.git` is refused — policy, decided here, because a model that edits
 * `.git/HEAD` corrupts a checkout in a way that surfaces much later. **Skipping**
 * is about attention: a recursive walk that spends its page on a dependency tree
 * shows the model nothing it asked for, so the walk steps over those directories
 * while every one of their files stays readable by name.
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
 * Skipped by every walk, whatever it was pointed at.
 *
 * `.git` only, and it is the same answer {@link guardPath} gives: a walk cannot
 * be rooted there either, because every file tool guards its path first. Listed
 * separately from the directory below precisely so the two are not confused —
 * one is policy the model cannot opt out of, the other is a default it can.
 */
const ALWAYS_SKIPPED = [".git"] as const;

/**
 * Skipped by a walk unless the caller names it.
 *
 * The dependency tree is *present and readable* — the workspace holds it the
 * same way it holds the source — so this is about what a walk is for rather than
 * about access. A real tree runs to tens of thousands of files and sorts before
 * `src`, so a walk that descended into it would spend its page there.
 *
 * Naming it as the root is the opt-in, and it has to exist: a search pointed at
 * a dependency that then skipped that dependency would match nothing and report
 * everything skipped, which is the kind of answer that sends a model looking for
 * a bug that is not there.
 */
const SKIPPED_UNLESS_NAMED = ["node_modules"] as const;

/**
 * What a walk rooted at `root` steps over.
 *
 * Filtering happens on the results rather than in the traversal, because the
 * workspace filesystem takes no exclusion — `find` offers a limit and an offset,
 * `grep` a positive `include` glob, and neither can be told to stay out of a
 * directory. So a walk still *pays* for what it skips, and a page landing
 * entirely inside one reports itself as crowded rather than as empty; the cheap
 * answer to that is a narrower `path`, `pattern` or `include`, which is what
 * those messages offer.
 */
export function walkSkips(root: string): readonly string[] {
  return [
    ...ALWAYS_SKIPPED,
    ...SKIPPED_UNLESS_NAMED.filter((segment) => !hasSegment(root, segment))
  ];
}

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
  return undefined;
}
