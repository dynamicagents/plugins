#!/usr/bin/env node
/**
 * Does a Claude Code version work with this package's egress gateway and stream
 * parser? The check a version bump needs, run without a container.
 *
 *   npm run probe:claude-code                   the registry's `latest`
 *   npm run probe:claude-code -- <version>      a version, or any dist-tag
 *   npm run probe:claude-code -- --record       and make it the verified one
 *   npm run probe:claude-code -- --live         the real API, not a fake one
 *   npm run probe:claude-code -- --keep         keep the temporary directory
 *
 * It stands in for the sandbox. The CLI is installed into a temporary
 * directory and launched with the command, stdin and environment the daemon's
 * `claudeCodeDaemonCli` gives a turn, and its lines are read by that same
 * adapter's parser. Its traffic goes to the placeholder host the daemon points
 * it at, over plain HTTP, through a local proxy standing in for the harness's
 * interception: every request goes through the real `sandboxEgress` and
 * `claudeCodeEgress`, leasing from a `credentialHost` pool, and on to a
 * fake Anthropic that streams a canned reply, or with `--live` to the real API
 * on `CLAUDE_CODE_OAUTH_TOKEN`. A session is
 * run once and resumed as a writer's warning turn is; a planning run — a
 * named schema under `plan`, as a run header asks — is forked under the default
 * mode, the way a plan is carried out; and finally a resume is asked for a
 * conversation that does not exist — which is what a host hits when the
 * container that held one is gone, and which must cost nothing.
 *
 * A failed check exits 1. What differs from the recorded capture is reported
 * and is not a failure: it is what a reviewer reads before taking the bump.
 * `--record` writes the capture and the verified version, and only a passing,
 * offline run may: a live run's traffic depends on the account it ran on.
 *
 * What this cannot see is the container itself — the agent user, the
 * platform's interception of the placeholder host, a real 429's rotation.
 * AGENTS.md's "Updating Claude Code" says what covers those.
 *
 * Needs `npm` on the PATH, and reads `dist/`, so the npm script builds first.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE = path.join(root, "test/fixtures/claude-code-probe-capture.json");
const VERIFIED = path.join(root, "src/claude-code/verified.ts");
const PACKAGE = "@anthropic-ai/claude-code";
const HOST = "api.anthropic.com";
const REPLY = "probe-ok";
const RUN_TIMEOUT_MS = 120_000;
/** How long a stopped run gets before it is killed outright. */
const KILL_GRACE_MS = 5_000;
/**
 * A session launched with `--json-schema` answers through the CLI's
 * `StructuredOutput` tool, which the fake calls with this.
 */
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false
};
const STRUCTURED = { answer: REPLY };
/** The tool `--json-schema` gives the model, by the name the CLI gives it. */
const STRUCTURED_TOOL = "StructuredOutput";
/**
 * A skill written into the run's checkout, named by a run header the way a
 * caller names the process a session is to follow.
 *
 * This is the one leg that cannot be reasoned out from the CLI's documentation:
 * the pinned version has no `--skill` flag, so a skill is selected by a `/name`
 * first line, and whether that line is read as a command or as the first words
 * of the prompt is a property of how the prompt arrives — here, on stdin, as
 * the daemon sends it.
 */
const SKILL = "probe-discovery";
/** A sentence only the skill's body carries, so its arrival is observable. */
const SKILL_SENTINEL = "probe-skill-body-7f3a";
/** The last words of the brief, so a brief cut short is visible rather than merely shorter. */
const SKILL_BRIEF_END = "probe-brief-end-2c91";
/**
 * The brief a skilled run is given: several paragraphs, ending in a marker.
 *
 * One line would establish nothing. The `/name` first line is a command and
 * the rest of stdin is its argument, so what has to be measured is where the
 * CLI thinks that argument stops — at the newline, or at the end of the brief.
 * A real one is paragraphs of context, and losing all but its first line would
 * leave a session that ran the right process on the wrong instructions.
 */
const SKILL_BRIEF = [
  `Reply with exactly: ${REPLY}`,
  "",
  "A second paragraph, which a reader that stopped at the first newline never sees.",
  "",
  `End of brief: ${SKILL_BRIEF_END}`
].join("\n");
/**
 * A session id no transcript can be under: a fresh uuid, in a config directory
 * this run created. What a host's resume hits when the container that held the
 * conversation is gone.
 */
const UNKNOWN_SESSION = randomUUID();
/** Carries a request's index through the gateway; removed before upstream. */
const PROBE_ID = "x-claude-code-probe-id";

