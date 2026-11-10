import { isBranchName, sameRepoUrl } from "../repo-github/url.js";
import {
  sandboxRepoGit,
  type SandboxGitHost
} from "../repo-github/sandbox-git.js";
import { sessionAdvisory, type SandboxAdvisory } from "../sandbox/advisory.js";
import { sandboxName } from "../sandbox/name.js";
import type { SnapshotSeed } from "../sandbox/object.js";
import {
  claim,
  workingOn,
  parseWorktreeRepo,
  worktreeRepo,
  type PoolRepo,
  type PoolStore,
  type Worktree
} from "./pool.js";
import {
  placementRepo,
  selectedRepo,
  type WorktreeCheckout,
  type WorktreeSelection
} from "./selection.js";
import { populated, readSubmodules, submoduleCloneUrl } from "./submodules.js";

/**
 * Where a writing session works, and what becomes of it afterwards.
 *
 * **Which sandbox, how it comes to hold the right checkout on the right
 * branch, and what is kept when the session ends.** A host's sub-agent
 * `prepare` and `settle` are what call it; which sub-agents get a worktree, and
 * what they do in it, are the host's.
 *
 * The sandbox is a worktree from `./pool.ts`, and it is **kept**: the branch and
 * its commits stay in it for the parent to switch into (see `./switch.ts`) and
 * push. Nothing here pushes.
 */

/**
 * The sentences a host says in its own terms: each tells the delegating model
 * which call to make next, so each names the host's tools and their inputs,
 * which this module does not know. Every other refusal here is about the
 * worktree, and is this module's.
 *
 * No defaults, for that reason. A refusal is `<label>: <sentence>`.
 */
export interface WorktreeCopy {
  /**
   * A session asked for in a sandbox with nothing checked out. The sandbox's
   * own advisory follows it when it has one: a sandbox that is full, or whose
   * install broke, is not one somebody forgot to clone into.
   */
  noCheckout: string;
  /** New work named a branch a worktree already holds. */
  held(branch: string): string;
  /** A branch to continue that no worktree holds and no remote has. */
  neverPushed(branch: string): string;
  /**
   * Where a run that did not complete left its work, for the delegating model.
   * `wip` when what it had not committed was committed for it.
   */
  kept(branch: string, wip: boolean): string;
  /**
   * How to put a session back on a branch, after a sentence about where that
   * branch is: see `./switch.ts`.
   */
  resume: string;
}

/**
 * Put each repository listed on the worktree's branch, and say where it started.
 *
 * One line in per repository — path, then the commit to start from — and one
 * out: path, base, start, and what the remote has of the branch. Paths reach the
 * script as values, never as command text.
 *
 * - `new` starts the branch at the base, discarding whatever the worktree held
 *   before: that was pushed, or released, or it would not have been free. It
 *   refuses a name the remote already has, the default branch included: work
 *   started beside that branch could never be pushed onto it.
 * - `continue` keeps the branch this worktree already holds, and only a
 *   repository that lacks it — a submodule added since — starts one at its base.
 * - `adopt` takes the branch from the remote where it is there — a session's
 *   pushed branch, or the head of a pull request somebody else opened.
 *
 * `continue` and `adopt` refuse a repository's default branch, read from the
 * `origin/HEAD` the fetch before this wrote: a session's commits there could
 * only reach a pull request under another name, and `/repo-github` refuses the
 * push.
 *
 * `-f` and `clean -x` because nothing uncommitted in a worktree is kept, and
 * `-e node_modules` because the dependency tree is the checkout's, kept with it
 * so a session does not wait on a full install. `@pinned` is the commit the superproject records for a submodule that
 * declares no branch, read after the superproject is on its own.
 */
