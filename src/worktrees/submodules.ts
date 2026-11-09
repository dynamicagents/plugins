import { isBranchName, parseRepo } from "../repo-github/url.js";

/**
 * A superproject's submodules: which repositories it carries, and where a
 * worktree clones each from.
 *
 * Read twice over. A host reads `.gitmodules` as a file when the parent clones,
 * to learn which repositories a session for any of them works in; a worktree
 * reads it through git when it is prepared, to clone each one. Refusals here
 * name no host: they are about the checkout, whoever asked.
 */

/**
 * A checkout's `.gitmodules`, as text: empty when it has none, and `undefined`
 * when it could not be read — which a caller keeps its last answer for rather
 * than recording "no submodules".
 *
 * Read as a file rather than through git, which is {@link readSubmodules}'s
 * job: the caller is a host's `afterCheckout`, which only needs the
 * repositories it names. The two nothings differ, and a read that failed must
 * record nothing at all, or a transient fault would erase a superproject's
 * submodules from the selection and send the next session to clone the root
 * alone.
 */
export async function gitmodulesOf(
  host: { readFile(path: string): Promise<Uint8Array | null> },
  dir: string
): Promise<string | undefined> {
  try {
    const bytes = await host.readFile(`${dir}/.gitmodules`);
    return bytes === null ? "" : new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The repositories a `.gitmodules` file names, as `owner/repo` — read as text,
 * since {@link gitmodulesOf} reads the file rather than git's view of it. A url
 * {@link submoduleCloneUrl} would not clone from, or one naming no repository,
 * is left out.
 */
export function submoduleRepos(
  gitmodules: string,
  parentUrl: string
): string[] {
  const repos: string[] = [];
  for (const [, url = ""] of gitmodules.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)) {
    try {
      const parsed = parseRepo(
        submoduleCloneUrl({ path: ".", url }, parentUrl)
      );
      if (parsed) repos.push(`${parsed.owner}/${parsed.repo}`);
    } catch {
      // Not one a worktree would clone, so not one a session works in either.
    }
  }
  return repos;
}

/** One submodule a writing session's clone carries, as `.gitmodules` declares it. */
export interface Submodule {
  path: string;
  url: string;
  /** Absent when `.gitmodules` names none: the superproject's pinned commit. */
  branch?: string;
}

/** Enough of a shell in one checkout to read what it declares. */
export type CheckoutShell = (
  command: string,
  options: { cwd: string; env?: Record<string, string> }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/**
 * Parse `git config --null --get-regexp` over `.gitmodules`.
 *
 * NUL-separated because a value may hold anything but NUL, and the subsection —
 * the submodule's name — may hold dots, which is why the key is matched from its
 * end. An entry without both a path and a url is not one git could check out
 * either, and is dropped.
 */
export function parseGitmodules(out: string): Submodule[] {
  const byName = new Map<string, Partial<Submodule>>();
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const match = /^submodule\.(.+)\.(path|url|branch)$/.exec(
      entry.slice(0, newline)
    );
    if (!match) continue;
    const [, name, field] = match as unknown as [
      string,
      string,
      keyof Submodule
    ];
    const sub = byName.get(name) ?? {};
    sub[field] = entry.slice(newline + 1);
    byName.set(name, sub);
  }
  return [...byName.values()].filter((sub): sub is Submodule =>
    Boolean(sub.path && sub.url)
  );
}

/**
 * Refuse a submodule path that could leave the checkout or split a line.
 *
 * `.gitmodules` is repository content, and its paths become clone targets, the
 * cwd of git commands, and rows of the tab- and newline-separated lists the
 * branch script reads. A control character would turn one path into two rows —
 * `safe\n../outside` runs git outside the checkout — so each is refused here,
 * before any of those uses, along with every segment that walks out.
 */
function assertSubmodulePath(path: string): void {
  if (
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `refusing a submodule path that could leave the checkout: ${JSON.stringify(path)}`
    );
  }
}

