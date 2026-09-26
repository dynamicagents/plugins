import type { ToolSet } from "ai";
import { definePlugin, PluginSetupError } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import type { WorkspaceClient } from "@cloudflare/computer";
import {
  openWorkspace,
  openWorkspaceFs,
  workspaceNameFromRuntime,
  type WorkspaceHost
} from "./open.js";
import { workspaceRoute } from "./proxy.js";
import { cancelledNote } from "./render.js";
import { computerContext, DEFAULT_CWD, DEFAULT_TIMEOUT_MS } from "./context.js";
import { withShell } from "./shell.js";
import { execTools } from "./tools-exec.js";
import { fileTools } from "./tools-file.js";
import { findTools } from "./tools-find.js";
import type { WorkspaceAdvisory } from "./advisory.js";

/**
 * `@dynamicagents/plugins/computer` — a Linux container whose filesystem outlives it.
 *
 * The filesystem **is** a Durable Object's SQLite, mounted into the container
 * over FUSE by `computerd`. Commands see a normal `/workspace`; the Worker reads
 * the same tree over RPC; and when the container is replaced the tree is pushed
 * back into the new one.
 *
 * The agent's own workspace has to be this one — `computerWorkspace` — or
 * Think's `read` and `write` would work on a different tree from `bash`. The
 * plugin refuses to start otherwise; see `./proxy.ts`.
 *
 * ## The dependency tree is not in the workspace
 *
 * The one thing to internalise before reading further. A package root's
 * `node_modules` is a bind mount of the container's disk, so installs never
 * sync, and a new container reinstalls — see `./host/container-deps.ts`. The file
 * tools read the workspace, so they refuse it; `bash` reaches it. `paths.ts` owns what a
 * path may be and what walks drop.
 *
 * Requires the Workers **Paid** plan (containers) and a Durable Object binding
 * whose class owns the workspace — see the README for the wrangler block.
 */

/**
 * How a repository installs its dependencies — the mechanical half.
 *
 * Re-exported from the plugin's one entry point rather than given a subpath of
 * its own: `verify:exports` treats each subpath as an isolated realm, and a host
 * needs the resolver and the tools together anyway.
 */
export {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallPlan,
  type InstallProbe,
  type InstallResolution,
  type InstallRule,
  type InstallState
} from "./install.js";

/**
 * The helpers this plugin's own tests and hosts reach for, re-exported from the
 * one entry point.
 *
 * They live in sibling modules — `paths.ts`, `render.ts`, `gate.ts` — because
 * this file was 1,900 lines and the seams were obvious. The subpath is the unit a
 * consumer imports, so what it exports must not move when the files behind it do:
 * `verify:exports` treats `./computer` as one realm, and everything below stays
 * inside `dist/computer/`.
 */
export { isGitInternal, WALK_SKIPS } from "./paths.js";
export {
  cancelledNote,
  packBlocks,
  renderGrepMatches,
  renderResult,
  syncPendingNote,
  truncateOutput
} from "./render.js";
export {
  execGate,
  needsDependencies,
  writeGate,
  type ExecGate
} from "./gate.js";
/**
 * The workspace-advisory vocabulary, which a host needs all of: the type to
 * return over RPC, `deriveAdvisories` to build it from what it already knows,
 * and `sessionAdvisory` for a host driving a whole session rather than one
 * command. `shapeOf` and `renderAdvisory` are exported for the specs that hold
 * their exhaustiveness — a host has no reason to call either, since calling them
 * would mean writing policy or wording that has one home already.
 */
export {
  deriveAdvisories,
  renderAdvisory,
  sessionAdvisory,
  shapeOf,
  type AdvisoryAudience,
  type AdvisoryInput,
  type AdvisoryShape,
  type WorkspaceAdvisory
} from "./advisory.js";
// A host implementing `InstallProbe` needs exactly this, and hand-rolling it
// loses the fast path: across a Durable Object boundary `fs` is a stub carrying
// `exists`, which a `stat`-only probe never asks for.
export { pathExists } from "./read.js";

export {
  openWorkspace,
  openWorkspaceFs,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY,
  type WorkspaceHost
} from "./open.js";
export { computerWorkspace, isComputerWorkspace } from "./proxy.js";
export { withShell, withShellTranscript } from "./shell.js";

export interface ComputerConfig {
  /**
   * The Durable Object namespace holding workspaces, closed over at
   * instantiation so it is never model input.
   */
  binding: DurableObjectNamespace<WorkspaceHost>;
  /**
   * Which workspace this agent gets, by name. A thunk because the useful name —
   * caller plus repository — does not exist when the plugin list is built.
   *
   * One workspace is one container is one repository: `@cloudflare/computer`
   * pairs a Durable Object with exactly one container, so "never mix two
   * repositories" is structural here rather than a convention to maintain.
   */
  workspaceName: () => string;
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
   * run. It is one member of a family (`[[ ]]`, arrays, `set -o pipefail`,
   * process substitution), so the fix is the shell rather than a note in a prompt
   * telling the model to write POSIX.
   *
   * Set it only if the image actually has that shell: a missing one fails *every*
   * command rather than the bash-flavoured ones.
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
   * "These tools" is exact: {@link computerExec} deliberately does not merge it,
   * so a proxy set here does not reach the git that `@dynamicagents/plugins/repo`
   * runs through that export. The reasoning, and how a host opts in explicitly,
   * is written up there.
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
    ...findTools(ctx)
  };
}

