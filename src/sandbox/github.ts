/**
 * GitHub from inside a sandbox, with the token on the Worker side.
 *
 * Commands get {@link GITHUB_TOKEN_PLACEHOLDER} as `GH_TOKEN` and a git
 * credential helper that answers with it ({@link githubEnv}). The egress swaps
 * the placeholder for the real token, so a process can *use* GitHub as the
 * deployment's account and never *read* the token. A request that presents no
 * placeholder goes out anonymous, as it would anywhere else.
 *
 * git reaches GitHub through {@link GITHUB_PLACEHOLDER_HOST} over plain HTTP —
 * a host the harness intercepts, so no TLS has to be terminated in the
 * container — by the `insteadOf` rule in {@link githubEnv}. `gh` cannot be
 * pointed at a plain-HTTP host, so `api.github.com` is intercepted over HTTPS by
 * whichever sandbox is allowed the API at all.
 *
 * The same rules as `../claude-code/github.ts`, which goes when its gateway does.
 */

/** What `GH_TOKEN` and git's credential helper hold. Shaped like a classic token, so nothing refuses it on shape. */
export const GITHUB_TOKEN_PLACEHOLDER = "ghp_" + "0".repeat(36);

/** The plain-HTTP host git is pointed at in place of `https://github.com`. */
export const GITHUB_PLACEHOLDER_HOST = "github.harness.internal";

/** The username GitHub expects beside a token in git's Basic auth. */
const GIT_USER = "x-access-token";

/**
 * A command's GitHub environment.
 *
 * In the environment rather than a gitconfig file because a session's home is
 * copied from the agent's when the session opens, so a `git config --global`
 * written afterwards never reaches it; an environment reaches every process.
 */
export function githubEnv(): Record<string, string> {
  return {
    GH_TOKEN: GITHUB_TOKEN_PLACEHOLDER,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.http://${GITHUB_PLACEHOLDER_HOST}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: `credential.http://${GITHUB_PLACEHOLDER_HOST}.helper`,
    // Answers `get` only; `store` and `erase` are no-ops that still exit 0.
    GIT_CONFIG_VALUE_1: `!f() { if test "$1" = get; then printf 'username=${GIT_USER}\\npassword=%s\\n' "$GH_TOKEN"; fi; }; f`
  };
}

/** How an authorization header carried the placeholder, if it did. */
export type Presented = "bearer" | "basic";

/** Whether `value` presents the placeholder: Bearer/`token` as `gh` sends it, or Basic `user:placeholder` as git does after a 401. */
export function presentsPlaceholder(
  value: string | null
): Presented | undefined {
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
export function githubAuthorization(
  presented: Presented,
  token: string
): string {
  return presented === "basic"
    ? `Basic ${btoa(`${GIT_USER}:${token}`)}`
    : `Bearer ${token}`;
}

/** A refusal in GitHub's error shape, which `gh` and git both print. */
export function githubError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Where a sandbox may push with the deployment's token.
 *
 * Checked on the credentialed requests only: anonymous traffic to GitHub is
 * whatever GitHub allows anyone. `repos` are `owner/repo`; `branches` are
 * branch names, a trailing `*` matching any suffix. A deletion is an update
 * like any other, so it is held to the same names.
 */
export interface GitPushPolicy {
  readonly repos: readonly string[];
  readonly branches: readonly string[];
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

/**
 * The refs a `git-receive-pack` request updates, from its pkt-line commands.
 *
 * Each command is `<old> <new> <ref>`, the first carrying `\0<capabilities>`,
 * and the list ends at a flush packet; the pack follows. git compresses the
 * request body when it is large, so a gzip body is inflated to read them.
 */
export async function receivePackRefs(
  body: ArrayBuffer,
  encoding: string | null
): Promise<string[]> {
  const bytes =
    encoding?.toLowerCase() === "gzip"
      ? new Uint8Array(
          await new Response(
            new Blob([body])
              .stream()
              .pipeThrough(new DecompressionStream("gzip"))
          ).arrayBuffer()
        )
      : new Uint8Array(body);
  const text = new TextDecoder("latin1");
  const refs: string[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const length = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) break;
    const line = text.decode(bytes.subarray(at + 4, at + length));
    at += length;
    const command = line.split("\0", 1)[0]?.trim() ?? "";
    const ref = command.split(" ")[2];
    if (ref) refs.push(ref);
  }
  return refs;
}
