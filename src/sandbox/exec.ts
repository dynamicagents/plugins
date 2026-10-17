import { humanMs } from "./format.js";
import { SANDBOX_ROOT } from "./header.js";
import { sandboxNameFromRuntime } from "./name.js";

/**
 * A shell in a sandbox, for a plugin that needs one but does not own the
 * container: `/repo-github`'s git, `/scratch`, a host's own scripts. It answers
 * the contract those plugins take — `success`, `stdout`, `stderr` and
 * `exitCode`.
 *
 * Every command runs as the agent, with every egress rule's `env`, and under
 * `timeout` at its limit: the sandbox's own `exec` can only stop waiting, and a
 * command it stopped waiting for would go on running.
 *
 * It merges no host environment of its own: this is a raw shell for another
 * plugin's commands, and a host environment underneath would let through what
 * git honours — `GIT_PROXY_COMMAND`, `GIT_CONFIG_GLOBAL`, `http_proxy`. What a
 * host merges into a plugin's commands it composes where the merge is visible.
 */

/** The sandbox RPC this uses. */
export interface SandboxExecHost {
  exec(
    argv: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SandboxExecConfig {
  /** Addressed by name only: the sandbox's lifecycle needs it. */
  binding: DurableObjectNamespace<SandboxExecHost & Rpc.DurableObjectBranded>;
  /** The sandbox a parent's own commands run in. A sub-agent's comes from its `runtime()`. */
  sandboxName: () => string;
  /** Default `/workspace`. */
  cwd?: string;
  /**
   * The shell a command string runs in. Default `bash`: a model writing shell
   * writes bash, and `/bin/sh` is dash on Debian, which fails `${PIPESTATUS[0]}`
   * and the rest of that family after the command they wrapped has run.
   */
  shell?: string;
  /** Per command. Default {@link DEFAULT_EXEC_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A command that has not finished in this long is a hung command. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** After `timeout`'s TERM, how long before its KILL. */
const KILL_AFTER_S = 5;
/**
 * `timeout`'s exits for a command it ended. Read as the limit only once the
 * limit has passed: any SIGKILL is a 137, an out-of-memory kill included.
 */
const TIMED_OUT = new Set([124, 137]);

export function sandboxExec(config: SandboxExecConfig): (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    /** A sub-agent's `runtime()`, forwarded opaquely by the plugin calling this. */
    runtime?: unknown;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return async (command, options) => {
    const name =
      sandboxNameFromRuntime(options?.runtime) ?? config.sandboxName();
    const limitMs =
      options?.timeout ?? config.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const env = options?.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        )
      : undefined;
    const startedAt = Date.now();
    const run = await config.binding
      .getByName(name)
      .exec(
        [
          "timeout",
          `--kill-after=${KILL_AFTER_S}`,
          String(Math.ceil(limitMs / 1000)),
          config.shell ?? "bash",
          "-c",
          command
        ],
        {
          cwd: options?.cwd ?? config.cwd ?? SANDBOX_ROOT,
          ...(env ? { env } : {}),
          timeoutMs: limitMs + (KILL_AFTER_S + 5) * 1000
        }
      );
    const killed =
      TIMED_OUT.has(run.exitCode) && Date.now() - startedAt >= limitMs;
    return {
      success: run.exitCode === 0,
      stdout: run.stdout,
      // Appended rather than substituted: a command killed at its limit may
      // have written plenty first, and `stdout` is a channel callers parse.
      stderr: killed
        ? [
            run.stderr,
            `the command was killed at its time limit of ${humanMs(limitMs)}, so anything it had not yet written is gone`
          ]
            .filter(Boolean)
            .join("\n")
        : run.stderr,
      exitCode: run.exitCode
    };
  };
}