/**
 * Token counts the fake reports, each distinct and none zero. The result line
 * is read "total by construction" — a renamed field reads as zero rather than
 * failing — so the only way to see a rename is to know what should come back.
 */
const USAGE = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 13,
  cache_creation_input_tokens: 17
};

/**
 * Header values that change with the machine or the run rather than with the
 * CLI. Recorded as `*` so a capture taken on one laptop diffs cleanly against
 * one taken on another.
 */
const VOLATILE_HEADERS = new Set([
  "content-length",
  "host",
  "if-none-match",
  "x-claude-code-prompt-id",
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count"
]);

// --- arguments ----------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const record = flag("--record");
const live = flag("--live");
const keep = flag("--keep");
const spec = args.find((arg) => !arg.startsWith("--"));

if (record && live) {
  fail(
    "--record takes an offline run: a live run's traffic depends on the account."
  );
}
const credential = live
  ? process.env.CLAUDE_CODE_OAUTH_TOKEN
  : `sk-ant-oat01-probe-${randomBytes(12).toString("hex")}`;
if (!credential)
  fail("--live needs CLAUDE_CODE_OAUTH_TOKEN in the environment.");

/**
 * The environment of every command the probe runs but the CLI: `npm`, whose
 * install runs the candidate's lifecycle scripts. The egress
 * holds the credential and nothing else here should — the CLI itself is given
 * only the placeholder, as in the container.
 */
const TOOL_ENV = { ...process.env };
delete TOOL_ENV.CLAUDE_CODE_OAUTH_TOKEN;

// --- the package under test, from dist/ ---------------------------------------

/**
 * The daemon's cards reach core's `/artifacts`, whose other modules import
 * `cloudflare:workers` for classes nothing here constructs. Node cannot resolve
 * that scheme, so it resolves to empty classes. A name missing from this stub
 * fails the import loudly, naming the export.
 */