const PUT_ON_BRANCH = `tab="$(printf '\\t')"
while IFS="$tab" read -r path base; do
  [ -n "$path" ] || continue
  if [ "$WORKTREE_MODE" != new ] && [ "$(git -C "$path" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null)" = "origin/$WORKTREE_BRANCH" ]; then
    echo "$WORKTREE_BRANCH is the default branch of the repository at $path — work goes on a branch a pull request proposes, never onto the one it is proposed against" >&2; exit 1
  fi
  if [ "$WORKTREE_MODE" = new ] && git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" >/dev/null; then
    echo "$WORKTREE_BRANCH is already on the remote of the repository at $path — continue it to add to it, or name another branch for new work" >&2; exit 1
  fi
  if [ "$base" = "@pinned" ]; then
    base="$(git rev-parse "HEAD:$path")" || { echo "the superproject records no commit for $path" >&2; exit 1; }
  fi
  target="$base"
  case "$WORKTREE_MODE" in
    continue)
      if git -C "$path" rev-parse --verify --quiet "refs/heads/$WORKTREE_BRANCH" >/dev/null; then
        target=""
        git -C "$path" checkout -f -q "$WORKTREE_BRANCH" || exit 1
      fi ;;
    adopt)
      if git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" >/dev/null; then
        target="origin/$WORKTREE_BRANCH"
      fi ;;
  esac
  if [ -n "$target" ]; then
    git -C "$path" rev-parse --verify --quiet "$target^{commit}" >/dev/null || { echo "$path has no $target — it is not on the remote" >&2; exit 1; }
    git -C "$path" checkout -f -q -B "$WORKTREE_BRANCH" "$target" || exit 1
  fi
  git -C "$path" clean -ffdxq -e node_modules || exit 1
  if [ -n "$WORKTREE_PREVIOUS" ] && [ "$WORKTREE_PREVIOUS" != "$WORKTREE_BRANCH" ]; then
    git -C "$path" branch -D -q "$WORKTREE_PREVIOUS" >/dev/null 2>&1 || true
  fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$path" "$(git -C "$path" rev-parse "$base^{commit}")" "$(git -C "$path" rev-parse HEAD)" "$(git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" || true)"
done <<EOF
$WORKTREE_REPOS
EOF`;

/**
 * Each listed repository's HEAD, and the last commit pushed on its branch —
 * nothing where either cannot be read. A session pushes its own branch, and
 * git records the push in the remote-tracking ref this reads.
 */
const READ_TIPS = `while IFS= read -r path; do
  [ -n "$path" ] || continue
  printf '%s\\t%s\\t%s\\n' "$path" "$(git -C "$path" rev-parse HEAD 2>/dev/null)" "$(git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$WORKTREE_BRANCH" 2>/dev/null)"
done <<EOF
$WORKTREE_PATHS
EOF`;

/** See {@link KEEP_INTERRUPTED}. */
const KEEP_WAIT_SECONDS = 30;

/** The commit {@link KEEP_INTERRUPTED} makes, as a person reading the log sees it. */
const WIP_MESSAGE =
  "WIP: interrupted session\n\n" +
  "What the session had not committed when its run stopped, committed by the " +
  "host so it is not lost. It may be half-finished: check it before building on it.";

/**
 * Commit what an interrupted session left uncommitted, in each repository listed,
 * and say where each one's branch now is — path, HEAD, and `wip` where this
 * committed. Every repository is reported even when one fails, and the command
 * fails after: a commit the session made is still there to name when the one
 * made for it could not be.
 *
 * **Waits for the session's processes to leave the worktree first**, because
 * `stopSession` delivers `SIGTERM` and returns: a commit taken while the session
 * is still unwinding races its last writes, and a lock it held is not yet stale.
 * Only once nothing is left does an `index.lock` mean a git process that died,
 * which is when it is safe to remove. Run from `/` so this command's own shell is
 * not one of the processes it waits for. The bound is a ceiling for something
 * the session started that outlives it — a server — not a measurement; past it
 * the commit goes ahead around whatever is still running.
 *
 * `--no-verify`, because a hook that refuses a half-finished tree would lose the
 * tree. Submodule pointers are left out of the superproject's commit — moving a
 * pin is a decision, and the continuing session places each submodule on the
 * branch by itself — and so is any `node_modules`, which `.gitignore` may not
 * name.
 */
const KEEP_INTERRUPTED = `waited=0
busy=""
failed=""
while [ "$waited" -lt ${KEEP_WAIT_SECONDS} ]; do
  busy=""
  for p in /proc/[0-9]*; do
    case "$(readlink "$p/cwd" 2>/dev/null)" in
      "$WORKTREE_DIR"|"$WORKTREE_DIR"/*) busy=1; break ;;
    esac
  done
  [ -z "$busy" ] && break
  sleep 1
  waited=$((waited + 1))
done
while IFS= read -r path; do
  [ -n "$path" ] || continue
  repo="$WORKTREE_DIR/$path"
  [ -n "$busy" ] || rm -f "$repo/.git/index.lock"
  set -- . ':(exclude,glob)**/node_modules/**'
  if [ "$path" = "." ]; then
    while IFS= read -r sub; do
      [ -n "$sub" ] && set -- "$@" ":(exclude)$sub"
    done <<SUBS
$WORKTREE_KEEP_SUBMODULES
SUBS
  fi
  wip=""
  if ! git -C "$repo" add -A -- "$@"; then
    failed=1
  elif ! git -C "$repo" diff --cached --quiet; then
    if git -C "$repo" commit --no-verify -q -m "$WIP_MESSAGE"; then
      wip="wip"
    else
      failed=1
    fi
  fi
  printf '%s\t%s\t%s\n' "$path" "$(git -C "$repo" rev-parse HEAD)" "$wip"
done <<EOF
$WORKTREE_KEEP_PATHS
EOF
[ -z "$failed" ]`;

