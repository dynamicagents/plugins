import {
  attachRun,
  freshCursor,
  isExecBusy,
  READ_ONLY_LAUNCH,
  type SessionRuntime
} from "./run.js";

/**
 * The throwaway copy a reading session works in.
 *
 * A reading session shares its parent's container, because that container
 * already holds the checkout and its dependency trees — so a reading run
 * costs no clone, no install and no container of its own. What it must not share
 * is the **tree**: the parent's tools and every other reading session read that
 * checkout at the same time, and the container's edits under the workspace mount
 * are synced back into the Durable Object. A session writing there would
 * overwrite what everyone else sees, and persist it.
 *
 * Skipping the sync cannot fix that, because the write is visible through the
 * FUSE view the moment it lands. So each reading session gets its own copy **on
 * container disk**, outside the workspace mount, where nothing syncs and nothing
 * else looks. It may then do anything at all — install, build, run the suite —
 * and all of it is deleted when the session ends. No permission mode is asked to
 * hold that line; see {@link file://./index.ts claudeCodeRead}.
 *
 * **A working directory is not a boundary on its own.** The session runs as root,
 * and its brief may name the original by absolute path — so it is launched in a
 * mount namespace in which everything under the workspace mount is read-only:
 * reads of the original still work, a write fails there instead of landing. See
 * `READ_ONLY_LAUNCH` in `./run.ts`. A container that refuses the namespace runs
 * the session with the copy as its working directory only, and says so in the
 * log and in the brief.
 *
 * What the copy holds:
 *
 * - **A git checkout** is recreated rather than copied: a fresh repository whose
 *   objects come from the parent's through `alternates`, so nothing is copied but
 *   the working tree, with the parent's branches, remote-tracking refs and tags,
 *   on the parent's branch, with the parent's uncommitted changes to tracked
 *   files applied. Its refs are its own, so a session that moves a branch moves
 *   nobody else's. Every populated submodule gets the same, at the commit the
 *   parent has checked out. Files git does not track are not carried.
 * - **Anything else** — a scratchpad — is copied, `node_modules` excepted.
 * - **Dependency trees** are overlays: the parent's tree underneath, this copy's
 *   writes on top. A kernel that refuses the overlay leaves the tree absent
 *   rather than shared, and the session is told to install its own.
 */

/**
 * Where every copy lives: container disk, never under the workspace mount.
 *
 * `/var/tmp` because the workspace mount is `/workspace` in every image this
 * plugin runs in, and anything written under it is synced back into the Durable
 * Object — the one thing a copy exists to avoid.
 */
export const COPY_ROOT = "/var/tmp/claude-read";

/**
 * The workspace mount, which a reading session sees read-only.
 *
 * The same `/workspace` {@link COPY_ROOT} is kept out of: it holds the original
 * and every other checkout this container serves.
 */
export const WORKSPACE_MOUNT = "/workspace";

/**
 * The copy one session works in: a pure function of its exec id.
 *
 * Derived rather than stored, so `stop` can close the copy of a session whose
 * drain nobody is holding, and a recovered turn finds the copy the first attempt
 * made instead of building a second one.
 */