const CLOUDFLARE_STUB =
  "export class RpcTarget {} export class WorkerEntrypoint {} " +
  "export class DurableObject {} export const env = {};";
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
        if (specifier.startsWith("cloudflare:")) {
          return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(CLOUDFLARE_STUB)}), shortCircuit: true };
        }
        return next(specifier, context);
      }`
    )
);
const dist = (file) =>
  import(pathToFileURL(path.join(root, "dist", file)).href);
const { egressPlan, sandboxEgress } = await dist("sandbox/egress.js");
const { claudeCodeDaemonCli } = await dist("claude-code/daemon/index.js");
const { claudeCodeEgress, credentialHost } = await dist(
  "claude-code/egress.js"
);
const { ANTHROPIC_PLACEHOLDER_HOST, decodeRunEnd, decodeSkills } = await dist(
  "claude-code/harness-wire.js"
);
const { parseStream } = await dist("claude-code/events.js");
const { CREDENTIAL_PLACEHOLDER } = await dist("claude-code/placeholder.js");
const { VERIFIED_CLAUDE_CODE_VERSION } = await dist("claude-code/verified.js");

/** The daemon's adapter, which names the planning run's schema as a run header does. */
const cli = claudeCodeDaemonCli({ id: "probe", schemas: { probe: SCHEMA } });

// --- which version ------------------------------------------------------------

const version = resolveVersion(spec ?? "latest");
if (!spec && !record && !live && version === VERIFIED_CLAUDE_CODE_VERSION) {
  console.log(`${PACKAGE}@latest is ${version}, already the verified version.`);
  process.exit(0);
}
console.log(
  `Probing ${PACKAGE}@${version} (verified: ${VERIFIED_CLAUDE_CODE_VERSION}, ` +
    `upstream: ${live ? "the real API" : "a fake Anthropic"}).`
);

const tmp = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "claude-code-probe-"))
);
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");
mkdirSync(home);
mkdirSync(work);

// The checkout's own skills, where the CLI discovers them — a cloned
// repository's `.claude/skills/`, as the daemon runs no `--bare`. Written
// before any run, since a header naming a skill is refused when the file is
// not there, and `disable-model-invocation` because a selected skill is the
// caller's choice and not an offer to the model.
const skillDir = path.join(work, ".claude", "skills", SKILL);
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  path.join(skillDir, "SKILL.md"),
  [
    "---",
    `name: ${SKILL}`,
    "description: >-",
    "  A marker skill for the probe. Finds nothing, files nothing, changes nothing.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Marker",
    "",
    SKILL_SENTINEL,
    "",
    `Say ${REPLY} and stop.`,
    ""
  ].join("\n")
);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

try {
  const bin = install(version);

  const requests = [];
  const refused = [];
  const unanswered = [];
  const realFetch = globalThis.fetch;
  // The egress's upstream is the global `fetch`, as it is in a Worker. The
  // CLI's requests overlap, so each carries its index through the egress.
  globalThis.fetch = async (input, init) => {
    // The egress forwards the body as the stream it arrived as, which a Worker
    // sends as it is and Node sends only when told it is half-duplex.
    const request = new Request(input, { ...init, duplex: "half" });
    const id = Number(request.headers.get(PROBE_ID));
    request.headers.delete(PROBE_ID);
    requests[id].upstream = Object.fromEntries(request.headers);
    if (live) return realFetch(request);
    const answer = await fake(request, requests[id]);
    if (answer.status === 404) unanswered.push(pathOf(request.url));
    return answer;
  };

  // The pool a sandbox holds, reached as the egress reaches it: by the name on
  // the route, through the binding it names.
  const stored = new Map();
  const pool = credentialHost({
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => void stored.set(key, value)
    },
    credentials: () => [credential]
  });
  const rule = claudeCodeEgress({ label: "probe" });
  const plan = egressPlan([rule], "PROBE_SANDBOX/probe");
  const egress = (request) =>
    sandboxEgress(
      request,
      [...plan.http, ...plan.https],
      { PROBE_SANDBOX: { getByName: () => pool } },
      [rule]
    );

  const proxy = await listen(egress, requests, refused);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const first = await runSession(bin, proxyUrl);
  const second = first.sessionId
    ? await runSession(bin, proxyUrl, { resume: first.sessionId })
    : undefined;
  // A planning run, as a host launches one: an answer as data, under `plan`.
  const structured = await runSession(bin, proxyUrl, { plan: true });
  // And the plan carried out: forked, under the mode that writes.
  const forked = structured.sessionId
    ? await runSession(bin, proxyUrl, {
        resume: structured.sessionId,
        fork: true
      })
    : undefined;
  // A skill the run header names, which arrives as the first line of stdin.
  // The index is taken first: what the model was asked during this run is what
  // shows the skill was loaded rather than read as the first words of a prompt.
  const askedBefore = requests.length;
  const skilled = await runSession(bin, proxyUrl, {
    skill: SKILL,
    prompt: SKILL_BRIEF
  });
  const skillSent = requests
    .slice(askedBefore)
    .map((r) => r.sent ?? "")
    .join("\n");
  // And the same conversation carried on, which must not select it again.
  const skillResumed = skilled.sessionId
    ? await runSession(bin, proxyUrl, {
        skill: SKILL,
        resume: skilled.sessionId
      })
    : undefined;
  // Last, and the count is taken before it: this one must make no model call,
  // and a request made after it could only be its own.
  const calledBefore = requests.length;
  const unresumable = await runSession(bin, proxyUrl, {
    resume: UNKNOWN_SESSION
  });
  proxy.close();

  checkRun("first run", first);
  if (second) {
    checkRun("resumed run", second);
    check(
      "the resumed run continues the same session",
      second.sessionId === first.sessionId &&
        second.result?.sessionId === first.sessionId,
      `${first.sessionId} → ${second.sessionId}`
    );
  } else {
    check("the resumed run ran", false, "the first run reported no session id");
  }
  /**
   * A planning run reads and edits nothing, and has nobody to approve its plan,
   * so its answer has to come back through `StructuredOutput` under `plan` —
   * a version that denied the tool there would leave a planner with no way to
   * answer at all.
   */
  checkRun("planning run", structured, { structured: true });
  check(
    "the planning run starts in plan mode",
    initOf(structured)?.permissionMode === "plan",
    String(initOf(structured)?.permissionMode)
  );
  if (forked) {
    checkRun("forked run", forked);
    /**
     * A fork is how a plan is carried out, and it is only worth anything if the
     * plan's conversation stays whole — so the id has to be a new one rather
     * than the original continuing under another name, and the mode the one
     * that writes.
     */
    check(
      "the forked run starts a session of its own",
      Boolean(forked.sessionId) &&
        forked.sessionId !== structured.sessionId &&
        forked.result?.sessionId === forked.sessionId,
      `${structured.sessionId} → ${forked.sessionId}`
    );
    check(
      "and leaves plan mode for the mode that writes",
      initOf(forked)?.permissionMode === "bypassPermissions",
      String(initOf(forked)?.permissionMode)
    );
  } else {
    check(
      "the forked run ran",
      false,
      "the planning run reported no session id"
    );
  }
  /**
   * The selected skill, end to end. `init` is the CLI's own report of what it
   * loaded, and the request body is the only proof the skill ran rather than
   * being read as text — a `/name` line the CLI did not recognise would reach
   * the model as the prompt's first words and cost nothing visible.
   */
  checkRun("skill run", skilled);
  check(
    "the skill run's init line names the skill the header asked for",
    skilled.skills?.includes(SKILL) === true,
    `${(skilled.skills ?? []).length} loaded${skilled.skills?.includes(SKILL) ? "" : `: ${(skilled.skills ?? []).join(", ")}`}`
  );
  check(
    "the launch puts the skill on the first line of stdin, with the prompt under it",
    skilled.stdin === `/${SKILL}\n${skilled.prompt}`,
    JSON.stringify(skilled.stdin?.slice(0, 60))
  );
  if (!live) {
    /**
     * The body, and the brief **whole**: the `/name` line is a command whose
     * argument is the rest of stdin, and a CLI that took only the first line of
     * it would leave the right process running the wrong instructions. The last
     * paragraph's marker is what says the argument did not stop at a newline.
     */
    const body = skillSent.includes(SKILL_SENTINEL);
    const whole = skillSent.includes(skilled.prompt);
    const end = skillSent.includes(SKILL_BRIEF_END);
    check(
      "the skill's own body reaches the model, with the whole brief under it",
      body && whole && end,
      `body ${body ? "✓" : "✗"}, brief ${whole ? "✓" : "✗"}, last paragraph ${end ? "✓" : "✗"}`
    );
  }
  /**
   * A turn that carries a conversation on. The line is a slash command, so
   * sending it again would re-run the skill and re-inject its text mid-session
   * — which is why the launch, and not the caller, decides.
   */
  if (skillResumed) {
    checkRun("resumed skill run", skillResumed);
    check(
      "a resumed turn is sent the prompt alone",
      skillResumed.stdin === skillResumed.prompt,
      JSON.stringify(skillResumed.stdin?.slice(0, 60))
    );
  } else {
    check(
      "the resumed skill run ran",
      false,
      "the skill run reported no session id"
    );
  }
  check(
    "a run naming no skill is sent the prompt alone",
    first.stdin === first.prompt,
    JSON.stringify(first.stdin?.slice(0, 60))
  );
  /**
   * And a name with nothing behind it, which costs no process: the common
   * drift is a skill renamed where the caller's name for it was not, and a
   * session that started generically instead would report success.
   */
  check(
    "a skill with no SKILL.md behind it is refused before launch",
    (() => {
      try {
        cli.command({
          operationId: "probe:no-such-skill",
          prompt: "x",
          settings: {},
          state: {},
          header: { cwd: work, skill: "not-a-skill-here" }
        });
        return false;
      } catch (err) {
        return /no skill named not-a-skill-here/.test(String(err));
      }
    })()
  );
  /**
   * A resume of a conversation that is not there. This has to stay cheap and
   * legible, because it is the fallback for every check a host skips: a
   * `result` line naming the reason, no model call, nothing spent. A version
   * that started a fresh session instead would silently do unrelated work under
   * a caller's "continue this" — which is why this is a check and not a note.
   */
  check(
    "a resume with nothing to resume says so on the result line",
    unresumable.parsed.skipped === 0 &&
      unresumable.result?.isError === true &&
      (unresumable.result.errors?.length ?? 0) > 0,
    JSON.stringify({
      code: unresumable.code,
      subtype: unresumable.result?.subtype,
      errors: unresumable.result?.errors
    })
  );
  /**
   * **No model call**, rather than no request at all: the client still makes its
   * own startup requests before it looks for the conversation. Nothing is
   * inferred and nothing is billed, which is what makes a refused resume
   * something a host can simply report and retry without one.
   */
  const afterRefusal = requests.slice(calledBefore);
  check(
    "and makes no model call doing it",
    afterRefusal.every((r) => !r.path.startsWith("/v1/messages")),
    afterRefusal.map((r) => `${r.method} ${r.path}`).join(", ") ||
      "no request at all"
  );

  // Every intercepted request, not the ones that got through: a request the
  // egress refused never reaches upstream, and would otherwise go unseen.
  check(
    "every request reached Anthropic with the real credential",
    requests.length > 0 &&
      requests.every(
        (r) => r.upstream?.authorization === `Bearer ${credential}`
      ),
    `${requests.filter((r) => r.upstream).length} of ${requests.length} forwarded`
  );
  check(
    "no request left with the placeholder or an x-api-key",
    requests.every(
      (r) =>
        r.upstream &&
        !Object.values(r.upstream).some((v) =>
          v.includes(CREDENTIAL_PLACEHOLDER)
        ) &&
        !("x-api-key" in r.upstream)
    )
  );

  const capture = {
    version,
    // What the fake answered, so a spec reading the runs knows what to expect.
    fake: { reply: REPLY, usage: USAGE, structured: STRUCTURED },
    requests: requests.map(({ method, path, headers }) => ({
      method,
      path,
      headers: normalizeHeaders(headers)
    })),
    runs: {
      first: normalizeLines(first.lines),
      resumed: normalizeLines(second?.lines ?? []),
      forked: normalizeLines(forked?.lines ?? []),
      structured: normalizeLines(structured.lines),
      skill: normalizeLines(skilled.lines),
      skillResumed: normalizeLines(skillResumed?.lines ?? []),
      unresumable: normalizeLines(unresumable.lines)
    }
  };

  report(capture, { refused, unanswered });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n✗ ${version} failed ${failed.length} check(s).`);
    process.exitCode = 1;
  } else if (record) {
    writeFileSync(CAPTURE, `${JSON.stringify(capture, null, 2)}\n`);
    writeFileSync(
      VERIFIED,
      readFileSync(VERIFIED, "utf8").replace(
        /VERIFIED_CLAUDE_CODE_VERSION = "[^"]*"/,
        `VERIFIED_CLAUDE_CODE_VERSION = "${version}"`
      )
    );
    console.log(
      `\n✓ ${version} passes, and is now the verified version. Commit ` +
        `${path.relative(root, CAPTURE)} and ${path.relative(root, VERIFIED)}, ` +
        "then run `npm test`: the specs read the new capture. A deployment's " +
        "image pin moves to it next."
    );
  } else {
    console.log(
      `\n✓ ${version} passes. \`--record\` makes it the verified version.`
    );
  }
} catch (err) {
  console.error(
    `probe-claude-code: ${err instanceof Error ? err.message : err}`
  );
  process.exitCode = 1;
} finally {
  if (keep) console.log(`Kept ${tmp}.`);
  else rmSync(tmp, { recursive: true, force: true });
}

