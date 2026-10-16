import { afterEach, describe, expect, it, vi } from "vitest";
import {
  egressPlan,
  forward,
  sandboxEgress,
  type EgressCall,
  type SandboxEgressRule
} from "./egress.js";

/** A rule that answers with what it was handed, and forwards nothing. */
function echoRule(
  name: string,
  hosts: { http?: Record<string, string>; https?: Record<string, string> },
  env?: Record<string, string>
): SandboxEgressRule & { calls: EgressCall[] } {
  const calls: EgressCall[] = [];
  return {
    name,
    ...hosts,
    ...(env ? { env } : {}),
    calls,
    async handle(call) {
      calls.push(call);
      return new Response(call.target.toString());
    }
  };
}

const GIT = echoRule("git", {
  http: { "git.harness.internal": "https://git.example.com" }
});
const API = echoRule("api", {
  https: { "api.example.com": "https://api.example.com/v3/" }
});

afterEach(() => vi.restoreAllMocks());

describe("egressPlan", () => {
  it("stamps every route with the sandbox that registers it, and merges the rules' environment", () => {
    const plan = egressPlan(
      [
        echoRule(
          "a",
          { http: { "a.internal": "https://a.example.com" } },
          { A: "1" }
        ),
        echoRule(
          "b",
          { https: { "b.example.com": "https://b.example.com" } },
          { B: "2" }
        )
      ],
      "SANDBOX/one"
    );
    expect(plan.http.map((route) => route.host)).toEqual(["a.internal"]);
    expect(plan.https.map((route) => route.host)).toEqual(["b.example.com"]);
    for (const route of [...plan.http, ...plan.https])
      expect(Object.values(route.headers)).toEqual(["SANDBOX/one"]);
    expect(plan.env).toEqual({ A: "1", B: "2" });
  });

  it("refuses a host two rules declare, over either protocol", () => {
    expect(() =>
      egressPlan([
        echoRule("a", { http: { "x.internal": "https://x.example.com" } }),
        echoRule("b", { https: { "x.internal": "https://x.example.com" } })
      ])
    ).toThrow(/x\.internal is declared by both a and b/);
  });

  it("refuses an environment key two rules set", () => {
    expect(() =>
      egressPlan([
        echoRule("a", {}, { TOKEN: "a" }),
        echoRule("b", {}, { TOKEN: "b" })
      ])
    ).toThrow(/TOKEN is set by both a and b/);
  });

  it("refuses an upstream that is not https", () => {
    expect(() =>
      egressPlan([
        echoRule("a", { http: { "x.internal": "http://x.example.com" } })
      ])
    ).toThrow(/not https/);
  });
});

describe("sandboxEgress", () => {
  const routes = egressPlan([GIT, API], "SANDBOXES/caller");
  const all = [...routes.http, ...routes.https];

  it("hands a request to the rule serving its host, aimed at that rule's upstream", async () => {
    const response = await sandboxEgress(
      new Request("https://api.example.com/repos/a/b?page=2"),
      all,
      {},
      [GIT, API]
    );
    expect(await response.text()).toBe(
      "https://api.example.com/v3/repos/a/b?page=2"
    );
    expect(API.calls.at(-1)?.request.url).toBe(
      "https://api.example.com/repos/a/b?page=2"
    );
  });

  it("refuses a host this container never registered", async () => {
    const response = await sandboxEgress(
      new Request("http://git.harness.internal/"),
      routes.https,
      {},
      [GIT, API]
    );
    expect(response.status).toBe(403);
  });

  it("refuses a registered host no rule serves", async () => {
    const response = await sandboxEgress(
      new Request("http://git.harness.internal/"),
      all,
      {},
      [API]
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/No egress rule/);
  });

  it("reaches the sandbox the route names, by the name it was reached by", async () => {
    const reached: string[] = [];
    const env = {
      SANDBOXES: {
        getByName(name: string) {
          reached.push(name);
          return { name };
        }
      }
    };
    await sandboxEgress(new Request("http://git.harness.internal/"), all, env, [
      GIT
    ]);
    expect(GIT.calls.at(-1)?.sandbox()).toEqual({ name: "caller" });
    expect(reached).toEqual(["caller"]);
  });

  it("names a route that reaches no sandbox, rather than calling the wrong one", async () => {
    const unnamed = egressPlan([GIT]).http;
    await sandboxEgress(
      new Request("http://git.harness.internal/"),
      unnamed,
      {},
      [GIT]
    );
    expect(() => GIT.calls.at(-1)?.sandbox()).toThrow(/names no sandbox/);
  });
});

describe("forward", () => {
  it("sends the method, the body and the rewritten headers to the target, following no redirect", async () => {
    const sent: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push(new Request(input as RequestInfo, init));
      return new Response("ok");
    });
    const call: EgressCall = {
      request: new Request("http://git.harness.internal/x", {
        method: "POST",
        headers: { authorization: "Bearer placeholder", "x-kept": "1" },
        body: "payload"
      }),
      target: new URL("https://git.example.com/x"),
      env: {},
      sandbox: () => {
        throw new Error("unused");
      }
    };
    await forward(call, (headers) => headers.set("authorization", "real"));
    expect(sent[0]?.url).toBe("https://git.example.com/x");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.redirect).toBe("manual");
    expect(sent[0]?.headers.get("authorization")).toBe("real");
    expect(sent[0]?.headers.get("x-kept")).toBe("1");
    expect(await sent[0]?.text()).toBe("payload");
  });
});
