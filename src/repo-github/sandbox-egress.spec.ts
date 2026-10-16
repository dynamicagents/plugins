import { afterEach, describe, expect, it, vi } from "vitest";
import { egressPlan, sandboxEgress } from "../sandbox/egress.js";
import {
  branchAllowed,
  GITHUB_TOKEN_PLACEHOLDER,
  gitTarget,
  githubSandboxEgress,
  receivePackRefs
} from "./sandbox-egress.js";

const TOKEN = "github_pat_real";
const ENV = { GITHUB_TOKEN: TOKEN };
const POLICY = {
  repos: ["dynamicagents/plugins"],
  branches: ["claude-coordinator/*"]
};
const RULE = githubSandboxEgress({
  tokenBinding: "GITHUB_TOKEN",
  push: POLICY,
  api: true
});
const PLAN = egressPlan([RULE], "SANDBOX/caller");
const ROUTES = [...PLAN.http, ...PLAN.https];

/** A request the container makes, through the routes a sandbox registers for {@link RULE}. */
const send = (request: Request, env: Record<string, unknown> = ENV) =>
  sandboxEgress(request, ROUTES, env, [RULE]);

/**
 * GitHub, as the egress meets it: `lookups` are its reads of a repository's
 * default branch, which `defaultBranch` answers, and `calls` everything it
 * forwarded.
 */
function upstream(defaultBranch: string | null = "trunk-line"): {
  calls: Request[];
  lookups: Request[];
} {
  const calls: Request[] = [];
  const lookups: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(request.url)) {
      lookups.push(request);
      return defaultBranch === null
        ? new Response("{}", { status: 502 })
        : Response.json({ default_branch: defaultBranch });
    }
    calls.push(request);
    return new Response("upstream", { status: 200 });
  });
  return { calls, lookups };
}

const basic = (password: string) =>
  `Basic ${btoa(`x-access-token:${password}`)}`;

/** A receive-pack body updating `refs`, as git writes it: pkt-lines, a flush, then the pack. */
function receivePack(refs: string[]): ArrayBuffer {
  const zero = "0".repeat(40);
  const one = "1".repeat(40);
  const encoder = new TextEncoder();
  const lines = refs.map((ref, i) => {
    const payload = `${zero} ${one} ${ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`;
    const length = encoder.encode(payload).byteLength + 4;
    return length.toString(16).padStart(4, "0") + payload;
  });
  const bytes = encoder.encode(`${lines.join("")}0000PACK....`);
  return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
}

const streamOf = (text: string) => new Blob([text]).stream();

/**
 * A push as git streams it: the commands, then pack chunks produced only as
 * they are read, so nothing is buffered ahead of the reader.
 */
function streamedPush(refs: string[], packChunks: number) {
  const commands = new Uint8Array(receivePack(refs));
  const chunk = new Uint8Array(4096).fill(0x50);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === 0) controller.enqueue(commands);
        else if (pulled <= packChunks) controller.enqueue(chunk);
        else controller.close();
        pulled += 1;
      }
    },
    { highWaterMark: 0 }
  );
  return { stream, bytes: commands.byteLength + packChunks * chunk.byteLength };
}

