/**
 * GitHub's hosted MCP server, called from the Worker.
 *
 * The reads this plugin used to make itself — a pull request, its files, its
 * reviews, its review threads, its checks, an issue and its comments — are one
 * vendor-maintained surface now. What stays ours is everything above the
 * transport: the tool names, their schemas, the repository binding and the
 * renders. The model never sees an MCP tool; see `./index.ts` for why the tools
 * are wrapped rather than surfaced.
 *
 * ## The credential, and what bounds it
 *
 * The token is the host's, read through {@link RepoConfig.token} at the moment
 * of use and sent as `Authorization: Bearer` from here — the Worker. It reaches
 * no container: this host is deliberately absent from the egress gateway's
 * `GITHUB_HOSTS`, so nothing inside a session's container can offer the
 * placeholder to it and be given the real one.
 *
 * Two caps ride on every request, and they are policy rather than tuning:
 *
 * 1. {@link MCP_TOOLS} goes out as `X-MCP-Tools`, an **enable** list. The
 *    server offers nothing else, so a bug here — or an argument a prompt
 *    injection talked the model into — cannot reach a tool that writes.
 * 2. {@link MCP_URL} is the server's read-only variant, which refuses a write
 *    whatever the list says.
 *
 * Both, not either. The list is the narrow bound and the path is the one that
 * still holds if the list is ever edited carelessly. Neither is redundant with
 * the wrapping: wrapping keeps GitHub's schemas out of the model's context,
 * and these two bound what this Worker can do with the token at all.
 *
 * GitHub Enterprise Server is not supported, which is why the URL is a constant
 * rather than something a host configures.
 */

/**
 * The server, read-only. A single toolset or a modifier is a path segment on
 * this server — see the `X-MCP-Tools` note above for why the list does the
 * narrow work and this does the coarse.
 */
export const MCP_URL = "https://api.githubcopilot.com/mcp/readonly";

/**
 * Every tool this plugin may call, as `X-MCP-Tools`.
 *
 * Deliberately not configurable. A host that could widen this could hand the
 * deployment's token to a tool nobody reviewed, and the point of an allowlist
 * is that adding to it is a code change somebody reads.
 *
 * Both are read tools. `pull_request_read` is one name over nine methods —
 * `get`, `get_files`, `get_reviews`, `get_review_comments`, `get_check_runs`,
 * `get_status` are the ones used here — and `issue_read` covers an issue and
 * its comments.
 *
 * **`pull_request_review_write` is the one deliberate absence worth naming.**
 * It is the only tool that resolves a review thread, and the same name submits
 * a review — `APPROVE` included — so taking thread resolution would mean taking
 * self-approval. Nothing needs it: a revising Claude Code session answers and
 * resolves threads itself, with `gh` inside its container. Merging, commenting
 * and replying are absent for the same reason.
 */
export const MCP_TOOLS = ["pull_request_read", "issue_read"] as const;

/**
 * The protocol version this client speaks.
 *
 * Sent on `initialize` and echoed on every later request as
 * `MCP-Protocol-Version`, which is what lets the server keep answering an older
 * client after it moves on.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Ceiling on one call to the MCP server.
 *
 * Matches what the REST client alongside this uses, and for the same reason: it
 * is not a tuning knob but the thing that makes an unanswering API cost a tool
 * call rather than the task. A cold call pays `initialize` as well, which is
 * the one cost this transport has that a plain `fetch` did not.
 */
const MCP_TIMEOUT_MS = 30_000;

/** What a call answers with, matching the REST client's shape beside it. */
export type McpAnswer =
  { ok: true; data: unknown } | { ok: false; message: string };

/**
 * A negotiated connection, kept so a turn's second read does not re-initialize.
 *
 * Streamable HTTP needs `initialize` before any `tools/call`, so without this
 * every read would cost two round trips. The id may be absent: the server is
 * allowed to run stateless, and then there is nothing to carry.
 */
interface Session {
  sessionId?: string;
  protocolVersion: string;
}

/**
 * One JSON-RPC exchange with the server.
 *
 * `Accept` names both encodings because the server chooses: a response may come
 * back as JSON or as a one-event SSE stream, and a client that accepts only one
 * of them is refused.
 */
async function rpc(
  token: string,
  body: unknown,
  session: Session | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "da-coder",
    "x-mcp-tools": MCP_TOOLS.join(",")
  };
  if (session) {
    headers["mcp-protocol-version"] = session.protocolVersion;
    if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  }
  return fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
}

/**
 * The JSON-RPC envelope out of a response, whichever encoding it arrived in.
 *
 * An SSE body carries the envelope on `data:` lines, and a single logical
 * message may be split across several of them — the spec joins them with a
 * newline rather than taking the last, which is why this accumulates per event
 * instead of parsing line by line.
 */
async function envelope(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  let last: unknown;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) last = JSON.parse(data);
  }
  if (last === undefined) throw new Error("the stream carried no message");
  return last;
}

/** A JSON-RPC error, as a sentence rather than a code. */
function rpcError(envelope: {
  error?: { code?: number; message?: string };
}): string | undefined {
  const error = envelope.error;
  if (!error) return undefined;
  return `${error.message ?? "the server refused the call"}${
    typeof error.code === "number" ? ` (${error.code})` : ""
  }`;
}

/**
 * What a tool returned, as text.
 *
 * MCP answers a tool with content blocks rather than a value, and an *error
 * from the tool* is a normal result carrying `isError` — distinct from a
 * JSON-RPC error, which is the call itself failing. Both have to be reported;
 * reading `content` straight through turns "no permission to read this pull
 * request" into a result the model treats as the answer.
 *
 * **The text block is the contract here, and `structuredContent` deliberately
 * is not read.** They are not two encodings of one value: a method of
 * `pull_request_read` marshals its own result into the text — an array of
 * files, say — while the typed output beside it is a wrapper naming which
 * method answered (`{ files: [...] }`). Preferring the structured one would
 * hand each caller a differently-shaped object depending on whether the server
 * had typed schemas switched on, which is the kind of difference that shows up
 * as an empty render rather than an error.
 */
