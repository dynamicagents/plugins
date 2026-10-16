import {
  CREDENTIAL_HEADERS,
  forward,
  type EgressCall,
  type SandboxEgressRule
} from "../sandbox/egress.js";
import { PROTECTED_BRANCHES } from "./url.js";

/**
 * GitHub from inside a sandbox, with the token on the Worker side: the
 * sandbox's egress rule for it.
 *
 * The harness intercepts `github.com` over HTTPS, and git's credential helper
 * answers with {@link GITHUB_TOKEN_PLACEHOLDER}. **Never an `insteadOf` onto a
 * placeholder host:** git reports the rewritten URL to whatever reads a remote
 * (`git remote get-url`, `git remote -v`), so `/repo` would take a checkout's
 * origin for a host it does not allow, and `gh` would find no GitHub remote. A
 * sandbox allowed the API intercepts `api.github.com` too, and gives `gh` the
 * placeholder as `GH_TOKEN`.
 *
 * The egress swaps the placeholder for the real token, so a process can *use*
 * GitHub as the deployment's account and never *read* the token. A request
 * that presents no placeholder goes out anonymous, as it would anywhere else.
 *
 * Any process in the container can present the placeholder, a model's own
 * shell included, so what `repo_push` refuses is refused here too, for every
 * credentialed push: a ref that is not a branch, a protected name, and the
 * repository's own default branch, which work reaches through a pull request.
 *
 * The same rules as `../claude-code/github.ts`, which goes when its gateway does.
 */

/** What `GH_TOKEN` and git's credential helper hold. Shaped like a classic token, so nothing refuses it on shape. */
export const GITHUB_TOKEN_PLACEHOLDER = "ghp_" + "0".repeat(36);

/** Where git's own traffic goes. */
const GIT_HOST = "github.com";

/** The username GitHub expects beside a token in git's Basic auth. */
const GIT_USER = "x-access-token";

const API_HOST = "api.github.com";

/**
 * Where a credentialed git request may go, beyond what every push is held to.
 *
 * Checked on git's own requests only: anonymous traffic to GitHub is whatever
 * GitHub allows anyone. `repos` are `owner/repo`; `branches` are branch names,
 * a trailing `*` matching any suffix. A deletion is an update like any other,
 * so it is held to the same names.
 */
export interface GitPushPolicy {
  readonly repos: readonly string[];
  readonly branches: readonly string[];
}

export interface GitHubSandboxEgressOptions {
  /** The `env` binding holding the token, read at the moment it is used and never carried. */
  tokenBinding: string;
  /** Absent: any repository and any work branch the token reaches. */
  push?: GitPushPolicy;
  /** Intercept `api.github.com` as well, so `gh` works as the deployment's account. */
  api?: boolean;
}

/** The egress rule of a sandbox whose processes use GitHub. */
export function githubSandboxEgress(
  options: GitHubSandboxEgressOptions
): SandboxEgressRule {
  const api = options.api ?? false;
  return {
    name: "github",
    https: {
      [GIT_HOST]: `https://${GIT_HOST}`,
      ...(api ? { [API_HOST]: `https://${API_HOST}` } : {})
    },
    env: githubEnv(api),
    handle: (call) => githubEgress(call, options)
  };
}

/**
 * The environment a sandbox gives its processes.
 *
 * In the environment rather than a gitconfig file because a session's home is
 * copied from the agent's when the session opens, so a `git config --global`
 * written afterwards never reaches it; an environment reaches every process.
 *
 * `GH_TOKEN` only with the API intercepted: otherwise `gh` would send the
 * placeholder to the real API, which refuses even a read anyone may make.
 */
function githubEnv(api: boolean): Record<string, string> {
  return {
    ...(api ? { GH_TOKEN: GITHUB_TOKEN_PLACEHOLDER } : {}),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `credential.https://${GIT_HOST}.helper`,
    // Answers `get` only; `store` and `erase` are no-ops that still exit 0.
    GIT_CONFIG_VALUE_0: `!f() { if test "$1" = get; then printf 'username=${GIT_USER}\\npassword=${GITHUB_TOKEN_PLACEHOLDER}\\n'; fi; }; f`
  };
}

