import { cancelledNote } from "./format.js";
import {
  openWorkspace,
  workspaceNameFromRuntime,
  type WorkspaceHost
} from "./open.js";
import { withShell } from "./shell.js";

/**
 * Running a command in a workspace's container, from outside the workspace
 * object: what `/computer`'s tools and `/repo`'s git share, and how a host
 * reaches its own container.
 */

/** A command that has not finished in this long is a hung command. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Where checkouts live, in the container and in the workspace alike. */
export const DEFAULT_CWD = "/workspace";

/** Which workspace a caller reaches, and how its commands run there. */
export interface WorkspaceClientConfig {
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
 * ## The agent tools' `env` is deliberately **not** merged here
 *
 * `/computer`'s `ComputerConfig.env` is merged into every command its tools
 * run; this takes no environment of its own.
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
 * should not be something a tools plugin's config field does by accident,
 * from a host that only meant to set a registry. A host that wants it composes
 * it where the merge is visible:
 *
 * ```ts
 * exec: (command, options) =>
 *   workspaceExec(config)(command, {
 *     ...options,
 *     env: { ...mine, ...options?.env }
 *   });
 * ```
 */
export function workspaceExec(config: WorkspaceClientConfig): (
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
    // The caller forwards its sub-agent's runtime opaquely; only this side
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