// --- steps --------------------------------------------------------------------

function resolveVersion(tagOrVersion) {
  const out = execFileSync(
    "npm",
    ["view", `${PACKAGE}@${tagOrVersion}`, "version", "--json"],
    { encoding: "utf8", env: TOOL_ENV }
  ).trim();
  if (!out)
    throw new Error(`${PACKAGE}@${tagOrVersion} names no published version.`);
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

/**
 * The CLI, in a directory of its own. The machine's `claude` is not touched.
 *
 * The package's `postinstall` is what puts the native binary behind `claude`,
 * which is published as a placeholder that exits 1, so the script is approved
 * by name. A `--prefix` install refuses `--allow-scripts` and reads the approval
 * from the prefix's own `package.json`; without it npm warns or blocks,
 * depending on the release.
 */
function install(target) {
  const prefix = path.join(tmp, "cli");
  mkdirSync(prefix);
  writeFileSync(
    path.join(prefix, "package.json"),
    JSON.stringify({ allowScripts: { [PACKAGE]: true } })
  );
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--no-save",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      `${PACKAGE}@${target}`
    ],
    { stdio: ["ignore", "ignore", "inherit"], env: TOOL_ENV }
  );
  const bin = path.join(prefix, "node_modules/.bin/claude");
  const reported = execFileSync(bin, ["--version"], {
    encoding: "utf8",
    env: TOOL_ENV
  });
  if (!reported.startsWith(target)) {
    throw new Error(`installed ${target}, but it reports ${reported.trim()}.`);
  }
  return bin;
}

