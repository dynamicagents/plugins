import type { EgressCall, SandboxEgressRule } from "../sandbox/egress.js";
import { ANTHROPIC_PLACEHOLDER_HOST } from "./harness-wire.js";
import {
  readRefusal,
  sharedPool,
  type CredentialStore,
  type Lead
} from "./credentials.js";

/**
 * The Anthropic credential, swapped in on the Worker side of a sandbox.
 *
 * The CLI holds a placeholder OAuth token, this sets the pool's lead as the
 * Bearer, and a refusal that spends or rejects the credential moves the lead
 * and tells the CLI to retry on the next one — `./credentials.ts` reads the
 * refusal. A sandbox's egress entrypoint is stateless, so the pool lives in the
 * sandbox the request came from, reached through `call.sandbox()` as a
 * {@link CredentialLease}.
 *
 * The CLI reaches this over plain HTTP to a placeholder host the harness
 * intercepts, so nothing in the container terminates TLS. The daemon points
 * the CLI at it (`./daemon/index.ts`), after the deployment's own environment,
 * so the rule sets no `env`.
 */

/** Anthropic's API host — the one destination that gets a credential. */
export const ANTHROPIC_HOST = "api.anthropic.com";

/** The pool, as the object holding it answers over RPC. */
export interface CredentialLease {
  lead(): Promise<Lead>;
  spend(id: string, resetAt: number): Promise<Lead>;
  reject(id: string): Promise<Lead>;
}

/** The one-second retry that lands a rotated request on the next credential. */
const ROTATED_RETRY_AFTER = "1";
/** How much of a refusal's body the log keeps. */
const CAPTURE_BYTES = 2048;

export interface ClaudeCodeSandboxEgressOptions {
  /** The pool `call` leases from. Default: the sandbox it came from, which holds one through {@link credentialHost}. */
  pool?: (call: EgressCall) => CredentialLease;
  label?: string;
  now?: () => number;
}

/** The egress rule of a sandbox that runs Claude Code. */
export function claudeCodeSandboxEgress(
  options: ClaudeCodeSandboxEgressOptions = {}
): SandboxEgressRule {
  const tag = options.label ?? "claude-code-egress";
  const now = options.now ?? Date.now;
  const poolOf =
    options.pool ??
    ((call: EgressCall) => call.sandbox() as unknown as CredentialLease);

  const spent = (lead: Extract<Lead, { ok: false }>): Response => {
    if (lead.retryAt === undefined) {
      console.error(
        `[${tag}] no usable credential, and none will recover on its own`
      );
      return apiError(
        "authentication_error",
        "no Anthropic credential in this deployment's pool is usable and none will recover " +
          "on its own — every entry was rejected as invalid, or none is configured",
        500
      );
    }
    const waitMs = lead.retryAt - now();
    console.error(`[${tag}] every credential in the pool is rate limited`, {
      retryAt: new Date(lead.retryAt).toISOString()
    });
    return apiError(
      "rate_limit_error",
      "every Anthropic credential in this deployment's pool is rate limited; " +
        `the earliest resets at ${new Date(lead.retryAt).toISOString()}`,
      429,
      { "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))) }
    );
  };

  const handle = async (call: EgressCall): Promise<Response> => {
    const pool = poolOf(call);
    const lead = await pool.lead();
    if (!lead.ok) return spent(lead);

    // `authorization` set and `x-api-key` removed: the shape the sanctioned
    // client sends. Everything else — the `anthropic-beta` list, the user agent
    // — is forwarded untouched; it is not ours to normalise.
    const headers = new Headers(call.request.headers);
    headers.delete("host");
    headers.delete("proxy-authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${lead.token}`);
    const hasBody =
      call.request.method !== "GET" && call.request.method !== "HEAD";
    const response = await fetch(call.target, {
      method: call.request.method,
      headers,
      ...(hasBody ? { body: call.request.body } : {}),
      redirect: "manual"
    });
    if (
      response.status !== 429 &&
      response.status !== 401 &&
      response.status !== 403
    ) {
      return response;
    }

    const verdict = readRefusal(response, now());
    const body = await response
      .clone()
      .text()
      .then((text) => text.slice(0, CAPTURE_BYTES))
      .catch(() => "<unreadable>");
    console.warn(`[${tag}] Anthropic refused a request`, {
      status: response.status,
      method: call.request.method,
      credential: lead.index,
      verdict: verdict?.kind ?? "unrecognised",
      headers: Object.fromEntries(response.headers),
      body
    });
    // Unrecognised, or an ordinary slow-down: not this credential's fault.
    if (!verdict || verdict.kind === "transient") return response;

    const next =
      verdict.kind === "invalid"
        ? await pool.reject(lead.id)
        : await pool.spend(lead.id, verdict.resetAt);
    if (!next.ok) return spent(next);
    console.warn(`[${tag}] rotated to the next credential`, {
      from: lead.index,
      to: next.index,
      reason: verdict.kind
    });
    // A 429 whatever the upstream said: a client does not retry a 401, and the
    // next attempt carries a different credential.
    return apiError(
      "rate_limit_error",
      verdict.kind === "invalid"
        ? "that Anthropic credential was rejected; the egress has moved to the next one in the pool — retry"
        : "that Anthropic credential's limit is reached; the egress has moved to the next one in the pool — retry",
      429,
      { "retry-after": ROTATED_RETRY_AFTER }
    );
  };

  return {
    name: "claude-code",
    http: { [ANTHROPIC_PLACEHOLDER_HOST]: `https://${ANTHROPIC_HOST}` },
    handle
  };
}

function apiError(
  type: string,
  message: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "content-type": "application/json", ...headers }
    }
  );
}

/**
 * The pool a sandbox object holds, for its RPCs to answer {@link CredentialLease}
 * with — and `admit`, which a session start calls: a mark lasts one session.
 */
export function credentialHost(options: {
  storage: DurableObjectStorage;
  credentials: () => readonly string[];
  key?: string;
}): CredentialLease & { admit(): Promise<Lead> } {
  const key = options.key ?? "claude-credentials";
  const store: CredentialStore = {
    read: async () => (await options.storage.get(key)) ?? [],
    write: async (states) => {
      await options.storage.put(key, states);
    }
  };
  const pool = sharedPool({ credentials: options.credentials, store });
  return {
    lead: () => pool.lead(),
    spend: (id, resetAt) => pool.spend(id, resetAt),
    reject: (id) => pool.reject(id),
    admit: () => pool.reopen()
  };
}