/** Anonymous unless the placeholder is presented; then the real token, and for a push, what it may update. */
async function githubEgress(
  call: EgressCall,
  options: GitHubSandboxEgressOptions
): Promise<Response> {
  const presented = presentsPlaceholder(
    call.request.headers.get("authorization")
  );
  const strip = (headers: Headers) => {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  };
  if (!presented) return forward(call, strip);

  const token = call.env[options.tokenBinding];
  if (typeof token !== "string" || token === "") {
    return githubError(
      "no GitHub token is configured for this deployment, so nothing can be done as its account",
      401
    );
  }

  const policy = options.push;
  const git =
    new URL(call.request.url).hostname === GIT_HOST
      ? gitTarget(call.target.pathname)
      : undefined;
  let body: ReadableStream | undefined;
  if (git) {
    if (
      policy &&
      !policy.repos.some((repo) => repo.toLowerCase() === git.repo)
    ) {
      return githubError(
        `this sandbox may not use ${git.repo} as the deployment's account`,
        403
      );
    }
    if (git.service === "receive-pack" && call.request.method === "POST") {
      const [inspected, forwarded] = (
        call.request.body ?? new Blob().stream()
      ).tee();
      const refuse = (message: string, status: number) => {
        void forwarded.cancel().catch(() => undefined);
        return githubError(message, status);
      };
      const refs = await receivePackRefs(
        inspected,
        call.request.headers.get("content-encoding")
      ).catch(() => undefined);
      if (!refs || refs.length === 0) {
        return refuse("this push names no ref this egress can read", 400);
      }
      const defaultBranch = await defaultBranchOf(git.repo, token);
      if (defaultBranch === undefined) {
        return refuse(
          `could not read ${git.repo}'s default branch, so nothing was pushed: retry`,
          503
        );
      }
      const refused = refs.flatMap((ref) => {
        const why = refusal(ref, defaultBranch, policy);
        return why ? [`${ref} (${why})`] : [];
      });
      if (refused.length > 0) {
        return refuse(`this sandbox may not push ${refused.join(", ")}`, 403);
      }
      body = forwarded;
    }
  }
  return forward(
    call,
    (headers) => {
      strip(headers);
      headers.set("authorization", githubAuthorization(presented, token));
    },
    body
  );
}

/** Why a push may not update `ref`, if it may not. */
function refusal(
  ref: string,
  defaultBranch: string,
  policy: GitPushPolicy | undefined
): string | undefined {
  if (!ref.startsWith("refs/heads/")) return "not a branch";
  const branch = ref.slice("refs/heads/".length);
  if (branch === defaultBranch)
    return "the repository's default branch: work reaches it through a pull request";
  if (PROTECTED_BRANCHES.has(branch)) return "a protected branch";
  if (policy && !branchAllowed(policy, branch))
    return `this sandbox may push ${policy.branches.join(", ")}`;
  return undefined;
}