/**
 * The harness's interception, as a proxy. The CLI sends the placeholder host's
 * requests here in absolute form, plain HTTP as in the container, and each is
 * handed to the egress at that URL; anything else, a `CONNECT` included, is
 * refused and named in the report, so the probe never reaches a host it does
 * not know about.
 */
function listen(egress, requests, refused) {
  const proxy = http.createServer(async (req, res) => {
    const url = URL.canParse(req.url) ? new URL(req.url) : undefined;
    if (url?.host !== ANTHROPIC_PLACEHOLDER_HOST) {
      refused.push(`${req.method} ${req.url}`);
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = `${url.pathname}${url.search}`;
    // `proxy-connection` is this proxy's framing, which the container's
    // interception never sees.
    const { "proxy-connection": _, ...sent } = req.headers;
    const id = requests.push({ method: req.method, path, headers: sent }) - 1;
    const headers = new Headers({ [PROBE_ID]: String(id) });
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        ["connection", "proxy-connection", "host", "content-length"].includes(
          name
        )
      )
        continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    try {
      const response = await egress(
        new Request(url, {
          method: req.method,
          headers,
          ...(body.length > 0 ? { body } : {})
        })
      );
      const out = {};
      response.headers.forEach((value, name) => {
        // Node's fetch has already decoded the body and framed it itself.
        if (
          ![
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "connection"
          ].includes(name)
        ) {
          out[name] = value;
        }
      });
      res.writeHead(response.status, out);
      if (response.body)
        for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`probe: the egress threw: ${err}`);
    }
  });
  proxy.on("connect", (req, socket) => {
    refused.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  return new Promise((resolve) =>
    proxy.listen(0, "127.0.0.1", () => resolve(proxy))
  );
}

/**
 * One turn, launched as the daemon launches it, and its lines read by the
 * daemon's parser — the session id it hands the next turn, and the outcome the
 * host decodes — as well as parsed whole, for what a line-by-line read hides.
 */
function runSession(bin, proxyUrl, { resume, fork, plan, skill, prompt } = {}) {
  const turn = {
    operationId: `probe:${randomUUID()}`,
    prompt: prompt ?? `Reply with exactly: ${REPLY}`,
    settings: {},
    state: resume ? { sessionId: resume } : {},
    header: {
      cwd: work,
      ...(plan ? { mode: "plan", schema: "probe" } : {}),
      ...(fork ? { fork: true } : {}),
      ...(skill ? { skill } : {})
    }
  };
  const launch = cli.command(turn);
  if (launch.argv[0] !== "claude") {
    throw new Error(
      `the daemon's command no longer starts with \`claude\`: ${launch.argv.join(" ")}`
    );
  }
  // HOME is the session's own, as in the sandbox: every run shares it, so the
  // resume and the fork find the conversations under it.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    ...launch.env,
    // HTTPS too, though nothing should use it: a client that does reaches the
    // proxy's `CONNECT` refusal and the report, rather than the network.
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl
  };
  return new Promise((resolve) => {
    // A process group of its own, so a timeout reaches the CLI and whatever it
    // started.
    const child = spawn(bin, launch.argv.slice(1), {
      cwd: work,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    child.stdin.end(launch.stdin ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        // Already gone.
      }
    };
    const timers = [
      setTimeout(() => {
        stderr += `\nprobe: no exit after ${RUN_TIMEOUT_MS / 1000}s; stopped.`;
        signal("SIGTERM");
      }, RUN_TIMEOUT_MS),
      setTimeout(() => signal("SIGKILL"), RUN_TIMEOUT_MS + KILL_GRACE_MS)
    ];
    child.on("error", (err) => {
      stderr += `\nprobe: could not start the CLI: ${err.message}`;
    });
    child.on("close", (code) => {
      for (const timer of timers) clearTimeout(timer);
      const lines = stdout.split("\n").filter(Boolean);
      const parser = cli.parser(turn);
      let sessionId;
      /** What the daemon reported the CLI had loaded, as a host reads it. */
      let skills;
      for (const line of lines) {
        const update = parser.line(line);
        if (update.state?.sessionId) sessionId = update.state.sessionId;
        for (const event of update.events ?? []) {
          const text = event.message?.parts?.[0]?.text;
          const loaded = text === undefined ? undefined : decodeSkills(text);
          if (loaded) skills = loaded;
        }
      }
      const outcome = parser.end({ code, stderr });
      const end = decodeRunEnd(
        outcome.status === "done" ? outcome.text : outcome.reason
      );
      resolve({
        code,
        stderr,
        parsed: parseStream(`${lines.join("\n")}\n`),
        result: end?.result,
        sessionId,
        skills,
        // The prompt as the daemon sent it, beside the prompt it was given:
        // the only difference a selected skill makes to a launch.
        stdin: launch.stdin,
        prompt: turn.prompt,
        lines
      });
    });
  });
}

/** A run's `system`/`init` line, which names the mode it actually started in. */
function initOf(run) {
  for (const line of run.lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "system" && parsed.subtype === "init") return parsed;
    } catch {
      // Not JSON: `checkRun` reports it.
    }
  }
  return undefined;
}

