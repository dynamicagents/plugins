/**
 * GitHub's hosted MCP server, called from the Worker.
 *
 * The reads this plugin makes — a pull request, its files, its reviews, its
 * review threads, its checks, an issue and its comments — are one
 * vendor-maintained surface. What stays ours is everything above the transport:
 * the tool names, their schemas, the repository binding and the renders. The
 * model never sees an MCP tool; see `./index.ts` for why the tools are wrapped
 * rather than surfaced.
 *
 * The transport itself is not here and not ours. `@dynamicagents/core/mcp`
 * holds it, over the official `@modelcontextprotocol/client`, and its module
 * comment is where the protocol decisions live — why no `authProvider` is
 * configured, which headers a caller may not set, how a connection is kept per
 * plugin instance. What this file is, is the policy that is GitHub's.
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
 * 1. {@link GITHUB_MCP_TOOLS} goes out as `X-MCP-Tools`, an **enable** list.
 *    The server offers nothing else, so a bug here — or an argument a prompt
 *    injection talked the model into — cannot reach a tool that writes.
 * 2. {@link GITHUB_MCP_URL} is the server's read-only variant, which refuses a
 *    write whatever the list says.
 *
 * Both, not either. The list is the narrow bound and the path is the one that
 * still holds if the list is ever edited carelessly. Neither is redundant with
 * the wrapping: wrapping keeps GitHub's schemas out of the model's context, and
 * these two bound what this Worker can do with the token at all.
 *
 * GitHub Enterprise Server is not supported, which is why the URL is a constant
 * rather than something a host configures.
 */
import { mcpClient, type McpAnswer } from "@dynamicagents/core/mcp";
import type { RepoConfig } from "./index.js";

/**
 * The server, read-only. A single toolset or a modifier is a path segment on
 * this server — see the `X-MCP-Tools` note above for why the list does the
 * narrow work and this does the coarse.
 */
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/readonly";

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
export const GITHUB_MCP_TOOLS = ["pull_request_read", "issue_read"] as const;

/**
 * One call to GitHub's MCP server, as the rest of this plugin asks for it.
 *
 * `tool` is this plugin's own tool — `repo_pr_view` — and is what the failure
 * log names, because that is the name an operator reading the log has in front
 * of them. `name` is the MCP tool, which must be one of
 * {@link GITHUB_MCP_TOOLS}.
 */
export type GithubMcpCall = (
  tool: string,
  name: string,
  args: Record<string, unknown>
) => Promise<McpAnswer>;

/**
 * The caller for one plugin instance.
 *
 * `config` is the key a connection is kept against, the way the git queue
 * beside it is keyed: the tools are rebuilt every turn, so anything held in
 * that closure would renegotiate on each one.
 *
 * No turn signal is threaded through. Core's client takes one, and a caller
 * that has one should pass it; these tools do not hold the turn's signal today,
 * and the call is bounded by core's own deadline either way.
 */
export function githubMcp(
  config: RepoConfig,
  credential: () => { token: string } | { failure: string },
  logFailure: (tool: string, detail: { stderr?: string }) => void
): GithubMcpCall {
  const call = mcpClient({
    url: GITHUB_MCP_URL,
    keyedOn: config,
    // Thrown rather than returned, because core keeps an `Error`'s own message
    // verbatim: the sentence a host's unreadable secret deserves is written
    // once, in `repoContext`, and reaches the model unframed.
    token: () => {
      const secret = credential();
      if ("failure" in secret) throw new Error(secret.failure);
      return secret.token;
    },
    headers: () => ({
      "x-mcp-tools": GITHUB_MCP_TOOLS.join(","),
      "user-agent": "da-coder"
    }),
    clientInfo: { name: "dynamicagents-repo-github", version: "1" }
  });

  return async (tool, name, args) => {
    const answered = await call(name, args);
    // Said out loud as well as returned. A failure that only reaches the model
    // leaves nothing behind for an operator, and an unreadable credential is a
    // likely reason to be on this path at all.
    if (!answered.ok) logFailure(tool, { stderr: answered.message });
    return answered;
  };
}
