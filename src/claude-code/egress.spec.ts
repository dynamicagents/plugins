import { afterEach, describe, expect, it, vi } from "vitest";
import capture from "../../test/fixtures/claude-code-probe-capture.json";
import { egressPlan, sandboxEgress } from "../sandbox/egress.js";
import {
  claudeCodeEgress,
  credentialHost,
  type CredentialLease
} from "./egress.js";
import { ANTHROPIC_PLACEHOLDER_HOST } from "./harness-wire.js";
import { CREDENTIAL_PLACEHOLDER } from "./placeholder.js";

/**
 * The Anthropic credential on the Worker side of a sandbox: the same rules as
 * the workspace gateway, over a pool the sandbox object holds.
 */

// The pool reads the real clock, so this one is now, to the second.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const SANDBOX = "CODING_SANDBOX/slot-1";

function memoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
    }
  } as unknown as DurableObjectStorage;
}

function upstream(responses: (() => Response)[]): { calls: Request[] } {
  const calls: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push(new Request(input as RequestInfo, init));
    return (responses.shift() ?? (() => new Response("ok")))();
  });
  return { calls };
}

const spent = () =>
  new Response("{}", {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(NOW / 1000 + 4 * 3600)
    }
  });

function serve(tokens: string[]) {
  const pool = credentialHost({
    storage: memoryStorage(),
    credentials: () => tokens
  });
  return send(claudeCodeEgress({ pool: () => pool, now: () => NOW }), {});
}

/** A request the CLI makes, through the routes a sandbox registers for `rule`. */
function send(
  rule: ReturnType<typeof claudeCodeEgress>,
  env: Record<string, unknown>
) {
  const { http } = egressPlan([rule], SANDBOX);
  return (headers: Record<string, string> = {}) =>
    sandboxEgress(
      new Request(`http://${ANTHROPIC_PLACEHOLDER_HOST}/v1/messages?beta=1`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CREDENTIAL_PLACEHOLDER}`,
          ...headers
        },
        body: "{}"
      }),
      http,
      env,
      [rule]
    );
}

afterEach(() => vi.restoreAllMocks());

describe("claudeCodeEgress", () => {
  it("sends the pool's lead as the Bearer, to the real host, and nothing of the CLI's own", async () => {
    const { calls } = upstream([]);
    const response = await serve(["sk-ant-oat01-A"])({ "x-api-key": "k" });
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=1");
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-A"
    );
    expect(calls[0]?.headers.get("x-api-key")).toBeNull();
    for (const [name] of calls[0]?.headers ?? [])
      expect(name).not.toMatch(/^x-da-/);
  });

  it("moves to the next credential on a spent one, and has the CLI retry in a second", async () => {
    const { calls } = upstream([spent, () => new Response("ok")]);
    const send = serve(["sk-ant-oat01-A", "sk-ant-oat01-B"]);
    const rotated = await send();
    expect(rotated.status).toBe(429);
    expect(rotated.headers.get("retry-after")).toBe("1");
    expect((await send()).status).toBe(200);
    expect(calls[1]?.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-B"
    );
  });

  it("says when the whole pool resets once every credential is spent", async () => {
    upstream([spent]);
    const send = serve(["sk-ant-oat01-A"]);
    const last = await send();
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBe(4 * 3600);
    expect(await last.text()).toMatch(/every Anthropic credential/);
  });

  it("names a pool that will not recover on its own", async () => {
    upstream([]);
    const response = await serve([])();
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/none will recover/);
  });
});

/**
 * A request's headers as the verified version sent them, from the probe's
 * capture in `test/fixtures/`. The probe records a value that varies by
 * machine or run as `*`, and those are left out along with the connection's
 * own framing.
 */
function recordedHeaders(headers: Partial<Record<string, string>>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== "*" && name !== "connection") {
      out.set(name, value);
    }
  }
  return out;
}

/** A request the verified version made, as the egress meets it. */
function recorded(
  request: (typeof capture.requests)[number],
  body?: string
): Request {
  return new Request(`http://${ANTHROPIC_PLACEHOLDER_HOST}${request.path}`, {
    method: request.method,
    headers: recordedHeaders(request.headers),
    ...(body === undefined ? {} : { body })
  });
}