function checkRun(label, run, { structured = false } = {}) {
  check(
    `${label}: the CLI exits 0`,
    run.code === 0,
    run.code === 0 ? "" : run.stderr.trim().slice(0, 500)
  );
  check(
    `${label}: every line parses`,
    run.parsed.skipped === 0,
    run.parsed.sample ? `first unrecognised: ${run.parsed.sample}` : ""
  );
  const result = run.result;
  check(
    `${label}: a result is read`,
    Boolean(result && !result.isError),
    result ? `${result.subtype}` : "none"
  );
  if (!result || live) return;
  if (structured) {
    check(
      `${label}: the answer is read as structured`,
      JSON.stringify(result.structured) === JSON.stringify(STRUCTURED),
      JSON.stringify(result.structured)
    );
  } else {
    check(
      `${label}: the reply is the fake's`,
      result.text === REPLY,
      JSON.stringify(result.text)
    );
  }
  const usage = {
    input: USAGE.input_tokens,
    output: USAGE.output_tokens,
    cacheRead: USAGE.cache_read_input_tokens,
    cacheWrite: USAGE.cache_creation_input_tokens
  };
  check(
    `${label}: usage, turns, duration and cost are read`,
    JSON.stringify(result.usage) === JSON.stringify(usage) &&
      result.numTurns > 0 &&
      result.durationMs > 0 &&
      result.costUsd > 0,
    JSON.stringify({
      usage: result.usage,
      turns: result.numTurns,
      ms: result.durationMs,
      cost: result.costUsd
    })
  );
}

