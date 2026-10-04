import type { ToolSet } from "ai";
import { definePlugin, PluginSetupError } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import type { WorkspaceClient } from "@cloudflare/computer";
import type { WorkspaceAdvisory } from "../workspace/advisory.js";
import type { WorkspaceClientConfig } from "../workspace/exec.js";
import { openWorkspace, openWorkspaceFs } from "../workspace/open.js";
import { workspaceRoute } from "./proxy.js";
import { computerContext } from "./context.js";
import { execTools } from "./tools-exec.js";
import { fileTools } from "./tools-file.js";
import { grepTools } from "./tools-grep.js";

/**
 * `@dynamicagents/plugins/computer` — an agent's tools over a container
 * workspace: `bash`, `grep` and `edit`, and `computerWorkspace`, the agent's own
 * `this.workspace`, which Think's `read`, `write`, `delete`, `find` and `list`
 * go through.
 *
 * The workspace itself — the Durable Object, its container, its git, its
 * install — is `@dynamicagents/plugins/workspace`. This plugin reaches it only
 * through that subpath's client modules, never its object, so an agent that
 * holds the tools carries no container backend and no isomorphic-git.
 *
 * The agent's own workspace has to be this one — `computerWorkspace` — or
 * Think's `read` and `write` would work on a different tree from `bash`. The
 * plugin refuses to start otherwise; see `./proxy.ts`.
 *
 * ## The dependency tree is not in the workspace
 *
 * The one thing to internalise before reading further. A package root's
 * `node_modules` is a bind mount of the container's disk, so installs never
 * sync, and a new container reinstalls — see `/workspace`'s
 * `container-deps.ts`. The file tools read the workspace, so they refuse it;
 * `bash` reaches it. `paths.ts` owns what a path may be and what walks drop.
 */

/**
 * The helpers this plugin's own tests reach for, re-exported from the one
 * entry point. `verify:exports` treats `./computer` as one realm, so what it
 * exports must not move when the files behind it do.
 */
export { isGitInternal, SESSION_STATE_DIR, WALK_SKIPS } from "./paths.js";
export {
  packBlocks,
  renderGrepMatches,
  renderResult,
  syncPendingNote
} from "./render.js";
export {
  execGate,
  needsDependencies,
  writeGate,
  type ExecGate
} from "./gate.js";
export { computerWorkspace, isComputerWorkspace } from "./proxy.js";

export interface ComputerConfig extends WorkspaceClientConfig {
  /**
   * Output ceiling per command, in **characters**. Defaults to 16,000.
   *
   * Characters — JavaScript `String.length`, UTF-16 code units — and not bytes,
   * which is what this was called and was never measuring. The renderers all
   * budget with `.length`, so 16,000 `✓` passed a "16,000 byte" ceiling while
   * occupying 48,000 UTF-8 bytes: three times the advertised limit, on exactly
   * the output a non-English repository produces.
   *
   * Characters are also the right unit for what this bounds. The ceiling exists
   * to protect a context window, which is measured in tokens, and tokens track
   * characters far better than they track UTF-8 bytes. So the name moved to meet
   * the implementation rather than the other way round.
   *
   */
  maxOutputChars?: number;
  /**
   * How long `bash` waits for a running dependency install before giving the
   * turn back. Defaults to 90 seconds.
   *
   * Bounded rather than open-ended because the wait happens inside a turn, and
   * a tool call that blocks for the length of an `npm ci` is exactly what
   * running the install as the host's own job was meant to prevent. On expiry
   * the tool runs nothing and says so, which costs one cheap step.
   */
  installGateMs?: number;
  /**
   * Environment merged into every command **these tools** run — a registry host,
   * a `CI` flag, proxy settings. Host-supplied and never model input.
   *
   * "These tools" is exact: `/workspace`'s `workspaceExec` deliberately does not
   * merge it, so a proxy set here does not reach the git that
   * `@dynamicagents/plugins/repo` runs through that export. The reasoning, and
   * how a host opts in explicitly, is written up there.
   *
   * ## Put no secret here
   *
   * *Every* command gets this environment, and `bash`'s command is written by
   * the model: `bash("printenv")` prints all of it, and so does a
   * `postinstall` script in a repository the agent was asked to clone, which
   * nobody vetted.
   *
   * What per-command passing buys is narrower and worth keeping: the value is not
   * set on the container, so a process started outside these tools — a dev server
   * left running from an earlier task — does not inherit it, and it is not in
   * `/proc/1/environ`. That is a real property. It is not confidentiality from
   * the model.
   *
   * ## What to do with a secret instead
   *
   * Do not hand the agent the credential; hand it the *action*. Keep the secret
   * on the Worker and expose one tool that makes the call it is for.
   * `@dynamicagents/plugins/repo` is the worked example: it holds a forge token, calls
   * the API from the Worker, and runs clone, fetch and push on the host's side of
   * the boundary. **No command in its container is ever given that token.**
   */
  env?: () => Record<string, string | undefined>;
}