/** Through the routes a sandbox registers, leasing from a pool of one. */
function sendRecorded(request: Request) {
  const pool = credentialHost({
    storage: memoryStorage(),
    credentials: () => ["sk-ant-oat01-A"]
  });
  const rule = claudeCodeEgress({ pool: () => pool, now: () => NOW });
  return sandboxEgress(request, egressPlan([rule], SANDBOX).http, {}, [rule]);
}

/** The verified version's model call. */
const RECORDED_CALL = capture.requests.find(
  (request) =>
    request.method === "POST" && request.path.startsWith("/v1/messages")
)!;

describe("claudeCodeEgress, on what the verified version sends", () => {
  /**
   * Every request, not only the model call: a request shape the swap missed
   * would send the placeholder upstream.
   */
  it("swaps the credential on every request the verified version makes", async () => {
    for (const request of capture.requests) {
      const { calls } = upstream([]);
      await sendRecorded(recorded(request));

      expect(calls[0]?.headers.get("authorization")).toBe(
        "Bearer sk-ant-oat01-A"
      );
      expect([...(calls[0]?.headers.values() ?? [])].join(" ")).not.toContain(
        CREDENTIAL_PLACEHOLDER
      );
      vi.restoreAllMocks();
    }
  });

  /**
   * `claude-code-20250219` and `oauth-2025-04-20` are almost certainly part of
   * what marks this as the sanctioned client — the same subscription credential
   * 429s at zero tokens against the raw Messages API. Normalising or reordering
   * these headers is the kind of helpfulness that would break the whole premise.
   */
  it("forwards the beta list and user-agent untouched", async () => {
    const { calls } = upstream([]);
    await sendRecorded(recorded(RECORDED_CALL, "{}"));

    expect(calls[0]?.headers.get("anthropic-beta")).toBe(
      RECORDED_CALL.headers["anthropic-beta"]
    );
    expect(calls[0]?.headers.get("user-agent")).toBe(
      RECORDED_CALL.headers["user-agent"]
    );
  });

  it("keeps the method, the query string and the body", async () => {
    const { calls } = upstream([]);
    await sendRecorded(recorded(RECORDED_CALL, '{"model":"claude-opus-5"}'));

    expect(calls[0]?.method).toBe("POST");
    expect(new URL(calls[0]!.url).search).toBe("?beta=true");
    expect(await calls[0]?.text()).toBe('{"model":"claude-opus-5"}');
  });
});

describe("claudeCodeEgress's rule", () => {
  it("declares the CLI's placeholder host over the real API, and leaves the CLI's environment to the daemon", () => {
    const rule = claudeCodeEgress();
    expect(rule.http).toEqual({
      [ANTHROPIC_PLACEHOLDER_HOST]: "https://api.anthropic.com"
    });
    expect(rule.https).toBeUndefined();
    expect(rule.env).toBeUndefined();
  });

  it("leases from the sandbox the request came from", async () => {
    upstream([]);
    const pool = credentialHost({
      storage: memoryStorage(),
      credentials: () => ["sk-ant-oat01-A"]
    });
    const reached: string[] = [];
    const env = {
      CODING_SANDBOX: {
        getByName(name: string): CredentialLease {
          reached.push(name);
          return pool;
        }
      }
    };
    expect((await send(claudeCodeEgress(), env)()).status).toBe(200);
    expect(reached).toEqual(["slot-1"]);
  });

  it("names a sandbox the Worker cannot reach, rather than sending the placeholder on", async () => {
    const { calls } = upstream([]);
    await expect(send(claudeCodeEgress(), {})()).rejects.toThrow(
      /names no sandbox/
    );
    expect(calls).toHaveLength(0);
  });
});