// --- the fake Anthropic -----------------------------------------------------------

/**
 * Just enough of the API for a one-turn session, and a 404 naming the rest.
 *
 * `entry.sent` is what the model was asked, kept in memory for the checks that
 * are about the prompt rather than the traffic — a skill's body arriving with
 * the brief under it, for one. Text rather than the JSON around it: a brief of
 * several paragraphs is what the checks look for, and JSON escapes every
 * newline in it. The capture keeps each request's method, path and headers and
 * never a body, which is what keeps a conversation out of a committed file.
 */
async function fake(request, entry) {
  const url = pathOf(request.url);
  if (request.method === "HEAD") return new Response(null, { status: 200 });
  if (url === "/v1/messages/count_tokens") {
    return Response.json({ input_tokens: USAGE.input_tokens });
  }
  if (url === "/v1/messages" && request.method === "POST") {
    const body = await request.json();
    if (entry) entry.sent = askedText(body);
    const message = {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: body.model,
      stop_sequence: null
    };
    const event = (type, data) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const stream = (content, stopReason) =>
      new Response(
        event("message_start", {
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { ...USAGE, output_tokens: 1 }
          }
        }) +
          event("content_block_start", {
            index: 0,
            content_block: content.start
          }) +
          event("content_block_delta", { index: 0, delta: content.delta }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: USAGE.output_tokens }
          }) +
          event("message_stop", {}),
        {
          headers: {
            "content-type": "text/event-stream",
            "request-id": "req_probe"
          }
        }
      );
    // Asked for structured output and not yet given it: answer through the tool.
    if (
      body.stream &&
      body.tools?.some((tool) => tool.name === STRUCTURED_TOOL) &&
      !JSON.stringify(body.messages).includes('"tool_result"')
    ) {
      return stream(
        {
          start: {
            type: "tool_use",
            id: "toolu_probe",
            name: STRUCTURED_TOOL,
            input: {}
          },
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(STRUCTURED)
          }
        },
        "tool_use"
      );
    }
    if (!body.stream) {
      return Response.json(
        {
          ...message,
          content: [{ type: "text", text: REPLY }],
          stop_reason: "end_turn",
          usage: USAGE
        },
        { headers: { "request-id": "req_probe" } }
      );
    }
    return stream(
      {
        start: { type: "text", text: "" },
        delta: { type: "text_delta", text: REPLY }
      },
      "end_turn"
    );
  }
  return Response.json(
    {
      type: "error",
      error: { type: "not_found_error", message: "not in the probe's fake API" }
    },
    { status: 404 }
  );
}

/**
 * Every text block of a request's messages, joined — what the model was asked,
 * as it reads rather than as it travels. A system prompt is not in it: what the
 * checks look for is a skill's body and a brief, and both arrive as a turn.
 */