/**
 * Refuse a submodule branch git would not take. Like a path, it is repository
 * content, and it reaches the branch script's tab- and newline-separated rows:
 * `main\n../out` would add a row that runs git outside the checkout. `.` is
 * git's own spelling of "the superproject's branch".
 */
function assertSubmoduleBranch(sub: Submodule): void {
  if (sub.branch === undefined || sub.branch === ".") return;
  if (!isBranchName(sub.branch)) {
    throw new Error(
      `refusing a submodule branch git would not take, at ${JSON.stringify(sub.path)}: ${JSON.stringify(sub.branch)}`
    );
  }
}

/**
 * The submodules a checkout declares — one level, never theirs — each with a
 * path that stays inside it and a branch git would take.
 *
 * Nested submodules are left alone: each level would be another clone in front
 * of the session, and the superprojects this has met have none.
 */
export async function readSubmodules(
  run: CheckoutShell,
  dir: string
): Promise<Submodule[]> {
  const listed = await run(
    "[ ! -f .gitmodules ] || git config -f .gitmodules --null --get-regexp '^submodule\\..*\\.(path|url|branch)$'",
    { cwd: dir }
  );
  // `--get-regexp` exits 1 on no match, which is a file with nothing in it —
  // not a failure. Anything that said why is one.
  if (!listed.success && listed.stderr.trim()) {
    throw new Error(
      `could not read .gitmodules in ${dir}: ${listed.stderr.trim()}`
    );
  }
  const submodules = parseGitmodules(listed.stdout);
  for (const sub of submodules) {
    assertSubmodulePath(sub.path);
    assertSubmoduleBranch(sub);
  }
  return submodules;
}

/**
 * Where to clone one submodule from, or why not.
 *
 * A relative url is resolved the way git resolves it, against the superproject's
 * own. An absolute one must be https on the host the parent's checkout came from:
 * that host has passed `/repo-github`'s allowlist, and a `.gitmodules` is
 * repository content: a url in it has passed nothing.
 */
export function submoduleCloneUrl(sub: Submodule, parentUrl: string): string {
  const url =
    sub.url.startsWith("./") || sub.url.startsWith("../")
      ? new URL(sub.url, parentUrl.replace(/\/*$/, "/")).href
      : sub.url;
  const host = new URL(parentUrl).hostname;
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:" || parsed.hostname !== host) {
    throw new Error(
      `the submodule at ${sub.path} is cloned from ${sub.url}, and ` +
        `a writing session clones only over https from ${host}, where the ` +
        "parent's checkout came from"
    );
  }
  return url;
}

/**
 * Which submodules a previous attempt already cloned, and the origin each was
 * cloned from, clearing any it left half-done.
 *
 * Present means a repository of its own with a commit checked out, asked of its
 * own `.git` — `git -C` there would walk up to the superproject and answer for
 * it. A `.git` with no commit behind it is a clone that failed part-way, and is
 * cleared so the next one is not refused as "already exists". The origin is
 * where its push goes, so a caller checks it against what `.gitmodules` names
 * now.
 */
export async function populated(
  run: CheckoutShell,
  dir: string,
  submodules: readonly Submodule[]
): Promise<Map<string, string>> {
  if (submodules.length === 0) return new Map();
  const found = await run(
    `while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ -e "$p/.git" ] && git --git-dir="$p/.git" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    printf '%s\\t%s\\n' "$p" "$(git --git-dir="$p/.git" config --get remote.origin.url)"
  elif [ -e "$p/.git" ]; then
    rm -rf "$p" || exit 1
  fi
done <<EOF
$SUBMODULE_PATHS
EOF`,
    {
      cwd: dir,
      env: { SUBMODULE_PATHS: submodules.map((sub) => sub.path).join("\n") }
    }
  );
  if (!found.success) {
    throw new Error(
      `could not read which submodules are cloned: ${found.stderr || found.stdout}`
    );
  }
  return new Map(
    found.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [path = "", origin = ""] = line.split("\t");
        return [path, origin] as const;
      })
  );
}