function toolText(result: {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}): { ok: true; data: unknown } | { ok: false; message: string } {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  if (result.isError) {
    return { ok: false, message: text || "the tool reported a failure" };
  }
  if (!text) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, message: `the tool's answer did not parse: ${text}` };
  }
}

/**
 * Connections, per plugin instance.
 *
 * Keyed on the config object the way the git queue beside it is, and for the
 * same reason: the tools are rebuilt every turn, so a connection held in that
 * closure would be re-negotiated on each one.
 *
 * **The handshake in flight is what is held, not the session it produces.** A
 * model step may call two repo tools at once, and both would otherwise open
 * their own connection — or worse, the second would take the first's session
 * out of the map and send a `tools/call` while `notifications/initialized` was
 * still on the wire, which the server is entitled to reject. Awaiting one
 * promise gives the second caller the first's finished handshake.
 */
const sessions = new WeakMap<object, Promise<Session>>();

/** Build the caller for one plugin instance. */
export function mcpClient(
  key: object,
  token: () => { token: string } | { failure: string },
  logFailure: (tool: string, detail: { stderr?: string }) => void
) {
  const negotiate = async (signal: AbortSignal): Promise<Session> => {
    const secret = token();
    if ("failure" in secret) throw new Error(secret.failure);
    const response = await rpc(
      secret.token,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "dynamicagents-repo", version: "1" }
        }
      },
      undefined,
      signal
    );
    if (!response.ok) {
      throw new Error(
        `${MCP_URL} answered ${response.status} to initialize: ${(
          await response.text().catch(() => "")
        ).slice(0, 500)}`
      );
    }
    const body = (await envelope(response)) as {
      error?: { code?: number; message?: string };
      result?: { protocolVersion?: string };
    };
    const refused = rpcError(body);
    if (refused) throw new Error(`${MCP_URL} refused initialize: ${refused}`);
    const session: Session = {
      protocolVersion: body.result?.protocolVersion ?? MCP_PROTOCOL_VERSION,
      ...(response.headers.get("mcp-session-id")
        ? { sessionId: response.headers.get("mcp-session-id") as string }
        : {})
    };
    // The server is entitled to reject a `tools/call` that arrives before this,
    // and it answers the notification with no body. A failure here is not worth
    // failing the read for: the call that follows says so if it mattered. It is
    // awaited before the session is anybody's, which is the point of holding the
    // promise rather than the session.
    await rpc(
      secret.token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session,
      signal
    ).catch(() => undefined);
    return session;
  };

  const open = (signal: AbortSignal): Promise<Session> => {
    const held = sessions.get(key);
    if (held) return held;
    const opening = negotiate(signal);
    sessions.set(key, opening);
    // A handshake that failed must not be the answer the next read gets. The
    // caller waiting on this one still sees the failure — it is the call's own,
    // and the `signal` that aborted it was that caller's — and the read after
    // it negotiates again. Guarded on identity so a rejection arriving after
    // somebody else has stored a fresh promise does not take theirs out.
    opening.catch(() => {
      if (sessions.get(key) === opening) sessions.delete(key);
    });
    return opening;
  };

  const once = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<McpAnswer> => {
    const session = await open(signal);
    const secret = token();
    if ("failure" in secret) return { ok: false, message: secret.failure };
    const response = await rpc(
      secret.token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args }
      },
      session,
      signal
    );
    // A session the server has forgotten. Dropped and renegotiated once by the
    // caller below — these are reads, so repeating one costs nothing.
    if (response.status === 404 && session.sessionId) {
      sessions.delete(key);
      return { ok: false, message: "the MCP session expired" };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `${MCP_URL} answered ${response.status} for ${name}: ${(
          await response.text().catch(() => "")
        ).slice(0, 500)}`
      };
    }
    const body = (await envelope(response)) as {
      error?: { code?: number; message?: string };
      result?: Parameters<typeof toolText>[0];
    };
    const refused = rpcError(body);
    // What an allowlist refusal looks like: the tool is not registered, so the
    // call is a JSON-RPC error rather than a tool result. Said plainly, because
    // the alternative is somebody reading it as GitHub being down.
    if (refused) {
      return {
        ok: false,
        message: `${MCP_URL} refused ${name}: ${refused}`
      };
    }
    return toolText(body.result ?? {});
  };

  /**
   * One MCP tool call, from the Worker.
   *
   * A failure comes back as a value rather than a throw, because each caller
   * has its own sentence to add — the same contract the REST client beside this
   * keeps, so a tool body reads the same whichever route it is on.
   */
  return async function mcp(
    tool: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<McpAnswer> {
    const signal = AbortSignal.timeout(MCP_TIMEOUT_MS);
    try {
      const answered = await once(name, args, signal);
      // The one retry, and only for a session the server forgot: `once` has
      // already dropped it, so this renegotiates rather than repeating.
      const settled =
        !answered.ok && answered.message === "the MCP session expired"
          ? await once(name, args, signal)
          : answered;
      if (!settled.ok) logFailure(tool, { stderr: settled.message });
      return settled;
    } catch (err) {
      logFailure(tool, { stderr: String(err) });
      return {
        ok: false,
        message: `could not reach ${MCP_URL}: ${String(err)}`
      };
    }
  };
}

/** What {@link mcpClient} returns, for the context that carries it. */
export type McpCall = ReturnType<typeof mcpClient>;
