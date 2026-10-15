import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxEgress } from "../sandbox/egress.js";
import {
  ANTHROPIC_ROUTE_KIND,
  anthropicEgress,
  anthropicRoute,
  credentialHost
} from "./harness-egress.js";
import { ANTHROPIC_PLACEHOLDER_HOST } from "./harness-wire.js";
import { CREDENTIAL_PLACEHOLDER } from "./placeholder.js";

/**
 * The Anthropic credential on the Worker side of a sandbox: the same rules as
 * the workspace gateway, over a pool the sandbox object holds.
 */

// The pool reads the real clock, so this one is now, to the second.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const ROUTE = anthropicRoute("CODING_SANDBOX/slot-1");

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
  const handler = anthropicEgress({ pool: () => pool, now: () => NOW });
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
      [ROUTE],
      {},
      { [ANTHROPIC_ROUTE_KIND]: handler }
    );
}

afterEach(() => vi.restoreAllMocks());

describe("anthropicEgress", () => {
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

describe("anthropicRoute", () => {
  it("is the placeholder host over the real https upstream, naming its sandbox", () => {
    expect(ROUTE).toMatchObject({
      host: ANTHROPIC_PLACEHOLDER_HOST,
      upstream: "https://api.anthropic.com",
      headers: {
        "x-da-kind": ANTHROPIC_ROUTE_KIND,
        "x-da-sandbox": "CODING_SANDBOX/slot-1"
      }
    });
  });

  it("refuses a route whose sandbox binding is not in the Worker's env", async () => {
    upstream([]);
    await expect(
      sandboxEgress(
        new Request(`http://${ANTHROPIC_PLACEHOLDER_HOST}/v1/messages`),
        [ROUTE],
        {},
        { [ANTHROPIC_ROUTE_KIND]: anthropicEgress() }
      )
    ).rejects.toThrow(/names no sandbox binding/);
  });
});
