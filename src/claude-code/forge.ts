/**
 * GitHub access for a session, with the token on the Worker side.
 *
 * The session is launched with {@link FORGE_PLACEHOLDER} as `GH_TOKEN`, and git
 * is given a credential helper that answers with it. The egress gateway swaps
 * the placeholder for the real token on {@link FORGE_HOSTS} only, so a process
 * in the container can *use* GitHub as the deployment's account and can never
 * *read* the token — the same containment as the Anthropic credential.
 *
 * Keyed on the placeholder, unlike the Anthropic swap: a forge request that did
 * not ask for a credential stays anonymous, as it would be anywhere else.
 */

export interface ForgeConfig {
  /**
   * The GitHub token, read per request on the Worker side. It reaches
   * {@link FORGE_HOSTS} and nowhere else.
   */
  token: () => string | undefined;
}

/** The hosts the token is ever sent to: git over HTTPS, and the API. */
export const FORGE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "api.github.com"
]);

/**
 * What `GH_TOKEN` and git's credential helper hold. Shaped like a classic
 * token, so nothing that checks the shape refuses it before sending it.
 */
export const FORGE_PLACEHOLDER = "ghp_" + "0".repeat(36);

/** The username GitHub expects beside a token in git's Basic auth. */
const GIT_USER = "x-access-token";

/**
 * The session's GitHub environment. A credential helper for `https://github.com`
 * rather than a token in the remote URL, so the checkout's `.git/config` holds
 * nothing and every git the session starts presents the placeholder.
 */
export function forgeEnv(): Record<string, string> {
  return {
    GH_TOKEN: FORGE_PLACEHOLDER,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    // Answers `get` only; `store` and `erase` are no-ops that still exit 0.
    GIT_CONFIG_VALUE_0: `!f() { if test "$1" = get; then printf 'username=${GIT_USER}\\npassword=%s\\n' "$GH_TOKEN"; fi; }; f`
  };
}

/** The keys {@link forgeEnv} owns, which a host's `env` may not set beside it. */
export const FORGE_ENV_KEYS: readonly string[] = Object.keys(forgeEnv());

/** How an authorization header carried the placeholder, if it did. */
type Presented = "bearer" | "basic";

/**
 * Whether `value` presents the placeholder: `Bearer`/`token` as `gh` sends it,
 * or Basic `user:placeholder` as git does after a `401`.
 */
export function presentsPlaceholder(
  value: string | null
): Presented | undefined {
  if (!value) return undefined;
  const [scheme = "", credential = ""] = value.trim().split(/\s+/, 2);
  switch (scheme.toLowerCase()) {
    case "bearer":
    case "token":
      return credential === FORGE_PLACEHOLDER ? "bearer" : undefined;
    case "basic": {
      let decoded: string;
      try {
        decoded = atob(credential);
      } catch {
        return undefined;
      }
      const password = decoded.slice(decoded.indexOf(":") + 1);
      return decoded.includes(":") && password === FORGE_PLACEHOLDER
        ? "basic"
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The real credential, in the scheme the placeholder came in. */
export function forgeAuthorization(
  presented: Presented,
  token: string
): string {
  return presented === "basic"
    ? `Basic ${btoa(`${GIT_USER}:${token}`)}`
    : `Bearer ${token}`;
}

/** A refusal in GitHub's error shape, which `gh` and git both print. */
export function forgeError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}
