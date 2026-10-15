#!/usr/bin/env node
/**
 * Does GitHub's hosted MCP server behave the way `src/repo/mcp.ts` assumes?
 *
 *   npm run probe:github-mcp              check, and report
 *   npm run probe:github-mcp -- --record  and rewrite the recorded fixture
 *
 * The one thing this package cannot test for itself. Every reader has a spec
 * against `test/fixtures/github-mcp.json`, but that fixture was written from
 * the server's own Go output types rather than observed, because the endpoint
 * answers `401` to every request without a credential. This closes that gap.
 *
 * It needs a GitHub token in `GITHUB_TOKEN` and a pull request to read, as
 * `OWNER/REPO#NUMBER` in `GITHUB_MCP_PROBE_PR`. The token is read from the
 * environment, sent only to the endpoint `mcp.ts` names, and never printed —
 * not in a report, not in a failure, not in the fixture.
 *
 * What it settles, in the order a failure matters:
 *
 *   1. a fine-grained PAT is accepted in `Authorization`, and `initialize`
 *      then `tools/call` is the handshake the client performs;
 *   2. `X-MCP-Tools` gates `tools/call` and not only `tools/list` — a name
 *      outside the list is refused rather than answered;
 *   3. a misspelled name in the list is an error rather than a silent ignore;
 *   4. the read-only endpoint composes with the list, and refuses a write;
 *   5. every method this plugin calls answers in the shape its reader parses,
 *      threads paginate by cursor, and a review's author arrives under a
 *      login the render can show;
 *   6. a stale session id is recoverable.
 *
 * It also reports whether `requested_reviewers` on a pull request with a
 * review still pending names a Bot. Nothing here depends on that — the agent
 * waiting on a review reads `get_reviews` and a timeout, never a pending
 * request — but it is the one fact the plugin's own history and GitHub's e2e
 * test disagree about, and this is where it gets settled.
 *
 * A failed check exits 1. `--record` writes the fixture from what the server
 * answered, and only a passing run may.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "test", "fixtures", "github-mcp.json");

const MCP_URL = "https://api.githubcopilot.com/mcp/readonly";
const MCP_TOOLS = "pull_request_read,issue_read";
const PROTOCOL = "2025-06-18";

const record = process.argv.includes("--record");
const token = process.env.GITHUB_TOKEN;
const target = process.env.GITHUB_MCP_PROBE_PR;

if (!token) {
  console.error(
    "GITHUB_TOKEN is not set. A fine-grained PAT with pull-requests:read on the\n" +
      "repository below is enough; this never prints it."
  );
  process.exit(2);
}
const parsed = /^([^/]+)\/([^#]+)#(\d+)$/.exec(target ?? "");
if (!parsed) {
  console.error(
    "GITHUB_MCP_PROBE_PR must be OWNER/REPO#NUMBER — a pull request the token\n" +
      "can read, ideally one Copilot has reviewed."
  );
  process.exit(2);
}
const [, owner, repo, number] = parsed;
const pullNumber = Number(number);

/** Never let the credential reach a report, however a failure is formatted. */
const scrub = (text) => String(text).split(token).join("«token»");

const failures = [];
const notes = [];
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${scrub(detail)}` : ""}`
  );
  if (!ok) failures.push(name);
};

/** One JSON-RPC exchange, in whichever encoding the server chose. */
async function rpc(body, { tools = MCP_TOOLS, session, url = MCP_URL } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "dynamicagents-probe"
  };
  if (tools !== null) headers["x-mcp-tools"] = tools;
  if (session) {
    headers["mcp-protocol-version"] = session.protocolVersion;
    if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let envelope;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) envelope = JSON.parse(data);
    }
  } else if (text) {
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = undefined;
    }
  }
  return { response, text, envelope };
}

async function open(opts = {}) {
  const { response, envelope } = await rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "dynamicagents-probe", version: "1" }
      }
    },
    opts
  );
  if (!response.ok || envelope?.error) return { response, envelope };
  const session = {
    protocolVersion: envelope?.result?.protocolVersion ?? PROTOCOL,
    sessionId: response.headers.get("mcp-session-id") ?? undefined
  };
  await rpc(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { ...opts, session }
  ).catch(() => undefined);
  return { response, envelope, session };
}

const call = (session, name, args, opts = {}) =>
  rpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args }
    },
    { ...opts, session }
  );