/**
 * @param workspace Opens the workspace for a command: container started, CA
 *   installed.
 * @param fsWorkspace Opens it for the file tools, which touch nothing but the
 *   host's SQLite. Defaults to {@link workspace}, so a host with one way in
 *   behaves as before. See {@link openWorkspaceFs}.
 * @param lockScope Names the workspace a write locks within — see
 *   {@link file://./file-lock.ts}. Defaults to this tool set alone.
 */
export function buildComputerTools(
  workspace: () => Promise<WorkspaceClient>,
  config: ComputerConfig,
  advisories?: () => Promise<readonly WorkspaceAdvisory[]>,
  fsWorkspace: () => Promise<WorkspaceClient> = workspace,
  lockScope?: () => string
): ToolSet {
  const ctx = computerContext(
    workspace,
    config,
    advisories,
    fsWorkspace,
    lockScope
  );

  return {
    ...execTools(ctx),
    ...fileTools(ctx),
    ...grepTools(ctx)
  };
}

const CONTEXT = [
  "You have a Linux container with a shell, a package manager and network access:",
  "- `bash` runs any shell command — builds, tests, installs, git.",
  "- `read` / `write` / `edit` / `delete` work on files; `edit` replaces an exact unique string and is the right tool for a small change.",
  "- `grep` searches file contents; `list` lists a directory; `find` finds files by glob.",
  // The reason to prefer them is the one thing the model cannot infer from a
  // tool description: these read the durable workspace directly, so they are
  // the only tools that still answer while the container is unavailable.
  "Search with `grep` and `find` rather than running them through `bash`. They read the workspace directly, so they keep working while the container is restarting or an install is still running, and they come back with line numbers and a bounded result instead of a wall of text.",
  "Command output is truncated from the middle when large, so run targeted commands and read specific files rather than printing everything.",
  // Both halves of this matter and they pull in opposite directions, which
  // is why they are stated together rather than left for the model to work
  // out from a confusing result.
  "The checkout is durable: it survives between tasks and is still there after the container restarts, so it may already contain work from an earlier task — check before assuming it is empty.",
  "`node_modules` is not durable: it lives on the container's disk, so a new container reinstalls it, and the file tools cannot see inside it — use `bash` there. It is a mount point, so `rm -rf node_modules` fails; `npm ci` clears it itself.",
  // Stated up front rather than left to a refusal, so the model does not spend
  // a turn discovering it. The destination matters as much as the rule: a
  // prohibition with nowhere to go gets worked around.
  "`.git` is off limits to these tools, and searches and recursive listings skip it. It is git's internal state — reading it tells you less than the repository tools do, and writing it corrupts the checkout. Repository work goes through the repo tools (`repo_status`, `repo_diff`, `repo_commit`, `repo_push`); if a task needs git state you cannot get that way, say so in your result rather than reaching into `.git` yourself."
].join("\n");

/**
 * The container plugin. Its tools reach the workspace through the agent's own
 * `computerWorkspace` — the one Think's `read` and `write` use — so the two can
 * never resolve different ones. `config` answers everything else: the shell,
 * the limits, the environment.
 */
export function computer(config: ComputerConfig): AgentPlugin {
  return definePlugin({
    name: "computer",

    tools: (ctx) => {
      // Here, not in `execute`: the start check builds every plugin's tools,
      // so a missing workspace fails the start rather than a turn.
      const route = workspaceRoute(ctx.workspace());
      if (!route)
        throw new PluginSetupError(
          `plugin "computer" runs \`bash\` in a container, but ${ctx.agentName}'s ` +
            "workspace is not that container's, so Think's `read` and `write` " +
            "would work on a different tree. Set it on the agent class: " +
            "`override workspace = computerWorkspace(config, () => this.pluginContext().runtime())`."
        );

      // Resolved per call, not memoized: the name belongs to the turn — a
      // sub-agent's comes from `runtime()`, see `/workspace`'s `WORKSPACE_RUNTIME_KEY` —
      // and a stale stub would silently route a second caller's commands into
      // the first caller's files.
      const host = () => route.host(route.name());

      return buildComputerTools(
        () => openWorkspace(host()),
        config,
        // No try/catch here: `buildComputerTools` fails the gate open itself,
        // so wrapping again would only make it look like the guarantee lives in
        // two places.
        () => host().advisories(),
        () => openWorkspaceFs(host()),
        route.name
      );
    },

    context: [{ provider: { get: async () => CONTEXT } }]
  });
}