/** `repo`'s default branch, as the token sees it; `undefined` when it cannot be read. */
async function defaultBranchOf(
  repo: string,
  token: string
): Promise<string | undefined> {
  try {
    const response = await fetch(`https://${API_HOST}/repos/${repo}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        // GitHub refuses a request with none.
        "user-agent": "dynamicagents-sandbox-egress"
      }
    });
    if (!response.ok) return undefined;
    const found = (await response.json()) as { default_branch?: unknown };
    return typeof found.default_branch === "string" && found.default_branch
      ? found.default_branch
      : undefined;
  } catch {
    return undefined;
  }
}

/** How an authorization header carried the placeholder, if it did. */
type Presented = "bearer" | "basic";

/** Whether `value` presents the placeholder: Bearer/`token` as `gh` sends it, or Basic `user:placeholder` as git does after a 401. */
function presentsPlaceholder(value: string | null): Presented | undefined {
  if (!value) return undefined;
  const [scheme = "", credential = ""] = value.trim().split(/\s+/, 2);
  switch (scheme.toLowerCase()) {
    case "bearer":
    case "token":
      return credential === GITHUB_TOKEN_PLACEHOLDER ? "bearer" : undefined;
    case "basic": {
      let decoded: string;
      try {
        decoded = atob(credential);
      } catch {
        return undefined;
      }
      const password = decoded.slice(decoded.indexOf(":") + 1);
      return decoded.includes(":") && password === GITHUB_TOKEN_PLACEHOLDER
        ? "basic"
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The real credential, in the scheme the placeholder came in. */
function githubAuthorization(presented: Presented, token: string): string {
  return presented === "basic"
    ? `Basic ${btoa(`${GIT_USER}:${token}`)}`
    : `Bearer ${token}`;
}

/** A refusal in GitHub's error shape, which `gh` and git both print. */
function githubError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** `owner/repo` of a smart-HTTP git path, and which service it asks for. */
export function gitTarget(
  pathname: string
):
  | { repo: string; service: "upload-pack" | "receive-pack" | undefined }
  | undefined {
  const match =
    /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      pathname
    );
  if (!match) return undefined;
  const [, owner = "", name = "", tail = ""] = match;
  const service = tail.endsWith("receive-pack")
    ? "receive-pack"
    : tail.endsWith("upload-pack")
      ? "upload-pack"
      : undefined;
  return { repo: `${owner}/${name}`.toLowerCase(), service };
}

/** Whether `branch` is one the policy allows. */
export function branchAllowed(policy: GitPushPolicy, branch: string): boolean {
  return policy.branches.some((pattern) =>
    pattern.endsWith("*")
      ? branch.startsWith(pattern.slice(0, -1))
      : branch === pattern
  );
}

/** A command list git would never send: thousands of refs fit well inside it. */
const COMMANDS_MAX_BYTES = 1 << 20;
/** pkt-line's own ceiling on one packet, its four length digits included. */
const PKT_MAX = 65520;

/**
 * The refs a `git-receive-pack` request updates, from its pkt-line commands.
 *
 * Each command is `<old> <new> <ref>`, the first carrying `\0<capabilities>`,
 * and the list ends at a flush packet; the pack follows. Only the list is read,
 * so a caller hands this one branch of a `tee()` and forwards the other: the
 * pack is never held in the Worker. git compresses the request body when it is
 * large, so a gzip body is inflated as it is read.
 *
 * Read as strictly as git reads it, since the refs this returns are the ones a
 * policy allows: a length is four hex digits, `0000` ends the list, and any
 * other packet shorter than its own length or past the ceiling is refused
 * rather than skipped. A ref is UTF-8, as git writes it.
 */
export async function receivePackRefs(
  body: ReadableStream<Uint8Array>,
  encoding: string | null
): Promise<string[]> {
  const reader = (
    encoding?.toLowerCase() === "gzip"
      ? body.pipeThrough(new DecompressionStream("gzip"))
      : body
  ).getReader();
  const ascii = new TextDecoder("latin1");
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const refs: string[] = [];
  let buffer = new Uint8Array(0);
  let read = 0;
  try {
    for (;;) {
      while (buffer.length >= 4) {
        const digits = ascii.decode(buffer.subarray(0, 4));
        if (!/^[0-9a-f]{4}$/i.test(digits))
          throw new Error(`not a pkt-line length: ${JSON.stringify(digits)}`);
        const length = Number.parseInt(digits, 16);
        if (length === 0) return refs;
        if (length < 4 || length > PKT_MAX)
          throw new Error(`a pkt-line of length ${length} is not a command`);
        if (buffer.length < length) break;
        const line = utf8.decode(buffer.subarray(4, length));
        buffer = buffer.subarray(length);
        const ref = line.split("\0", 1)[0]?.trim().split(" ")[2];
        if (ref) refs.push(ref);
      }
      const chunk = await reader.read();
      if (chunk.done) return refs;
      read += chunk.value.byteLength;
      if (read > COMMANDS_MAX_BYTES)
        throw new Error("the push's command list never ended");
      const next = new Uint8Array(buffer.length + chunk.value.byteLength);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
    }
  } finally {
    // Not awaited: a tee branch's cancel settles only once the other branch is
    // cancelled or read to its end, and the caller does neither until this
    // returns.
    void reader.cancel().catch(() => undefined);
  }
}