function askedText(body) {
  const out = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const content = message?.content;
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content))
      for (const block of content)
        if (typeof block?.text === "string") out.push(block.text);
  }
  return out.join("\n");
}

// --- the capture and the report ----------------------------------------------------

function pathOf(url) {
  return new URL(url, `https://${HOST}`).pathname;
}

/** Stable across machines and runs: see {@link VOLATILE_HEADERS}. */
function normalizeHeaders(headers) {
  const out = {};
  for (const name of Object.keys(headers).sort()) {
    const value = Array.isArray(headers[name])
      ? headers[name].join(", ")
      : headers[name];
    out[name] = VOLATILE_HEADERS.has(name) ? "*" : value;
  }
  return out;
}

/**
 * The run's lines, with this machine's temporary paths taken out — in the
 * spelling the CLI names a project directory with too, every character but a
 * letter or a digit turned to `-`.
 */
function normalizeLines(lines) {
  const projectSpelling = tmp.replace(/[^A-Za-z0-9]/g, "-");
  return lines.map((line) =>
    line.split(tmp).join("/probe").split(projectSpelling).join("-probe")
  );
}

/**
 * What a capture says, for comparing two: each endpoint's header values, every
 * value seen across its calls, and each kind of line's fields. The CLI's own
 * version is taken out of the values, so a bump alone is not a difference.
 */
function shape(capture) {
  const requests = new Map();
  for (const request of capture.requests) {
    const key = `${request.method} ${request.path}`;
    const headers = requests.get(key) ?? new Map();
    for (const [name, value] of Object.entries(request.headers)) {
      const values = name === "anthropic-beta" ? value.split(",") : [value];
      const seen = headers.get(name) ?? new Set();
      for (const v of values)
        seen.add(v.split(capture.version).join("<version>"));
      headers.set(name, seen);
    }
    requests.set(key, headers);
  }
  const lines = new Map();
  for (const line of Object.values(capture.runs).flat()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = event.subtype ? `${event.type}/${event.subtype}` : event.type;
    const keys = new Set([...(lines.get(kind) ?? []), ...Object.keys(event)]);
    lines.set(kind, keys);
  }
  return { requests, lines };
}

function report(capture, { refused, unanswered }) {
  console.log("\nChecks:");
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`
    );
  }
  if (refused.length > 0) {
    console.log(
      `\nRefused, outside Anthropic: ${[...new Set(refused)].join(", ")}`
    );
  }
  if (unanswered.length > 0) {
    console.log(
      `\nAnswered 404 by the fake: ${[...new Set(unanswered)].join(", ")}`
    );
  }

  if (!existsSync(CAPTURE)) {
    console.log("\nNo recorded capture to compare with.");
    return;
  }
  const before = JSON.parse(readFileSync(CAPTURE, "utf8"));
  const was = shape(before);
  const now = shape(capture);
  const changes = [];

  for (const key of new Set([...was.requests.keys(), ...now.requests.keys()])) {
    const a = was.requests.get(key);
    const b = now.requests.get(key);
    if (!a) changes.push(`+ request ${key}`);
    else if (!b) changes.push(`- request ${key}`);
    else {
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(name);
        const y = b.get(name);
        if (!x) changes.push(`+ ${key} header ${name}: ${[...y].join(", ")}`);
        else if (!y) changes.push(`- ${key} header ${name}`);
        else {
          for (const v of y)
            if (!x.has(v)) changes.push(`+ ${key} ${name} ${v}`);
          for (const v of x)
            if (!y.has(v)) changes.push(`- ${key} ${name} ${v}`);
        }
      }
    }
  }
  for (const kind of new Set([...was.lines.keys(), ...now.lines.keys()])) {
    const a = was.lines.get(kind);
    const b = now.lines.get(kind);
    if (!a) changes.push(`+ line ${kind}`);
    else if (!b) changes.push(`- line ${kind}`);
    else {
      for (const key of b)
        if (!a.has(key)) changes.push(`+ ${kind} field ${key}`);
      for (const key of a)
        if (!b.has(key)) changes.push(`- ${kind} field ${key}`);
    }
  }

  console.log(`\nAgainst the capture of ${before.version}:`);
  console.log(
    changes.length === 0
      ? "  no difference"
      : changes.map((c) => `  ${c}`).join("\n")
  );
}

function fail(message) {
  console.error(`probe-claude-code: ${message}`);
  process.exit(1);
}