/** What {@link PUT_ON_BRANCH} reports for one repository. */
interface Placed {
  path: string;
  base: string;
  start: string;
  pushed?: string;
}

function parsePlaced(out: string): Placed[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path = "", base = "", start = "", pushed = ""] = line.split("\t");
      return { path, base, start, ...(pushed ? { pushed } : {}) };
    });
}

/** One sub-agent run, as the pool knows it. */
export interface RunRef {
  taskId: string;
  runId: string;
}

/** Where a session runs, as its `prepare` hands it to the sub-agent. */
export interface SessionPlace {
  workspaceName: string;
  /** The checkout, as the workspace recorded it. */
  dir: string;
  /** A writing session's branch, when it works in a worktree of its own. */
  branch?: string;
  /** Whether that branch already holds earlier work. */
  continues?: boolean;
  /** The worktree it was placed in, for a later run to ask for it by `near`. */
  slot?: { repo: string; slot: number };
}

/** What keeping a run's work found. */
export interface KeptWork {
  /** Where the work is, for the delegating model — nothing when it did nothing. */
  note?: string;
  /**
   * Whether the session stopped and nothing it left is uncommitted. Until both
   * hold, the worktree may be the only copy of an edit, or still be written to,
   * so it is held whatever its tips read: see {@link SubtaskWorkspaces.release}.
   */
  settled: boolean;
}

export interface SubtaskWorkspaces {
  /**
   * Claim a worktree, put it on the run's branch, and answer where it is. A
   * scratchpad is the parent's own, and answers that.
   */
  resolve(
    ctx: RunRef & {
      continue?: string;
      branch?: string;
      /**
       * The worktree to place it in when that one is free — where a
       * conversation it continues was recorded. See `claim` in `./pool.ts`.
       */
      near?: { repo: string; slot: number };
      /**
       * The branches a revising session works on, which it checks out itself:
       * held by its claim, so no other session takes them while it runs.
       */
      revising?: readonly string[];
    }
  ): Promise<SessionPlace>;
  /** Whether a live session holds `branch` in the placement root's pool, or is revising it. */
  working(branch: string): boolean;
  /**
   * The run is over: record where it left each repository and free it. `hold`
   * keeps it from the next session whatever its tips read — a run whose work
   * {@link keep} could not secure — until a push says otherwise.
   * `forgetBranch` frees it without its branch, for a run that never meant to
   * commit on one: a planning session's branch is no work to review. Only when
   * its tips read clean, though — one that could not be read, or holds a
   * commit, is held on its branch like any other.
   *
   * `follow` points the parent's reads at the worktree once it is released on
   * its branch — the work the parent is about to hear of — unless the parent
   * has moved to another repository since, which it chose.
   */
  release(
    ctx: RunRef,
    options?: { hold?: boolean; forgetBranch?: boolean; follow?: boolean }
  ): Promise<void>;
  /**
   * The run ended without completing — failed or canceled: stop it and keep
   * what it did, answering where, and whether that is secured.
   */
  keep(ctx: RunRef): Promise<KeptWork>;
  /**
   * Free every worktree still claimed for a task that has ended. A claim whose
   * run never started — the turn was cut between the two — has no `settle` to
   * free it, and a claim left live is passed over for good.
   */
  releaseTask(taskId: string): Promise<void>;
}

/** The sandbox RPCs a worktree is prepared, kept and released through. */
export interface WorktreeHost extends SandboxGitHost {
  noteCheckout(record: {
    dir: string;
    kind: "repo";
    repo?: string;
  }): Promise<{ present: boolean }>;
  checkoutDir(): Promise<string | undefined>;
  advisories(): Promise<readonly SandboxAdvisory[]>;
  snapshotRecord(): Promise<SnapshotSeed | undefined>;
  seedFrom(seed: SnapshotSeed): Promise<{ seeded: boolean; reason?: string }>;
  release(): Promise<{ released: boolean; reason?: string }>;
  startInstall(target: {
    dir: string;
    repo?: string;
  }): Promise<{ state: string }>;
}

