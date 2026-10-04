/**
 * Which paths these tools act on, and the sentence a refused one gets.
 *
 * Each refused directory is also skipped by every walk, though the walk steps
 * over more than it refuses — see {@link WALK_SKIPS}. `.git` is refused as
 * policy: a model that edits `.git/HEAD` corrupts a checkout in a way that
 * surfaces much later. `node_modules` is refused as a fact: it lives on the
 * container's disk (see `../workspace/container-deps.ts`), so these tools, which read
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
 * Where a session's own state lives inside a workspace, as a directory name.
 *
 * A host that wants a Claude Code session's transcript to outlive its container
 * points `CLAUDE_CONFIG_DIR` at a directory of this name in the workspace, which
 * is the Durable Object's storage — so the conversation survives the container
 * being stopped and a later session can continue it.
 *
 * **Named here rather than in the plugin that sets the variable**, because the
 * module that has to step over it is the walk below, and the dependency cannot
 * run the other way: `/computer` reaching into `/claude-code` would pull a whole
 * plugin into every agent that installs the file tools, which
 * `verify:exports` refuses. A host configuring a session reads the name from
 * here; the `claude-code` plugin points at it in prose and imports nothing.
 */
export const SESSION_STATE_DIR = ".claude-sessions";

/**
 * What every walk steps over, as directory names. Both the workspace's `glob`
 * and the `grep` tool hand these to the store as `**\/<name>` exclusions, which
 * prunes them: no directory named here is descended into, so none costs a read.
 *
 * {@link SESSION_STATE_DIR} is here for a reason the refused directories do not
 * share: a transcript is a verbatim record of everything a session read, so a
 * walk that descended into it would answer a `grep` for a line of source with
 * the session that quoted it.
 */
export const WALK_SKIPS = [".git", "node_modules", SESSION_STATE_DIR] as const;

/** The sentence a `node_modules` path gets. */
function dependencyTreeNote(path: string, verb: string): string {
  return (
    `${path} is inside node_modules, which lives on the container's disk rather ` +
    `than in the workspace ${verb} works on. Use bash there — ` +
    `\`cat\`, \`ls\`, \`rg\`.`
  );
}

/**
 * The sentence a `.git` path gets.
 *
 * Names a route deliberately: a refusal with no destination is worse than no
 * refusal, because the model retries and then works around it.
 *
 * What it must never name is `bash`. That hands back the exact capability
 * being withheld, in the one place the model is already looking for a way around
 * it, with the tool's own authority behind it. `bash` is unguarded because a
 * shell takes an opaque command string and pattern-matching git out of one is
 * neither reliable nor this guard's job — a fact about the implementation, not a
 * route to advertise.
 */
function gitInternalNote(path: string, verb: string): string {
  return (
    `${path} is inside .git — git's internal state, which ${verb} does not touch. ` +
    `Reading it tells you less than the repository tools do, and writing it ` +
    `corrupts the checkout. Repository work goes through the repo tools ` +
    `(\`repo_status\`, \`repo_diff\`, \`repo_commit\`, \`repo_push\`). If this ` +
    `task needs git state you cannot get that way, say so in your result rather ` +
    `than reaching into .git yourself.`
  );
}

/**
 * The path check every file tool and every workspace call makes, before it
 * opens anything.
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
 * It is not containment, and this is the only place worth saying so. An agent
 * that can write files here almost always holds `bash` too, which reads and
 * writes `.git` directly.
 *
 * Symlinks are not resolved, for the same reason: a tracked
 * `docs/notes.md -> ../.git/config` only matters to an agent given these tools
 * *without* the shell. A read-only install — `restrictTools` down to `grep`,
 * with Think's writing tools left out — is that agent, and it cannot write. If a writing agent
 * without the shell ever exists, the **write** path is the half to restore —
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
