import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRoute, ROUTE_SANDBOX, sandboxEgress } from "./egress.js";
import {
  branchAllowed,
  GITHUB_PLACEHOLDER_HOST,
  GITHUB_TOKEN_PLACEHOLDER,
  gitTarget,
  githubEnv,
  receivePackRefs
} from "./github.js";

const TOKEN = "github_pat_real";
const ENV = { GITHUB_TOKEN: TOKEN };
const POLICY = {
  repos: ["dynamicagents/plugins"],
  branches: ["claude-coordinator/*"]
};
const GIT = githubRoute({
  host: GITHUB_PLACEHOLDER_HOST,
  upstream: "https://github.com",
  tokenBinding: "GITHUB_TOKEN",
  push: POLICY
});
const API = githubRoute({
  host: "api.github.com",
  upstream: "https://api.github.com",
  tokenBinding: "GITHUB_TOKEN"
});

function upstream(): { calls: Request[] } {
  const calls: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push(new Request(input as RequestInfo, init));
    return new Response("upstream", { status: 200 });
  });
  return { calls };
}

const basic = (password: string) =>
  `Basic ${btoa(`x-access-token:${password}`)}`;

/** A receive-pack body updating `refs`, as git writes it: pkt-lines, a flush, then the pack. */
function receivePack(refs: string[]): ArrayBuffer {
  const zero = "0".repeat(40);
  const one = "1".repeat(40);
  const lines = refs.map((ref, i) => {
    const payload = `${zero} ${one} ${ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`;
    return (payload.length + 4).toString(16).padStart(4, "0") + payload;
  });
  const bytes = new TextEncoder().encode(`${lines.join("")}0000PACK....`);
  return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
}

afterEach(() => vi.restoreAllMocks());