export function subtaskWorkspaces(config: {
  binding: DurableObjectNamespace<WorktreeHost & Rpc.DurableObjectBranded>;
  /** The verified caller. */
  callerKey: () => string;
  /**
   * Run a command in a named workspace's container.
   *
   * Takes the name per call rather than closing over one: every other `exec` in
   * this Worker is bound to the workspace its agent is working in, and this one is
   * deliberately not — it addresses whichever worktree is being prepared.
   */
  exec: (
    command: string,
    options: { cwd: string; env?: Record<string, string> },
    workspace: string
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  /** Stop a run's session in a workspace, before what it left is committed. */
  stopSession: (workspace: string, runId: string) => Promise<void>;
  /**
   * Refuse a session by throwing, handed the workspace it would run in. Asked
   * before anything reaches that workspace's container, a writer's clone
   * included.
   */
  admit: (workspace: string) => Promise<void>;
  /** The parent's selection: where a session is placed from, and the reads it moves. */
  active: WorktreeSelection;
  pool: PoolStore;
  /**
   * The host's name: it prefixes every refusal and log line, and names the
   * branch a session starts when the caller named none (see `runBranch`).
   */
  label: string;
  copy: WorktreeCopy;
  now?: () => number;
}): SubtaskWorkspaces {
  const terms = { label: config.label, held: config.copy.held };
  const refuse = (sentence: string) =>
    new Error(`${config.label}: ${sentence}`);
  const now = config.now ?? Date.now;
  const nameOf = (worktree: Worktree) =>
    sandboxName(config.callerKey(), worktreeRepo(worktree.repo, worktree.slot));
  const stubFor = (name: string) => config.binding.getByName(name);
  /**
   * The row a run holds, whichever pool it is in: the parent may have moved to
   * another repository since the run was resolved.
   */
  const liveRow = (ctx: RunRef) =>
    config.pool
      .every()
      .find(
        (row) => row.live?.taskId === ctx.taskId && row.live.runId === ctx.runId
      );

  /**
   * The checkout a workspace recorded, or the sentence that refuses a session
   * with nothing to work on.
   *
   * The advisories are worth the extra RPC here: a refusal that names only the
   * ordering mistake is the wrong sentence for a workspace that is full, or
   * whose install broke, and neither is "you forgot to clone". Only on the way
   * to refusing, so a workspace with a checkout costs one RPC.
   */
  const checkoutIn = async (name: string): Promise<string> => {
    const stub = stubFor(name);
    const dir = await stub.checkoutDir();
    if (dir) return dir;
    const note = sessionAdvisory(await stub.advisories());
    throw refuse(config.copy.noCheckout + (note ? `\n\n${note}` : ""));
  };

  /**
   * Start a fresh worktree from the parent's last checkpoint — its checkout
   * and the dependencies installed into it, at the same path — and say whether
   * it took it. Only before the worktree's container has started, which reads
   * it: see `seedFrom` in `@dynamicagents/plugins/sandbox`. Never refuses a
   * session: a worktree without it clones and installs.
   */
  const seeded = async (parent: string, worktree: string): Promise<boolean> => {
    try {
      const record = await stubFor(parent).snapshotRecord();
      if (!record) return false;
      return (await stubFor(worktree).seedFrom(record)).seeded;
    } catch (err) {
      console.warn(
        `[${config.label}] could not start a worktree from the parent's checkout`,
        { worktree, err: String(err) }
      );
      return false;
    }
  };

  /** A session in a sandbox's own checkout: a scratchpad's. */
  const placeIn = async (name: string): Promise<SessionPlace> => {
    const dir = await checkoutIn(name);
    await config.admit(name);
    return { workspaceName: name, dir };
  };

  /**
   * Put a claimed worktree on its branch, in the superproject and every
   * submodule, and record where each repository started.
   *
   * **Every step runs again on a repeat and is idempotent**, because `ready` is
   * only set once the last one finished: a first attempt that cloned and then
   * failed at a submodule is completed, not mistaken for a finished one.
   */
  async function prepare(
    worktree: Worktree,
    checkout: WorktreeCheckout,
    name: string,
    parent: string
  ): Promise<Worktree> {
    const stub = stubFor(name);
    const run = (
      command: string,
      options: { cwd: string; env?: Record<string, string> }
    ) => config.exec(command, options, name);
    const host = new URL(checkout.url).hostname;
    const recorded = new Map(worktree.repos.map((repo) => [repo.path, repo]));
    let mode = worktree.mode ?? "new";

    const git = sandboxRepoGit(() => stub);

    // A worktree used before keeps its checkout on its own disk, the next start
    // restoring it; only a fresh one is filled.
    const reused = (await stub.checkoutDir()) !== undefined;
    if (!reused) {
      if (!/^\/[^/]+\/./.test(checkout.dir)) {
        throw refuse(
          `refusing to clear a checkout path that is not under a sandbox directory: ${checkout.dir}`
        );
      }
      /**
       * From the parent's checkpoint, where it can: the checkout with its
       * dependencies installed, at the same path, so neither a clone nor an
       * install stands in front of the session. A lock a checkpoint caught
       * mid-write would refuse every git that follows.
       */
      const fromParent =
        (await seeded(parent, name)) &&
        (
          await run(
            'test -d "$CHECKOUT_DIR/.git" && rm -f "$CHECKOUT_DIR/.git/index.lock"',
            { cwd: "/", env: { CHECKOUT_DIR: checkout.dir } }
          )
        ).success;
      if (!fromParent) {
        /**
         * A clone that failed part-way leaves a repository nobody recorded —
         * the clone initialises before it fetches — and a second clone into it
         * is refused with "git repository already exists", on every retry.
         * Nothing is worth keeping in a worktree with no recorded checkout, so
         * what is there is cleared first.
         */
        const cleared = await run('rm -rf "$CHECKOUT_DIR"', {
          cwd: "/",
          env: { CHECKOUT_DIR: checkout.dir }
        });
        if (!cleared.success) {
          throw refuse(
            `could not clear an unfinished clone in a worktree: ${cleared.stderr || cleared.stdout}`
          );
        }
        const cloned = await git.clone({
          url: checkout.url,
          dir: checkout.dir,
          branch: checkout.branch,
          // The host this checkout already came from, rather than the plugin's
          // whole allowlist: it passed that allowlist once, and narrowing to the
          // one host cannot refuse anything the parent was allowed.
          allowedHosts: [host]
        });
        if (!cloned.ok) {
          // The branch is named because the likeliest cause is one that exists
          // only in the parent's checkout — a worktree clones from the remote.
          throw refuse(
            `could not clone ${checkout.url} at ${checkout.branch} into a worktree: ${cloned.message}`
          );
        }
      }
      // A worktree whose sandbox went (reclaimed after its idle window) no
      // longer holds the branch it is recorded with. What the remote has of it
      // is all that is left. Recorded before the checkout is: a repeat finds the
      // checkout, and would otherwise take this worktree for one that holds the
      // branch, placing it at the base it was first given.
      if (mode === "continue") {
        mode = "adopt";
        config.pool.put({ ...worktree, mode });
      }
    }
    // Straight after the clone, so a repeat that fails later finds a recorded
    // checkout and does not clone over it — and before the install, which is
    // conditional where a checkout is not: a recorded checkout is what the
    // sandbox backs up and brings back.
    await stub.noteCheckout({
      dir: checkout.dir,
      kind: "repo",
      repo: worktree.repo
    });

    /**
     * A worktree held because what a stopped session left could not be
     * secured (its tips unknown: see `keep`) may hold the only copy of an
     * edit, and continuing it runs `checkout -f` and `clean`. So what is
     * uncommitted is committed first, and a worktree where that fails is not
     * placed at all.
     */
    if (
      reused &&
      mode === "continue" &&
      worktree.repos.some((repo) => repo.tip === "")
    ) {
      const paths = worktree.repos.map((repo) => repo.path);
      const secured = await run(KEEP_INTERRUPTED, {
        cwd: "/",
        env: {
          WORKTREE_DIR: worktree.dir ?? checkout.dir,
          WORKTREE_KEEP_PATHS: paths.join("\n"),
          WORKTREE_KEEP_SUBMODULES: paths
            .filter((path) => path !== ".")
            .join("\n"),
          WIP_MESSAGE
        }
      }).catch((err: unknown) => ({
        success: false,
        stdout: "",
        stderr: String(err)
      }));
      if (!secured.success) {
        throw refuse(
          `could not commit what an earlier session left uncommitted in the worktree holding ${worktree.branch}, so it was not touched: ${secured.stderr.trim() || secured.stdout.trim()}`
        );
      }
    }

    const fetch = async (url: string, dir: string, what: string) => {
      const fetched = await git.fetch({ url, dir, allowedHosts: [host] });
      if (!fetched.ok) {
        throw refuse(
          `could not fetch ${what} in a worktree: ${fetched.message}`
        );
      }
    };
    const place = async (
      rows: { path: string; base: string }[]
    ): Promise<Placed[]> => {
      if (rows.length === 0) return [];
      const placed = await run(PUT_ON_BRANCH, {
        cwd: checkout.dir,
        env: {
          WORKTREE_BRANCH: worktree.branch as string,
          WORKTREE_MODE: mode,
          WORKTREE_PREVIOUS: worktree.previous ?? "",
          WORKTREE_REPOS: rows
            .map((row) => `${row.path}\t${row.base}`)
            .join("\n")
        }
      });
      if (!placed.success) {
        throw refuse(
          `could not put a worktree on ${worktree.branch}: ${placed.stderr || placed.stdout}`
        );
      }
      return parsePlaced(placed.stdout);
    };
    /**
     * Where a repository's branch starts from. A branch being continued keeps
     * the base it was first given — the remote's branch has moved on since, and
     * measuring against where it is now would count other people's commits as
     * this branch's work.
     */
    const startFrom = (path: string, ref: string) =>
      mode === "continue" ? (recorded.get(path)?.base ?? ref) : ref;

    // The superproject first: which submodules there are, and which commit each
    // is pinned to, is what the branch it is now on says.
    await fetch(checkout.url, checkout.dir, "the superproject");
    const rootRef = `origin/${checkout.branch}`;
    const [root] = await place([{ path: ".", base: startFrom(".", rootRef) }]);

    /**
     * Every submodule, each cloned into this worktree with objects of its own.
     *
     * The superproject's clone leaves an empty directory at each gitlink —
     * a plain clone initialises no submodules — so a session asked to change one
     * would find nothing there. Each is cloned on its declared branch, which is
     * what the superproject's own sync would check out, and fetched in full so
     * the pinned commit of one that declares none is there too.
     */
    const submodules = await readSubmodules(run, checkout.dir);
    const present = await populated(run, checkout.dir, submodules);
    const refs = new Map<string, string>();
    for (const sub of submodules) {
      const url = submoduleCloneUrl(sub, checkout.url);
      const dir = `${checkout.dir}/${sub.path}`;
      /**
       * A clone of the repository `.gitmodules` named before. A fetch would
       * fill it from the new one, but its push still goes to its origin. A
       * worktree held on its branch may have work in it that belongs there,
       * so it is refused; any other has nothing worth keeping, and is cloned
       * again.
       */
      const origin = present.get(sub.path);
      if (origin !== undefined && !sameRepoUrl(origin, url)) {
        if (mode === "continue") {
          throw refuse(
            `the submodule at ${sub.path} in the worktree holding ${worktree.branch} was cloned from ${origin || "nowhere"}, and .gitmodules now names ${url}. Its pushes would go to the first: release the worktree once nothing in it is needed, and continue the branch again.`
          );
        }
        const cleared = await run('rm -rf -- "$SUBMODULE_DIR"', {
          cwd: checkout.dir,
          env: { SUBMODULE_DIR: sub.path }
        });
        if (!cleared.success) {
          throw refuse(
            `could not clear the submodule at ${sub.path}, cloned from ${origin}: ${cleared.stderr || cleared.stdout}`
          );
        }
        present.delete(sub.path);
      }
      // `.` means "the superproject's branch", in git's own reading of it.
      const branch = sub.branch === "." ? checkout.branch : sub.branch;
      refs.set(sub.path, branch ? `origin/${branch}` : "@pinned");
      if (!present.has(sub.path)) {
        const cloned = await git.clone({
          url,
          dir,
          allowedHosts: [host],
          ...(branch ? { branch } : {})
        });
        if (!cloned.ok) {
          throw refuse(
            `could not clone the submodule at ${sub.path}${branch ? ` on ${branch}` : ""}: ${cloned.message}`
          );
        }
      }
      await fetch(url, dir, `the submodule at ${sub.path}`);
    }
    const placedSubs = await place(
      submodules.map((sub) => ({
        path: sub.path,
        base: startFrom(sub.path, refs.get(sub.path) as string)
      }))
    );

    /**
     * An adopted branch has to be on the remote somewhere. A repository without
     * it starts from its base, which is right for one the branch never
     * changed — but a branch on the remote nowhere was never pushed, and
     * starting it from the base would report the earlier work as there when it
     * went with the worktree that held it.
     */
    if (
      mode === "adopt" &&
      ![root, ...placedSubs].some((placed) => placed?.pushed)
    ) {
      throw refuse(config.copy.neverPushed(worktree.branch as string));
    }

    // Returns as soon as the command is spawned, and installs nothing a
    // checkpoint brought that the branch did not move. Awaiting an install here
    // would put minutes in front of the session waiting for it.
    await stub.startInstall({ dir: checkout.dir, repo: worktree.repo });

    const urls = new Map<string, string>([[".", checkout.url]]);
    for (const sub of submodules)
      urls.set(sub.path, submoduleCloneUrl(sub, checkout.url));
    const repos: PoolRepo[] = [root, ...placedSubs]
      .filter((placed): placed is Placed => Boolean(placed))
      .map((placed) => {
        const ref = placed.path === "." ? rootRef : refs.get(placed.path);
        const kept =
          mode === "continue" ? recorded.get(placed.path) : undefined;
        return {
          path: placed.path,
          url: urls.get(placed.path) as string,
          // A pinned submodule's base is a commit, and a reviewer passes it as one.
          baseRef:
            kept?.baseRef ??
            (ref === "@pinned" || ref === undefined ? placed.base : ref),
          base: placed.base,
          start: placed.start,
          tip: placed.start,
          ...(placed.pushed ? { pushed: placed.pushed } : {})
        };
      });

    const { previous: _previous, ...rest } = worktree;
    const ready: Worktree = {
      ...rest,
      mode,
      dir: checkout.dir,
      repos,
      ready: true
    };
    config.pool.put(ready);
    return ready;
  }

  const api: SubtaskWorkspaces = {
    async resolve(ctx): Promise<SessionPlace> {
      /**
       * A scratchpad is the parent's, and shared.
       *
       * There is nothing to clone — a scratchpad has no remote — so the isolation
       * this whole module provides has no mechanism here, and the honest answer is
       * the workspace the parent already opened. The consequence is a real limit:
       * writing sessions in a scratchpad share one tree, so fan-out there is the
       * model's judgement rather than the platform's guarantee. With no branch of
       * its own, a session there keeps what it leaves in the tree.
       */
      const selected = config.active.get();
      const picked = selectedRepo(selected);
      if (picked === undefined) {
        return placeIn(sandboxName(config.callerKey(), selected));
      }
      const repo = config.active.rootOf(picked);

      // What the parent cloned, which is the only honest thing to clone: the url
      // has already been through `/repo-github`'s host allowlist. The sentence
      // names the refusal that leaves a checkout on disk unrecorded, because
      // "nothing was cloned" is what an agent looking at that checkout will not
      // believe. A checkout recorded before repositories were recorded one by
      // one is only the selection's.
      const checkout =
        config.active.checkoutOf(repo) ??
        (repo === picked ? config.active.checkout() : undefined);
      if (!checkout) {
        throw refuse(
          "there is no recorded checkout for a writing session to " +
            "clone. `repo_clone` records one only when it leaves a clean tree on " +
            "a named branch — if its last answer was a refusal (uncommitted " +
            "changes, another repository at that path), deal with that and run " +
            "`repo_clone` again before delegating"
        );
      }
      // A host refuses its own tool's input in its own words before this; these
      // hold for a host that does not, before anything is claimed.
      if (ctx.branch !== undefined && ctx.continue !== undefined) {
        throw refuse("a run continues a branch or starts one, not both");
      }
      const named = ctx.continue ?? ctx.branch;
      if (named !== undefined && !isBranchName(named)) {
        throw refuse(`${JSON.stringify(named)} is not a branch name`);
      }

      const { near, ...run } = ctx;
      const reading = parseWorktreeRepo(selected ?? "");
      const claimed = claim(
        config.pool,
        repo,
        {
          ...run,
          ...(near?.repo === repo ? { near: near.slot } : {}),
          ...(reading?.repo === repo ? { avoid: reading.slot } : {})
        },
        now(),
        terms
      );
      const name = nameOf(claimed);
      // `note`, not `set`: this enrols the worktree in the sweep's candidate list
      // without routing the parent's own tools to it. Before anything can throw:
      // a sandbox the sweep cannot see is never reclaimed, and a preparation that
      // failed part-way can already have left a checkout in it.
      config.active.note(worktreeRepo(claimed.repo, claimed.slot));
      await config.admit(name);
      const ready = claimed.ready
        ? claimed
        : await prepare(
            claimed,
            checkout,
            name,
            sandboxName(config.callerKey(), repo)
          );
      return {
        workspaceName: name,
        dir: ready.dir ?? checkout.dir,
        branch: ready.branch as string,
        continues: ctx.continue !== undefined,
        slot: { repo: ready.repo, slot: ready.slot }
      };
    },

    working(branch: string): boolean {
      const repo = placementRepo(config.active);
      return repo !== undefined && workingOn(config.pool.all(repo), branch);
    },

    async release(ctx, options = {}): Promise<void> {
      const row = liveRow(ctx);
      if (!row) return;
      let repos = row.repos;
      if (options.hold) {
        // An unknown tip is never free: held until a push says otherwise.
        repos = repos.map((repo) => ({ ...repo, tip: "" }));
      } else if (row.ready && row.dir) {
        try {
          const read = await config.exec(
            READ_TIPS,
            {
              cwd: row.dir,
              env: {
                WORKTREE_PATHS: repos.map((repo) => repo.path).join("\n"),
                WORKTREE_BRANCH: row.branch ?? ""
              }
            },
            nameOf(row)
          );
          const tips = new Map(
            read.stdout
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [path = "", tip = "", pushed = ""] = line.split("\t");
                return [path, { tip, pushed }] as const;
              })
          );
          repos = repos.map((repo) => {
            const read = tips.get(repo.path);
            return {
              ...repo,
              tip: read?.tip ?? "",
              ...(read?.pushed ? { pushed: read.pushed } : {})
            };
          });
        } catch (err) {
          // Unknown tips keep the worktree held, which is the side to err on.
          console.warn(
            `[${config.label}] could not read a worktree's commits`,
            {
              slot: row.slot,
              err: String(err)
            }
          );
          repos = repos.map((repo) => ({ ...repo, tip: "" }));
        }
      }
      // A worktree that never got onto its new branch holds nothing of it; one
      // being continued still holds the branch it had. A branch is forgotten only
      // with nothing on it: without one, `isFree` frees the worktree whatever
      // its tips read, which would take the unknown-tip hold with it.
      const forget =
        options.forgetBranch === true &&
        repos.every(
          (repo) =>
            repo.tip !== "" &&
            (repo.tip === repo.base || repo.tip === repo.pushed)
        );
      const keeps = !forget && (row.ready || row.mode === "continue");
      const {
        live: _live,
        mode: _mode,
        ready: _ready,
        revising: _revising,
        ...rest
      } = row;
      config.pool.put({
        ...rest,
        repos,
        usedAt: now(),
        ...(keeps
          ? {}
          : { branch: undefined, previous: row.branch ?? row.previous })
      });
      if (
        options.follow &&
        keeps &&
        row.ready &&
        placementRepo(config.active) === row.repo
      ) {
        config.active.set(worktreeRepo(row.repo, row.slot));
      }
      // Nobody works in a worktree between sessions, so its container stops
      // now rather than at the idle deadline. Its files stay for the next run.
      try {
        await config.binding.getByName(nameOf(row)).release();
      } catch (err) {
        console.warn(
          `[${config.label}] could not release a worktree's container`,
          {
            slot: row.slot,
            err: String(err)
          }
        );
      }
    },

    /**
     * Keep what a run that did not complete did, where a `continue` will find
     * it.
     *
     * Failed or canceled alike, and nothing is reset for either. A run that
     * failed — its container went, its recovery gave up — says nothing about
     * the session's work, and the ones lost that way were healthy. A cancel is
     * no verdict on the work either: it may be a pause, to add to the task or
     * pick it up later, and what the session did may have had effects that
     * redoing it would repeat. What becomes of the branch is the parent's to
     * decide, from `repo_worktrees`.
     *
     * What the session had not committed is committed for it — a `continue`
     * places the worktree with `checkout -f` and `clean`, and a worktree whose
     * tips never moved from their base is free, so an uncommitted edit would
     * otherwise go with the next session to claim the slot.
     *
     * The row stays live: `release` runs next on the same path, reads the tips
     * this left, and holds the worktree on them. Both steps here are
     * best-effort, so a session that would not stop, or a commit that failed,
     * answers `settled: false`, and `release` then holds the worktree whatever
     * its tips read: freed, a session that never committed reads as its base,
     * and the next claim's `checkout -f` and `clean` would take the only copy
     * of its edits, or run under a session still writing.
     */
    async keep(ctx): Promise<KeptWork> {
      const row = liveRow(ctx);
      if (!row) return { settled: true };
      const name = nameOf(row);
      let stopped = true;
      try {
        await config.stopSession(name, ctx.runId);
      } catch (err) {
        stopped = false;
        console.warn(
          `[${config.label}] could not stop a session to keep its work`,
          {
            slot: row.slot,
            err: String(err)
          }
        );
      }
      if (!row.ready || !row.dir || !row.branch) return { settled: stopped };
      const paths = row.repos.map((repo) => repo.path);
      let kept: { success: boolean; stdout: string; stderr: string };
      try {
        kept = await config.exec(
          KEEP_INTERRUPTED,
          {
            cwd: "/",
            env: {
              WORKTREE_DIR: row.dir,
              WORKTREE_KEEP_PATHS: paths.join("\n"),
              WORKTREE_KEEP_SUBMODULES: paths
                .filter((path) => path !== ".")
                .join("\n"),
              WIP_MESSAGE
            }
          },
          name
        );
      } catch (err) {
        console.warn(
          `[${config.label}] could not reach a worktree to keep its work`,
          { slot: row.slot, err: String(err) }
        );
        return { settled: false };
      }
      if (!kept.success) {
        // Nothing was reset, so the worktree holds whatever the session left,
        // and holding it is what keeps an uncommitted edit.
        console.warn(
          `[${config.label}] could not commit what an interrupted session left`,
          { slot: row.slot, stderr: kept.stderr.trim().slice(0, 500) }
        );
      }
      const settled = stopped && kept.success;
      const heads = new Map(
        kept.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [path = "", head = "", wip = ""] = line.split("\t");
            return [path, { head, wip: wip === "wip" }] as const;
          })
      );
      const moved = row.repos.filter((repo) => {
        const head = heads.get(repo.path)?.head;
        return head !== undefined && head !== "" && head !== repo.start;
      });
      if (moved.length === 0) return { settled };
      return {
        note: config.copy.kept(
          row.branch,
          moved.some((repo) => heads.get(repo.path)?.wip)
        ),
        settled
      };
    },

    async releaseTask(taskId): Promise<void> {
      const stranded = config.pool
        .every()
        .filter((row) => row.live?.taskId === taskId);
      for (const row of stranded) {
        await api.release({ taskId, runId: (row.live as RunRef).runId });
      }
    }
  };
  return api;
}