/**
 * An `exec` bound to this workspace, for plugins that need a shell but should
 * not own a container.
 *
 * `@dynamicagents/plugins/repo` is the reason this exists: it needs `git` on a real
 * shell, but depending on this module would weld the two together and stop a
 * host from pointing it at its own container. Structurally typed for the same
 * reason — the two plugins compose without either importing the other.
 *
 * ## {@link ComputerConfig.env} is deliberately **not** merged here
 *
 * {@link buildComputerTools} merges it into every command; this does not.
 *
 * What this hands out is a raw shell to *another plugin*, whose commands this
 * module neither writes nor sees. `/repo` runs its unauthenticated git through
 * it and pins the environment those need — `GIT_TERMINAL_PROMPT=0` plus the
 * model-authored values it passes as variables. A host environment merged
 * underneath lets through every key it does *not* pin: `http_proxy`,
 * `GIT_PROXY_COMMAND`, `GIT_SSL_CAINFO`, `GIT_CONFIG_GLOBAL`, `GIT_EXEC_PATH` —
 * the last two redirect the config git reads and relocate its helper binaries.
 *
 * No token is at stake, since the credentialed operations do not run here at
 * all. The point is that changing what git does inside another plugin's commands
 * should not be something a container plugin's config field does by accident,
 * from a host that only meant to set a registry. A host that wants it composes
 * it where the merge is visible:
 *
 * ```ts
 * exec: (command, options) =>
 *   computerExec(config)(command, {
 *     ...options,
 *     env: { ...mine, ...options?.env }
 *   });
 * ```
 */
export function computerExec(config: ComputerConfig): (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    runtime?: unknown;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return async (command, options) => {
    // The caller forwards its execution's runtime state opaquely; only this side
    // knows the key it might carry. That is what lets `/repo` reach a sub-agent's
    // shared workspace without importing anything from here.
    const name =
      workspaceNameFromRuntime(options?.runtime) ?? config.workspaceName();
    using ws = await openWorkspace(
      config.binding.get(config.binding.idFromName(name))
    );

    const env = options?.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        )
      : undefined;

    // Named rather than inlined, because the note below has to state it: a
    // ceiling the model cannot see is one it cannot work within.
    const timeoutMs =
      options?.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `withShell`, never `withShellTranscript`: the caller reads this result in
    // code. `/repo` compares `stdout` against a URL, tests it for emptiness to
    // decide a tree is clean, and reads a sha out of it to push — all of which
    // need `stdout` to carry the answer alone, with git's diagnostics on the
    // channel git put them on.
    using handle = await ws.runtime.exec(withShell(command, config.shell), {
      cwd: options?.cwd ?? config.cwd ?? DEFAULT_CWD,
      encoding: "utf8",
      timeoutMs,
      ...(env ? { env } : {})
    });
    const result = await handle.result();
    const killed = cancelledNote(result.status, result.exitCode, timeoutMs);

    return {
      // `/repo` branches on `success`, which this runtime does not report — it
      // has `status` and `exitCode`. Derived from the exit code rather than the
      // status, because a command that runs and fails is `completed` here.
      success: result.exitCode === 0,
      stdout: result.stdout,
      // Appended rather than substituted: a command killed at the ceiling may
      // well have written plenty first, and that output is the more useful half.
      // This is the only field the note can travel on — `stdout` is a data
      // channel the caller parses, and the four fields are the whole contract.
      stderr: killed
        ? [result.stderr, killed].filter(Boolean).join("\n")
        : result.stderr,
      exitCode: result.exitCode
    };
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
      // sub-agent's comes from `runtime()`, see {@link WORKSPACE_RUNTIME_KEY} —
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

// --- the host half ----------------------------------------------------------

/**
 * The Durable Object everything above talks to.
 *
 * `./host/` is a directory rather than a subpath of its own, and that is the
 * point: one capability is one import path, so a consumer cannot install the
 * tools and miss the object they address. The two halves have opposite bundle
 * costs — an agent that only calls `bash` carries no container backend and no
 * isomorphic-git — and `"sideEffects": false` is what keeps that true, since
 * nothing here references the host unless the consumer does.
 *
 * The dependency runs one way for a mechanical reason: `./host/` imports the
 * leaf modules beside this file, never this barrel, because this barrel
 * re-exports `./host/` and a cycle through a module that builds a class at
 * import time is a base that evaluates `undefined`.
 */
export {
  WorkspaceObjectBase,
  IDLE_RECLAIM_MS,
  WORKSPACE_DIR,
  workspaceName,
  type WorkspaceObjectConfig,
  type WorkspaceGitConfig
} from "./host/workspace.js";

// The dependency install, exported because a host that wants to report on one —
// or a spec that drives it — needs the type, not because anything but
// `./host/workspace.ts` constructs it.
export { InstallJob, type InstallJobDeps } from "./host/install-job.js";

// The pull the library owns no alarm for. Its constants are exported because a
// host deferring to a drain has to back off at the same rate this does.
export {
  WorkspaceSync,
  SYNC_DRAIN_BUDGET_MS,
  SYNC_DRAIN_RESUME_MS,
  SYNC_DRAIN_MAX_BACKOFF_MS,
  syncRetryDelayMs,
  type DrainOutcome,
  type SyncDrainIntent,
  type WorkspaceSyncDeps
} from "./host/sync.js";

// `TRUST_CA_COMMAND` is exported so a host can assert what its image will be
// asked to run — see the file for why this cannot live in an entrypoint.
export {
  ContainerTrust,
  TRUST_CA_COMMAND,
  type ContainerTrustDeps
} from "./host/ca-trust.js";

export { WorkspaceGitHost, type GitHostDeps } from "./host/git-host.js";

export type { WorkspaceWakeHandlers } from "./host/wake.js";
