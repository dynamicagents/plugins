import type { RepoGit, RepoGitResult } from "../repo-github/index.js";
import { githubEnv } from "./github.js";
import { SANDBOX_ROOT } from "./header.js";

/**
 * `/repo-github`'s three credentialed operations, as `git` in the sandbox.
 *
 * The workspace ran them in its object, beside the token. Here they run where
 * the checkout is, as the agent, with only the placeholder: git's `insteadOf`
 * sends github.com to the intercepted host, and the egress swaps the token in
 * and holds a push to the sandbox's policy (`./github.ts`, `./egress.ts`). So
 * the container still never holds the token, and a push the policy refuses is
 * refused before GitHub sees it.
 *
 * A host passes this as `RepoConfig.git`. A clone is noted on the sandbox, so
 * an image change brings it back from its backup.
 */

/** The sandbox RPCs this uses. */
export interface SandboxGitHost {
  exec(
    argv: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  noteCheckout(record: {
    dir: string;
    kind: "repo" | "scratch";
    repo?: string;
  }): Promise<unknown>;
}

const LIMIT_MS = { clone: 10 * 60_000, fetch: 5 * 60_000, push: 5 * 60_000 };
/** After `timeout`'s TERM, how long before its KILL. */
const KILL_AFTER_S = 5;

/** @param sandbox Called per operation, so each reaches the object through a new stub. */
export function sandboxRepoGit(sandbox: () => SandboxGitHost): RepoGit {
  const git = async (
    cwd: string,
    args: string[],
    limitMs: number
  ): Promise<
    | { ok: true; stdout: string; stderr: string }
    | Extract<RepoGitResult, { ok: false }>
  > => {
    const run = await sandbox().exec(
      [
        "timeout",
        `--kill-after=${KILL_AFTER_S}`,
        String(Math.ceil(limitMs / 1000)),
        "git",
        ...args
      ],
      {
        cwd,
        // A credential prompt would wait out the limit: there is nobody to answer it.
        env: { ...githubEnv(), GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: limitMs + (KILL_AFTER_S + 5) * 1000
      }
    );
    if (run.exitCode === 0)
      return { ok: true, stdout: run.stdout, stderr: run.stderr };
    return {
      ok: false,
      code: run.exitCode === 124 ? "ETIMEDOUT" : `exit-${run.exitCode}`,
      message:
        run.exitCode === 124
          ? `git ${args[0]} ran past its limit of ${limitMs / 60_000} minutes`
          : run.stderr.trim() ||
            run.stdout.trim() ||
            `git ${args[0]} exited ${run.exitCode}`
    };
  };

  return {
    async clone(req) {
      const refused = refuse(req.url, req.allowedHosts);
      if (refused) return refused;
      const cloned = await git(
        SANDBOX_ROOT,
        [
          "clone",
          ...(req.depth ? ["--depth", String(req.depth)] : []),
          ...(req.branch ? ["--branch", req.branch] : []),
          "--",
          req.url,
          req.dir
        ],
        LIMIT_MS.clone
      );
      if (!cloned.ok) return cloned;
      const repo = githubRepo(req.url);
      await sandbox().noteCheckout({
        dir: req.dir,
        kind: "repo",
        ...(repo ? { repo } : {})
      });
      const head = await git(
        req.dir,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        30_000
      );
      return head.ok ? { ok: true, detail: head.stdout.trim() } : head;
    },

    async fetch(req) {
      const refused = refuse(req.url, req.allowedHosts);
      if (refused) return refused;
      const fetched = await git(
        req.dir,
        [
          "fetch",
          "--prune",
          ...(req.depth ? ["--depth", String(req.depth)] : []),
          "--",
          req.url,
          "+refs/heads/*:refs/remotes/origin/*"
        ],
        LIMIT_MS.fetch
      );
      return fetched.ok ? { ok: true, detail: `fetched ${req.url}` } : fetched;
    },

    async push(req) {
      const refused = refuse(req.url, req.allowedHosts);
      if (refused) return refused;
      // Never forced, and only the one branch, to its own name.
      const pushed = await git(
        req.dir,
        [
          "push",
          "--",
          req.url,
          `refs/heads/${req.branch}:refs/heads/${req.branch}`
        ],
        LIMIT_MS.push
      );
      return pushed.ok
        ? { ok: true, detail: pushed.stderr.trim() || `pushed ${req.branch}` }
        : pushed;
    }
  };
}

/** A URL this may not use, as the answer; `undefined` for one it may. */
function refuse(
  url: string,
  allowedHosts: readonly string[]
): Extract<RepoGitResult, { ok: false }> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "EINVAL", message: `not a URL: ${url}` };
  }
  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) {
    return {
      ok: false,
      code: "EACCES",
      message: `git may use https only, and only these hosts: ${allowedHosts.join(", ")}`
    };
  }
  return undefined;
}

/** `owner/repo` of a github.com URL, as the sandbox records a checkout's repository. */
function githubRepo(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    url
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}