/** The text block, which is the contract — see `toolText` in `src/repo/mcp.ts`. */
const parsed_ = ({ envelope }) => {
  const text = (envelope?.result?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const where = { owner, repo, pullNumber };
const recorded = {};

// 1. A PAT, and the handshake.
const opened = await open();
check(
  "P1 a personal access token is accepted on initialize",
  opened.response.ok && !opened.envelope?.error,
  opened.response.ok ? "" : `HTTP ${opened.response.status}`
);
if (!opened.session) {
  console.error("\nWithout a session nothing below can run.");
  process.exit(1);
}
notes.push(
  `session id: ${opened.session.sessionId ? "issued" : "none — the server is stateless"}`
);

// 2. The allowlist gates tools/call, not only tools/list.
const excluded = await call(opened.session, "merge_pull_request", {
  ...where,
  method: "merge"
});
check(
  "P2 a tool outside X-MCP-Tools is refused at tools/call",
  Boolean(excluded.envelope?.error) ||
    excluded.envelope?.result?.isError === true,
  excluded.envelope?.error?.message ?? ""
);

// 3. A misspelled name in the list.
const misspelled = await open({ tools: `${MCP_TOOLS},definitely_not_a_tool` });
check(
  "P3 an invalid name in X-MCP-Tools is an error, not a silent ignore",
  !misspelled.response.ok || Boolean(misspelled.envelope?.error),
  misspelled.response.ok
    ? "accepted — the list is being filtered rather than validated"
    : `HTTP ${misspelled.response.status}`
);

// 4. The read-only endpoint refuses a write even when one is allowlisted.
const writeable = await open({
  tools: "pull_request_read,issue_read,issue_write"
});
if (writeable.session) {
  const refused = await call(writeable.session, "issue_write", {
    owner,
    repo,
    method: "update",
    issue_number: pullNumber,
    title: "probe must never land this"
  });
  check(
    "P4 /readonly refuses a write even when the list admits one",
    Boolean(refused.envelope?.error) ||
      refused.envelope?.result?.isError === true,
    refused.envelope?.error?.message ?? ""
  );
} else {
  check(
    "P4 /readonly refuses a write even when the list admits one",
    false,
    "could not open a session with a write tool listed"
  );
}

// 5. Every method a reader parses.
for (const [key, args] of [
  ["pull_request_read:get", { ...where, method: "get" }],
  [
    "pull_request_read:get_files",
    { ...where, method: "get_files", perPage: 100 }
  ],
  [
    "pull_request_read:get_reviews",
    { ...where, method: "get_reviews", perPage: 100 }
  ],
  [
    "pull_request_read:get_review_comments",
    { ...where, method: "get_review_comments", perPage: 100 }
  ],
  [
    "pull_request_read:get_check_runs",
    { ...where, method: "get_check_runs", perPage: 100 }
  ],
  [
    "pull_request_read:get_status",
    { ...where, method: "get_status", perPage: 100 }
  ],
  ["issue_read:get", { owner, repo, issue_number: pullNumber, method: "get" }],
  [
    "issue_read:get_comments",
    {
      owner,
      repo,
      issue_number: pullNumber,
      method: "get_comments",
      perPage: 100
    }
  ]
]) {
  const answered = await call(opened.session, key.split(":")[0], args);
  const data = parsed_(answered);
  check(
    `P5 ${key} answers in a shape the reader parses`,
    data !== undefined,
    answered.envelope?.error?.message ?? ""
  );
  if (data !== undefined) recorded[key] = data;
}

// The fields each render actually reads, named one by one: a renamed field is
// read as absent rather than as an error, which is the failure a shape check
// alone would pass.
const pr = recorded["pull_request_read:get"];
check(
  "P5 a pull request carries mergeable_state, head.ref and html_url",
  Boolean(pr && "mergeable_state" in pr && pr.head?.ref && pr.html_url),
  pr ? `keys: ${Object.keys(pr).join(",")}` : ""
);
const threads = recorded["pull_request_read:get_review_comments"];
check(
  "P5 review threads carry id, is_resolved and cursor page_info",
  Boolean(
    threads &&
    Array.isArray(threads.review_threads) &&
    threads.page_info &&
    "has_next_page" in threads.page_info &&
    (threads.review_threads.length === 0 ||
      ("id" in threads.review_threads[0] &&
        "is_resolved" in threads.review_threads[0]))
  ),
  threads ? `total_count: ${threads.total_count}` : ""
);
const status = recorded["pull_request_read:get_status"];
check(
  "P5 the combined status reports the sha repo_pr_checks renders",
  Boolean(status?.sha),
  status ? `state: ${status.state}` : ""
);
const issue = recorded["issue_read:get"];
check(
  "P5 issue_read answers for a pull request number, with a /pull/ url",
  Boolean(issue?.html_url?.includes("/pull/")),
  issue ? `html_url: ${issue.html_url}` : ""
);

// 6. A stale session.
const stale = await call(
  { protocolVersion: PROTOCOL, sessionId: "probe-not-a-session" },
  "pull_request_read",
  { ...where, method: "get" }
);
notes.push(
  `a stale Mcp-Session-Id answers HTTP ${stale.response.status}` +
    (stale.response.status === 404
      ? " — which is what mcp.ts renegotiates on"
      : " — mcp.ts only renegotiates on 404; check that this is still right")
);

// Informational: the contested pending-review signal.
notes.push(
  `requested_reviewers on this pull request: ${
    pr?.requested_reviewers?.length
      ? JSON.stringify(pr.requested_reviewers)
      : "absent or empty"
  } — the plugin does not read it either way`
);

console.log("\nNotes:");
for (const note of notes) console.log(`  - ${scrub(note)}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

if (record) {
  const existing = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(
    FIXTURE,
    `${JSON.stringify(
      {
        _: [
          "One answer per MCP method this plugin calls, in the shape GitHub's",
          "hosted server marshals into a tool result's text block.",
          "`src/repo/index.spec.ts` runs each reader against these.",
          "",
          "RECORDED by `npm run probe:github-mcp -- --record` from a live pull",
          "request. Re-record rather than editing by hand; a spec asserting a",
          "field nobody observed is the thing this file exists to prevent.",
          "",
          "Keyed `<tool>:<method>`. Values are the parsed result, not the",
          "envelope: the transport's own framing is asserted separately."
        ],
        ...recorded
      },
      null,
      2
    )}\n`
  );
  console.log(
    `\nRecorded ${Object.keys(recorded).length} answers into ${FIXTURE}` +
      `${existing._ ? "" : ""}. Run \`npm test\` against it.`
  );
}

console.log("\nEvery check passed.");
