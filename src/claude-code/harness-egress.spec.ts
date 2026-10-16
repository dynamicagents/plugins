import { afterEach, describe, expect, it, vi } from "vitest";
import { egressPlan, sandboxEgress } from "../sandbox/egress.js";
import {
  claudeCodeSandboxEgress,
  credentialHost,
  type CredentialLease
} from "./harness-egress.js";
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
  return send(
    claudeCodeSandboxEgress({ pool: () => pool, now: () => NOW }),
    {}
  );
}

/** A request the CLI makes, through the routes a sandbox registers for `rule`. */
function send(
  rule: ReturnType<typeof claudeCodeSandboxEgress>,
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

describe("claudeCodeSandboxEgress", () => {
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

describe("claudeCodeSandboxEgress's rule", () => {
  it("declares the CLI's placeholder host over the real API, and leaves the CLI's environment to the daemon", () => {
    const rule = claudeCodeSandboxEgress();
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
    expect((await send(claudeCodeSandboxEgress(), env)()).status).toBe(200);
    expect(reached).toEqual(["slot-1"]);
  });

  it("names a sandbox the Worker cannot reach, rather than sending the placeholder on", async () => {
    const { calls } = upstream([]);
    await expect(send(claudeCodeSandboxEgress(), {})()).rejects.toThrow(
      /names no sandbox/
    );
    expect(calls).toHaveLength(0);
  });
});