describe("sandboxEgress — GitHub", () => {
  it("lets an anonymous request through anonymous, at the real host", async () => {
    const { calls } = upstream();
    await sandboxEgress(
      new Request(
        `http://${GITHUB_PLACEHOLDER_HOST}/dynamicagents/plugins/info/refs?service=git-upload-pack`
      ),
      [GIT],
      ENV
    );
    expect(calls[0]?.url).toBe(
      "https://github.com/dynamicagents/plugins/info/refs?service=git-upload-pack"
    );
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("swaps the placeholder for the token in the scheme it came in, and sends no x-da-* header", async () => {
    const { calls } = upstream();
    await sandboxEgress(
      new Request(
        `http://${GITHUB_PLACEHOLDER_HOST}/dynamicagents/plugins/info/refs?service=git-receive-pack`,
        {
          headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) }
        }
      ),
      [GIT],
      ENV
    );
    expect(calls[0]?.headers.get("authorization")).toBe(basic(TOKEN));
    for (const [name] of calls[0]?.headers ?? [])
      expect(name).not.toMatch(/^x-da-/);

    await sandboxEgress(
      new Request("https://api.github.com/repos/dynamicagents/plugins/pulls", {
        headers: { authorization: `Bearer ${GITHUB_TOKEN_PLACEHOLDER}` }
      }),
      [API],
      ENV
    );
    expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a credentialed request for a repository outside the policy", async () => {
    const { calls } = upstream();
    const response = await sandboxEgress(
      new Request(
        `http://${GITHUB_PLACEHOLDER_HOST}/someone/else/info/refs?service=git-upload-pack`,
        {
          headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) }
        }
      ),
      [GIT],
      ENV
    );
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("pushes the branches the policy allows, and refuses the rest before GitHub sees them", async () => {
    const { calls } = upstream();
    const push = (refs: string[]) =>
      sandboxEgress(
        new Request(
          `http://${GITHUB_PLACEHOLDER_HOST}/dynamicagents/plugins/git-receive-pack`,
          {
            method: "POST",
            headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) },
            body: receivePack(refs)
          }
        ),
        [GIT],
        ENV
      );
    expect((await push(["refs/heads/claude-coordinator/ab12c"])).status).toBe(
      200
    );
    const refused = await push([
      "refs/heads/claude-coordinator/ab12c",
      "refs/heads/main"
    ]);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/refs\/heads\/main/);
    expect((await push(["refs/tags/v1"])).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("reads the refs of a gzipped receive-pack body", async () => {
    const gz = new Blob([
      receivePack([
        "refs/heads/claude-coordinator/x",
        "refs/heads/claude-coordinator/y"
      ])
    ])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    expect(await receivePackRefs(gz, "gzip")).toEqual([
      "refs/heads/claude-coordinator/x",
      "refs/heads/claude-coordinator/y"
    ]);
  });

  it("forwards the whole push, pack included, and refuses one that names no ref", async () => {
    const { calls } = upstream();
    const sent = receivePack(["refs/heads/claude-coordinator/ab12c"]);
    const push = (body: ArrayBuffer) =>
      sandboxEgress(
        new Request(
          `http://${GITHUB_PLACEHOLDER_HOST}/dynamicagents/plugins/git-receive-pack`,
          {
            method: "POST",
            headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) },
            body
          }
        ),
        [GIT],
        ENV
      );
    expect((await push(sent)).status).toBe(200);
    expect(new Uint8Array(await calls[0]!.arrayBuffer())).toEqual(
      new Uint8Array(sent)
    );
    expect((await push(receivePack([]))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("names the missing token rather than sending the placeholder on", async () => {
    const { calls } = upstream();
    const response = await sandboxEgress(
      new Request("https://api.github.com/user", {
        headers: { authorization: `token ${GITHUB_TOKEN_PLACEHOLDER}` }
      }),
      [API],
      {}
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("sandboxEgress — routing", () => {
  it("refuses a host with no route", async () => {
    upstream();
    expect(
      (
        await sandboxEgress(
          new Request("http://elsewhere.internal/"),
          [GIT],
          ENV
        )
      ).status
    ).toBe(403);
  });

  it("hands a route of another kind to its handler, with the route's x-da-* values", async () => {
    upstream();
    const seen: Record<string, string>[] = [];
    const route = {
      host: "anthropic.harness.internal",
      upstream: "https://api.anthropic.com",
      headers: {
        "x-da-kind": "anthropic",
        [ROUTE_SANDBOX]: "SANDBOX/caller|repo"
      },
      strip: []
    };
    const response = await sandboxEgress(
      new Request("http://anthropic.harness.internal/v1/messages"),
      [route],
      ENV,
      {
        anthropic: async (call) => {
          seen.push({ ...call.control });
          return new Response(call.target.toString());
        }
      }
    );
    expect(await response.text()).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]?.[ROUTE_SANDBOX]).toBe("SANDBOX/caller|repo");
  });
});

describe("GitHub helpers", () => {
  it("points git at the placeholder host from the environment, not a gitconfig", () => {
    const env = githubEnv();
    expect(env.GIT_CONFIG_KEY_0).toBe(
      `url.http://${GITHUB_PLACEHOLDER_HOST}/.insteadOf`
    );
    expect(env.GIT_CONFIG_VALUE_0).toBe("https://github.com/");
    expect(env.GH_TOKEN).toBe(GITHUB_TOKEN_PLACEHOLDER);
  });

  it("reads which repository and service a smart-HTTP path is", () => {
    expect(gitTarget("/Dynamicagents/Plugins.git/git-receive-pack")).toEqual({
      repo: "dynamicagents/plugins",
      service: "receive-pack"
    });
    expect(gitTarget("/dynamicagents/plugins/info/refs")).toEqual({
      repo: "dynamicagents/plugins",
      service: undefined
    });
    expect(gitTarget("/repos/dynamicagents/plugins/pulls")).toBeUndefined();
  });

  it("matches branch patterns by prefix only where they end in *", () => {
    expect(branchAllowed(POLICY, "claude-coordinator/x")).toBe(true);
    expect(branchAllowed(POLICY, "claude-coordinator")).toBe(false);
    expect(branchAllowed({ repos: [], branches: ["main"] }, "main")).toBe(true);
    expect(branchAllowed({ repos: [], branches: ["main"] }, "main2")).toBe(
      false
    );
  });
});