export function copyDirFor(execId: string): string {
  return `${COPY_ROOT}/${execId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * How much older than the session ceiling a copy has to be before any open
 * sweeps it.
 *
 * A session cannot outlive `timeoutMs` — the container runtime enforces it — so a
 * copy older than that belongs to a session that has ended. The margin covers a
 * copy made just before a turn was cut and started on once it was recovered.
 */
const SWEEP_MARGIN_MIN = 15;

/**
 * The most a session may write into the dependency trees when their overlays
 * have to live in memory.
 *
 * Only when the root filesystem refuses them — an overlay's upper layer cannot be
 * another overlay. What lands there is what the session writes into a tree, a
 * test runner's cache in the ordinary case, and the parent's tree underneath is
 * not counted. A full reinstall does not fit, and fails with the disk full
 * rather than exhausting the container's memory.
 */
const UPPER_MAX = "512m";

/**
 * Unmount everything under a directory, deepest first, then delete it.
 *
 * Lazily if a mount is busy — a session being stopped may not have exited yet —
 * and **never deletes through a mount that is still attached**. Every mount a copy
 * holds is an overlay, whose writes land in the copy's own upper directory, but
 * that is a property of this file rather than of `rm`, and the lower directory is
 * the parent's dependency tree.
 */
const CLOSE_FN = `close_copy() {
  for m in $(awk -v p="$1/" 'index($2, p) == 1 { print $2 }' /proc/mounts | sort -r); do
    umount "$m" 2>/dev/null || umount -l "$m" 2>/dev/null || true
  done
  if awk -v p="$1/" 'index($2, p) == 1 { found = 1 } END { exit !found }' /proc/mounts; then
    echo "claude-read: $1 still has a mount attached; left in place" >&2
    return 1
  fi
  rm -rf "$1"
}`;

/**
 * Build one copy, or reuse the one a previous attempt finished.
 *
 * Everything reaches the script through the environment and nothing is
 * interpolated into it, so no path can become shell. It prints `deps=<n>/<m>`:
 * how many of the parent's dependency trees were overlaid, of how many there
 * were.
 *
 * Exported for the specs, which cannot run a shell inside workerd and so check
 * its shape instead.
 */
export const OPEN_SCRIPT = `set -u
${CLOSE_FN}

# The objects directory a checkout reads from — its own, or the superproject's
# modules directory for a submodule whose .git is a file.
objects_of() {
  common=$(cd "$1" && cd "$(git rev-parse --git-common-dir)" && pwd) || return 1
  echo "$common/objects"
}

# A repository at $2 with $1's refs, objects borrowed from $1, on $1's branch.
recreate() {
  from=$1
  to=$2
  git init --quiet "$to" || return 1
  objects_of "$from" > "$to/.git/objects/info/alternates" || return 1
  git -C "$to" fetch --quiet --no-tags --update-head-ok "$from" \\
    '+refs/heads/*:refs/heads/*' '+refs/remotes/*:refs/remotes/*' \\
    '+refs/tags/*:refs/tags/*' || return 1
  url=$(git -C "$from" remote get-url origin 2>/dev/null || true)
  if [ -n "$url" ]; then git -C "$to" remote add origin "$url"; fi
  branch=$(git -C "$from" symbolic-ref -q --short HEAD || true)
  if [ -n "$branch" ]; then
    git -C "$to" checkout --quiet "$branch" || return 1
    up=$(git -C "$from" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
    if [ -n "$up" ]; then git -C "$to" branch --quiet --set-upstream-to="$up" >/dev/null 2>&1 || true; fi
  else
    git -C "$to" checkout --quiet --detach "$(git -C "$from" rev-parse HEAD)" || return 1
  fi
  # What the parent has changed and not committed, staged or not. Submodules are
  # each recreated at their own HEAD, so their pointers are not this diff's.
  if ! git -C "$from" diff --quiet --ignore-submodules=all HEAD 2>/dev/null; then
    git -C "$from" diff --binary --ignore-submodules=all HEAD |
      git -C "$to" apply --binary --whitespace=nowarn || return 1
  fi
}

# Sessions end by the container runtime's ceiling, so a copy past it is nobody's.
if [ -d "$COPY_ROOT" ]; then
  find "$COPY_ROOT" -mindepth 1 -maxdepth 1 -type d -mmin +"$STALE_MIN" |
    while IFS= read -r old; do
      [ "$old" = "$COPY" ] || close_copy "$old" || true
    done
fi

if [ -f "$COPY/.ready" ]; then
  cat "$COPY/.ready"
  exit 0
fi
# A half-built copy from an attempt that died is rebuilt, not trusted.
if [ -e "$COPY" ]; then close_copy "$COPY" || exit 1; fi

tree="$COPY/tree"
mkdir -p "$COPY/.overlay" || exit 1

if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  recreate "$SRC" "$tree" || exit 1
  # Parents before their own submodules, which is the order foreach visits them.
  # Read from a file rather than a pipe, so an \`exit\` in the loop ends the script.
  git -C "$SRC" submodule foreach --quiet --recursive 'printf "%s\\n" "$displaypath"' \\
    > "$COPY/.submodules" || exit 1
  while IFS= read -r sub; do
    recreate "$SRC/$sub" "$tree/$sub" || exit 1
  done < "$COPY/.submodules"
else
  mkdir -p "$tree" || exit 1
  tar -C "$SRC" --exclude=node_modules -cf - . | tar -C "$tree" -xf - || exit 1
fi

# One dependency tree, overlaid: $1 underneath, writes in $COPY/.overlay/$3.
lay() {
  mkdir -p "$2" "$COPY/.overlay/$3/upper" "$COPY/.overlay/$3/work" &&
    mount -t overlay overlay \\
      -o "lowerdir=$1,upperdir=$COPY/.overlay/$3/upper,workdir=$COPY/.overlay/$3/work" \\
      "$2" 2>"$COPY/.refused"
}

found=0
laid=0
upper=disk
for lower in $(awk -v p="$SRC/" 'index($2, p) == 1 && $2 ~ /\\/node_modules$/ { print $2 }' /proc/mounts | sort -u); do
  target="$tree/\${lower#"$SRC"/}"
  # A package root the copy does not have — one git does not track.
  [ -d "$(dirname "$target")" ] || continue
  found=$((found + 1))
  if lay "$lower" "$target" "$found"; then
    laid=$((laid + 1))
  # A root filesystem that is itself an overlay cannot hold an overlay's upper
  # layer. Memory can, and holds only what the session writes into a tree —
  # bounded, so a reinstall fails here rather than exhausting the container.
  elif [ "$upper" = disk ] &&
    mount -t tmpfs -o "size=$UPPER_MAX" claude-read "$COPY/.overlay" 2>>"$COPY/.refused" &&
    upper=memory && lay "$lower" "$target" "$found"; then
    laid=$((laid + 1))
  else
    echo "claude-read: overlay refused for $lower: $(cat "$COPY/.refused")" >&2
  fi
done

# Whether the session can be launched with the original read-only: the script
# the launch runs, asked whether the original is still writable afterwards. A
# workspace that is not a mount of its own would pass the remount and protect
# nothing, so the question is the tree, not the command.
if CLAUDE_READ_ONLY="$WORKSPACE" unshare --mount --propagation private -- \\
  sh -c "$READ_ONLY_LAUNCH" sh test ! -w "$SRC" 2>"$COPY/.refused"; then
  isolated=yes
else
  isolated=no
  echo "claude-read: no read-only namespace: $(cat "$COPY/.refused")" >&2
fi

printf 'tree=%s\\ndeps=%s/%s\\nupper=%s\\nisolated=%s\\n' \\
  "$tree" "$laid" "$found" "$upper" "$isolated" > "$COPY/.ready"
cat "$COPY/.ready"
`;

/** Delete one copy. Exported for the same reason as {@link OPEN_SCRIPT}. */
export const CLOSE_SCRIPT = `${CLOSE_FN}
if [ -e "$COPY" ]; then close_copy "$COPY"; fi
`;

/** What {@link openCopy} built. */
export interface ReadingCopy {
  /** Where the session runs — the copy of the parent's checkout. */
  dir: string;
  /** The checkout it copies, which the session may name by absolute path. */
  source: string;
  /** The parent's dependency trees, and how many of them the copy could overlay. */
  deps: { found: number; laid: number };
  /** Whether the session can be launched with the workspace read-only. */
  isolated: boolean;
}

/** Run a short script in the container to completion, bounded by `timeoutMs`. */
async function runScript(
  runtime: SessionRuntime,
  id: string,
  source: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  let handle: Awaited<ReturnType<SessionRuntime["exec"]>>;
  try {
    handle = await runtime.exec(source, {
      id,
      cwd: "/",
      encoding: "utf8",
      env,
      timeoutMs
    });
  } catch (err) {
    // A turn cut before it finished left it running. Waiting for that one is
    // the only safe answer: two of these building one copy would each delete
    // what the other is making.
    if (!isExecBusy(err)) throw err;
    handle = await attachRun(runtime, freshCursor(id));
  }
  using attached = handle;
  const reader = attached.getReader();
  let stdout = "";
  let stderr = "";
  let code = -1;
  const consume = (event: { name: string; value?: string; code?: number }) => {
    if (event.name === "stdout" && event.value) stdout += event.value;
    if (event.name === "stderr" && event.value) stderr += event.value;
    if (event.name === "exit") code = event.code ?? -1;
  };
  try {
    // To the end of the stream, not to the `exit` event: see `drainRun` for why
    // a stream left unread is a sync that never ran.
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      consume(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { code, stdout, stderr };
}

/**
 * Make the copy one reading session works in, and say where it is.
 *
 * Idempotent: a recovered turn gets the copy the first attempt finished, and one
 * the first attempt left half-built is rebuilt. Throws when no copy can be made —
 * the session must not fall back to the parent's tree, which is the one thing
 * this exists to prevent.
 */
export async function openCopy(
  runtime: SessionRuntime,
  options: { execId: string; source: string; timeoutMs: number }
): Promise<ReadingCopy> {
  const copy = copyDirFor(options.execId);
  const source = options.source.replace(/\/+$/, "");
  const ran = await runScript(
    runtime,
    `${options.execId}:copy`,
    OPEN_SCRIPT,
    {
      SRC: source,
      COPY: copy,
      COPY_ROOT,
      WORKSPACE: WORKSPACE_MOUNT,
      READ_ONLY_LAUNCH,
      STALE_MIN: String(
        Math.ceil(options.timeoutMs / 60_000) + SWEEP_MARGIN_MIN
      ),
      UPPER_MAX
    },
    options.timeoutMs
  );
  const dir = /^tree=(.+)$/m.exec(ran.stdout)?.[1];
  const deps = /^deps=(\d+)\/(\d+)$/m.exec(ran.stdout);
  const upper = /^upper=(\w+)$/m.exec(ran.stdout)?.[1];
  const isolated = /^isolated=yes$/m.test(ran.stdout);
  if (ran.code !== 0 || !dir || !deps) {
    throw new Error(
      `claude-code: could not make a copy of ${options.source} for a reading ` +
        `session (exit ${ran.code}): ${ran.stderr.trim() || ran.stdout.trim() || "no output"}`
    );
  }
  const result: ReadingCopy = {
    dir,
    source,
    deps: { laid: Number(deps[1]), found: Number(deps[2]) },
    isolated
  };
  // Which way the dependency trees went is the fact about a copy worth
  // watching: a kernel that refuses overlays turns every reading session into
  // one that installs its own, and `upper` says whether their writes went to
  // disk or had to go to memory.
  // `isolated: false` is the one worth alerting on: that session can write the
  // original through an absolute path, and only its brief asks it not to.
  (isolated ? console.info : console.warn)("[claude-code] reading copy ready", {
    execId: options.execId,
    ...result.deps,
    upper,
    isolated,
    ...(ran.stderr.trim() ? { stderr: ran.stderr.trim().slice(0, 500) } : {})
  });
  return result;
}

/**
 * Delete a session's copy. A no-op when it has none.
 *
 * Best-effort, and it must be: it runs on the way out of a session that has
 * already finished or been stopped, and a copy that cannot be removed is swept by
 * the next {@link openCopy} in this container — or goes with the container.
 */
export async function closeCopy(
  runtime: SessionRuntime,
  execId: string
): Promise<void> {
  try {
    const ran = await runScript(
      runtime,
      `${execId}:uncopy`,
      CLOSE_SCRIPT,
      { COPY: copyDirFor(execId) },
      60_000
    );
    if (ran.code !== 0) {
      console.warn("[claude-code] could not remove a reading copy", {
        execId,
        stderr: ran.stderr.trim().slice(0, 500)
      });
    }
  } catch (err) {
    console.warn("[claude-code] could not remove a reading copy", {
      execId,
      err: String(err)
    });
  }
}

/**
 * What a reading session is told about where it is.
 *
 * Appended to its brief by this plugin rather than left to a host, because the
 * copy is this plugin's guarantee and the session has to know two things about it
 * to use it well: it can run anything, and nothing it changes survives — so its
 * final message is the whole deliverable.
 */
export function copyNote(copy: ReadingCopy): string {
  const { deps } = copy;
  const lines = [
    "## You are working in a throwaway copy",
    "",
    `Your working directory, \`${copy.dir}\`, is a private copy of \`${copy.source}\`,`,
    "made for this task alone. Run whatever helps — tests, builds, installs,",
    "registry queries. Nothing you change here reaches the original or any other",
    "session, and all of it is deleted when you finish, so there is nothing to",
    "commit, push or clean up.",
    "",
    copy.isolated
      ? `\`${copy.source}\` itself is read-only to you. Where your brief names a path under it, use the same path under \`${copy.dir}\`.`
      : `**Do not write under \`${copy.source}\`** — it is the original, and other sessions are reading it. Where your brief names a path under it, use the same path under \`${copy.dir}\`.`,
    "",
    "**Your final message is the whole of what you deliver.** Anything you edit is",
    "discarded, so put what you found in that message."
  ];
  if (deps.found > deps.laid) {
    lines.push(
      "",
      deps.laid === 0
        ? "The dependency trees were not carried into this copy. Install them here if you need them."
        : "Some dependency trees were not carried into this copy. Install them where you need them."
    );
  }
  return lines.join("\n");
}
