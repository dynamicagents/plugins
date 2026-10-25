import type { ToolSet } from "ai";
import { definePlugin, PluginSetupError } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import type { SandboxAdvisory } from "../sandbox/advisory.js";
import type { ComputerClient } from "./client.js";
import { workspaceRoute } from "./proxy.js";
import { computerContext } from "./context.js";
import { execTools } from "./tools-exec.js";
import { fileTools } from "./tools-file.js";
import { grepTools } from "./tools-grep.js";

/**
 * `@dynamicagents/plugins/computer` — an agent's tools over a `/sandbox`
 * container: `bash`, `grep` and `edit`, and `computerWorkspace`, the agent's own
 * `this.workspace`, which Think's `read`, `write`, `delete`, `find` and `list`
 * go through.
 *
 * The container itself — the Durable Object, its git, its install — is
 * `@dynamicagents/plugins/sandbox`. This plugin reaches it over RPC, never
 * through its object, so an agent that holds the tools carries no container
 * backend.
 *
 * The agent's own workspace has to be the sandbox's — `computerWorkspace` — or
 * Think's `read` and `write` would work on a different tree from `bash`. The
 * plugin refuses to start otherwise; see `./proxy.ts`. `paths.ts` owns what a
 * path may be and what walks drop.
 */

/**
 * The helpers this plugin's own tests reach for, re-exported from the one
 * entry point. `verify:exports` treats `./computer` as one realm, so what it
 * exports must not move when the files behind it do.
 */
export { isGitInternal, WALK_SKIPS } from "./paths.js";
export { packBlocks, renderGrepMatches, renderResult } from "./render.js";
export {
  execGate,
  needsDependencies,
  writeGate,
  type ExecGate
} from "./gate.js";
export {
  sandboxClient,
  computerWorkspace,
  type SandboxComputerConfig,
  type SandboxComputerHost
} from "./sandbox.js";
export type { ComputerClient } from "./client.js";

/** How the tools run: the shell, the limits, the environment. */
export interface ComputerToolsConfig {
  /** Working directory for every command. Defaults to `/workspace`. */
  cwd?: string;
  /**
   * Run every command through this shell, e.g. `"bash"`. Unset, the command
   * string goes to the runtime as-is and lands on whatever `/bin/sh` is.
   *
   * Worth setting, because "whatever `/bin/sh` is" is **dash** on Debian and
   * Ubuntu, and a model writing shell writes *bash*. `${PIPESTATUS[0]}` is the
   * one that costs most — a bash builtin a model reaches for to read a piped exit
   * code, which dash fails with exit 2, after the command it wrapped has already
   * run. Set it only if the image actually has that shell: a missing one fails
   * *every* command rather than the bash-flavoured ones.
   */
  shell?: string;
  /** Per-command timeout. Defaults to ten minutes. */
  timeoutMs?: number;
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
   * `@dynamicagents/plugins/repo-github` is the worked example: it holds a GitHub token, calls
   * the API from the Worker, and its container's git holds a placeholder the
   * egress swaps. **No command in its container is ever given that token.**
   */
  env?: () => Record<string, string | undefined>;
}

/**
 * @param workspace Opens the sandbox for a call.
 * @param lockScope Names the sandbox a write locks within — see
 *   {@link file://./file-lock.ts}. Defaults to this tool set alone.
 */
export function buildComputerTools(
  workspace: () => Promise<ComputerClient>,
  config: ComputerToolsConfig,
  advisories?: () => Promise<readonly SandboxAdvisory[]>,
  lockScope?: () => string
): ToolSet {
  const ctx = computerContext(workspace, config, advisories, lockScope);

  return {
    ...execTools(ctx),
    ...fileTools(ctx),
    ...grepTools(ctx)
  };
}

/** What the model is told about the container, once per turn. */
const CONTEXT = [
  "You have a Linux container with a shell, a package manager and network access:",
  "- `bash` runs any shell command — builds, tests, installs, git.",
  "- `read` / `write` / `edit` / `delete` work on files; `edit` replaces an exact unique string and is the right tool for a small change.",
  "- `grep` searches file contents; `ls` lists a directory; `find` finds files by glob.",
  "Search with `grep` and `find` rather than running them through `bash`: they come back with line numbers and a bounded result instead of a wall of text.",
  "Command output is truncated from the middle when large, so run targeted commands and read specific files rather than printing everything.",
  "The checkout is the container's own disk, and it is kept between tasks: a stopped container starts again from it, so it may already contain work from an earlier task — check before assuming it is empty.",
  "`/workspace` holds one directory per checkout, plus directories of your own that are not part of any repository: `attachments/` keeps media taken out of the conversation, `fetched/` keeps fetched pages, `.agents/` keeps projected skills. A message that says a file was preserved at one of those paths means you can read it back. Searches from `/workspace` skip them; repository work happens inside a checkout.",
  "`node_modules` is on that disk beside the checkout and is kept with it. The file tools leave it out — use `bash` there.",
  "`.git` is off limits to these tools, and searches and recursive listings skip it. It is git's internal state — reading it tells you less than the repository tools do, and writing it corrupts the checkout. Repository work goes through the repo tools (`repo_status`, `repo_diff`, `repo_commit`, `repo_push`); if a task needs git state you cannot get that way, say so in your result rather than reaching into `.git` yourself."
].join("\n");

/**
 * The container plugin over a `/sandbox` object. Its tools reach the sandbox
 * through the agent's own `computerWorkspace` — the one Think's `read` and
 * `write` use — so the two can never resolve different ones. `config` answers
 * everything else.
 */
export function computer(config: ComputerToolsConfig): AgentPlugin {
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
      // sub-agent's comes from `runtime()`, see `/sandbox`'s
      // `SANDBOX_RUNTIME_KEY` — and a stale one would silently route a second
      // caller's commands into the first caller's files.
      return buildComputerTools(
        () => route.open(route.name()),
        config,
        // No try/catch here: `buildComputerTools` fails the gate open itself,
        // so wrapping again would only make it look like the guarantee lives in
        // two places.
        () => route.advisories(route.name()),
        route.name
      );
    },

    context: [{ provider: { get: async () => CONTEXT } }]
  });
}