const push = (body: BodyInit) =>
  send(
    new Request(`https://github.com/dynamicagents/plugins/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) },
      body
    })
  );

afterEach(() => vi.restoreAllMocks());

describe("githubSandboxEgress", () => {
  it("lets an anonymous request through anonymous, at the real host", async () => {
    const { calls } = upstream();
    await send(
      new Request(
        `https://github.com/dynamicagents/plugins/info/refs?service=git-upload-pack`
      )
    );
    expect(calls[0]?.url).toBe(
      "https://github.com/dynamicagents/plugins/info/refs?service=git-upload-pack"
    );
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("swaps the placeholder for the token in the scheme it came in, and sends no x-da-* header", async () => {
    const { calls } = upstream();
    await send(
      new Request(
        `https://github.com/dynamicagents/plugins/info/refs?service=git-receive-pack`,
        { headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) } }
      )
    );
    expect(calls[0]?.headers.get("authorization")).toBe(basic(TOKEN));
    for (const [name] of calls[0]?.headers ?? [])
      expect(name).not.toMatch(/^x-da-/);

    await send(
      new Request("https://api.github.com/repos/dynamicagents/plugins/pulls", {
        headers: { authorization: `Bearer ${GITHUB_TOKEN_PLACEHOLDER}` }
      })
    );
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/dynamicagents/plugins/pulls"
    );
    expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a credentialed git request for a repository outside the policy", async () => {
    const { calls } = upstream();
    const response = await send(
      new Request(
        `https://github.com/someone/else/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) } }
      )
    );
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("pushes the branches the policy allows, and refuses the rest before GitHub sees them", async () => {
    const { calls } = upstream();
    expect(
      (await push(receivePack(["refs/heads/claude-coordinator/ab12c"]))).status
    ).toBe(200);
    const refused = await push(
      receivePack(["refs/heads/claude-coordinator/ab12c", "refs/heads/main"])
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/refs\/heads\/main/);
    expect((await push(receivePack(["refs/tags/v1"]))).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("reads a streamed push's refs without waiting on the pack, and forwards all of it", async () => {
    const { calls } = upstream();
    const { stream, bytes } = streamedPush(
      ["refs/heads/claude-coordinator/ab12c"],
      64
    );
    expect((await push(stream)).status).toBe(200);
    expect((await calls[0]!.arrayBuffer()).byteLength).toBe(bytes);
  });

  it("forwards the whole push, pack included, and refuses one that names no ref", async () => {
    const { calls } = upstream();
    const sent = receivePack(["refs/heads/claude-coordinator/ab12c"]);
    expect((await push(sent)).status).toBe(200);
    expect(new Uint8Array(await calls[0]!.arrayBuffer())).toEqual(
      new Uint8Array(sent)
    );
    expect((await push(receivePack([]))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("holds every push, with no policy, to what repo_push may update", async () => {
    const { calls, lookups } = upstream();
    const open = githubSandboxEgress({ tokenBinding: "GITHUB_TOKEN" });
    const routes = egressPlan([open], "SANDBOX/caller").https;
    const pushTo = (repo: string, refs: string[]) =>
      sandboxEgress(
        new Request(`https://github.com/${repo}/git-receive-pack`, {
          method: "POST",
          headers: { authorization: basic(GITHUB_TOKEN_PLACEHOLDER) },
          body: receivePack(refs)
        }),
        routes,
        ENV,
        [open]
      );
    // Any repository, and any work branch.
    expect((await pushTo("someone/else", ["refs/heads/fix/x"])).status).toBe(
      200
    );
    // The default branch, read with the real token, whatever it is called.
    const toDefault = await pushTo("someone/else", ["refs/heads/trunk-line"]);
    expect(toDefault.status).toBe(403);
    expect(await toDefault.text()).toMatch(/default branch/);
    expect(lookups.at(-1)?.url).toBe(
      "https://api.github.com/repos/someone/else"
    );
    expect(lookups.at(-1)?.headers.get("authorization")).toBe(
      `Bearer ${TOKEN}`
    );
    // A protected name, and a tag.
    expect((await pushTo("someone/else", ["refs/heads/main"])).status).toBe(
      403
    );
    expect((await pushTo("someone/else", ["refs/tags/v1"])).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("pushes nothing when the default branch cannot be read", async () => {
    const { calls } = upstream(null);
    const response = await push(
      receivePack(["refs/heads/claude-coordinator/ab12c"])
    );
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("names the missing token rather than sending the placeholder on", async () => {
    const { calls } = upstream();
    const response = await send(
      new Request("https://api.github.com/user", {
        headers: { authorization: `token ${GITHUB_TOKEN_PLACEHOLDER}` }
      }),
      {}
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("the rule a sandbox carries", () => {
  it("intercepts github.com itself and rewrites no URL, so a remote reads back as cloned", () => {
    expect(RULE.http).toBeUndefined();
    expect(RULE.env?.GIT_CONFIG_KEY_0).toBe(
      "credential.https://github.com.helper"
    );
    expect(RULE.env?.GIT_CONFIG_VALUE_0).toContain(GITHUB_TOKEN_PLACEHOLDER);
    // What `/repo` and `gh` read a checkout's origin through: an `insteadOf`
    // would rewrite it to a host neither recognises.
    for (const [key, value] of Object.entries(RULE.env ?? {})) {
      expect(key).not.toMatch(/insteadof/i);
      expect(value).not.toMatch(/insteadof/i);
    }
  });

  it("gives `gh` the placeholder and intercepts the API only where the API is allowed", () => {
    expect(RULE.https).toEqual({
      "github.com": "https://github.com",
      "api.github.com": "https://api.github.com"
    });
    expect(RULE.env?.GH_TOKEN).toBe(GITHUB_TOKEN_PLACEHOLDER);
    const gitOnly = githubSandboxEgress({
      tokenBinding: "GITHUB_TOKEN",
      push: POLICY
    });
    expect(gitOnly.https).toEqual({ "github.com": "https://github.com" });
    expect(gitOnly.env).not.toHaveProperty("GH_TOKEN");
  });
});

describe("the push's refs", () => {
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

  it("reads a ref as the UTF-8 git wrote it", async () => {
    expect(
      await receivePackRefs(
        new Blob([receivePack(["refs/heads/claude-coordinator/é"])]).stream(),
        null
      )
    ).toEqual(["refs/heads/claude-coordinator/é"]);
  });

  it("refuses a streamed push's disallowed ref without waiting on the pack", async () => {
    const { calls } = upstream();
    const { stream } = streamedPush(["refs/heads/main"], 64);
    const [inspected, rest] = stream.tee();
    expect(await receivePackRefs(inspected, null)).toEqual(["refs/heads/main"]);
    void rest.cancel();
    expect(calls).toHaveLength(0);
  });

  it("refuses a command list git would not have written, rather than reading past it", async () => {
    for (const body of ["00051-001", "0+3fabc", "0003", "zzzz", "fff1"]) {
      await expect(receivePackRefs(streamOf(body), null)).rejects.toThrow();
    }
  });
});

describe("GitHub helpers", () => {
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
