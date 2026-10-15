/**
 * `@dynamicagents/plugins/sandbox/daemon` — the entrypoint of a sandbox image.
 *
 * Node, not a Worker: this is what the container runs. A consumer bundles it
 * with its own CLI options from its own `node_modules`, so the daemon and the
 * object speak one `agents` version.
 *
 * It is the harness daemon with one adapter that wears two faces. The root
 * session is the object's control channel: it answers at once and starts no
 * CLI, which is how the object starts a container without spending a turn.
 * Every other session runs the CLI, each turn launched the way its run header
 * says and only once the object has prepared this container's egress.
 */
import {
  CONTAINER_ENV,
  type ContainerAdapter
} from "agents/harness/container/daemon";
import {
  cliAdapter,
  serveFromEnv,
  type CliAdapterOptions,
  type CliCommand,
  type CliTurn,
  type DaemonServer
} from "agents/harness/container/runtime";
import { AGENT_GID, AGENT_HOME, AGENT_UID } from "../agent-exec.js";
import { EGRESS_READY, EGRESS_WAIT_MS } from "../constants.js";
import { readRunHeader, SANDBOX_ROOT, type RunHeader } from "../header.js";
import { withControlSession } from "./composite.js";

export { withControlSession } from "./composite.js";

/** One CLI turn, with its run header already taken off the prompt. */
export type SandboxCliTurn = CliTurn & {
  readonly header: RunHeader | undefined;
};

export interface SandboxDaemonOptions {
  /**
   * The CLI the sessions run. Everything a sandbox decides about how it runs —
   * its user, its homes, its working directory, the wait for egress — is set
   * here and may not be passed.
   */
  readonly cli: Omit<
    CliAdapterOptions,
    "command" | "user" | "homes" | "skeleton" | "cwd"
  > & {
    readonly command: (turn: SandboxCliTurn) => CliCommand;
  };
  /** The environment the daemon was started with. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Wait for this container's egress, then run the CLI in the run's directory.
 *
 * `$1` is the runtime id the object writes into {@link EGRESS_READY} once it
 * has registered what the harness does not; a marker naming another runtime is
 * a snapshot's, and does not count.
 */
const LAUNCH = [
  'rt="$1"; cwd="$2"; shift 2',
  `n=0; while [ "$(cat ${EGRESS_READY} 2>/dev/null)" != "$rt" ]; do`,
  `  n=$((n+1)); if [ "$n" -gt ${Math.ceil(EGRESS_WAIT_MS / 100)} ]; then`,
  '    echo "the sandbox never prepared this container\'s egress" >&2; exit 97',
  "  fi; sleep 0.1",
  "done",
  'cd "$cwd" || exit 98',
  'exec "$@"'
].join("\n");

/** The adapter a sandbox image serves. Exported for specs; an image calls {@link serveSandboxDaemon}. */
export function sandboxAdapter(
  options: SandboxDaemonOptions,
  runtimeId: string
): ContainerAdapter {
  const cli = cliAdapter({
    ...options.cli,
    // Claude Code refuses to skip permission prompts as root, and the CLI's user
    // must reach its own home: under the daemon's (root's, mode 700) it runs,
    // answers, and writes no session files, so a lost container cannot resume
    // it (observed).
    user: { uid: AGENT_UID, gid: AGENT_GID },
    homes: `${AGENT_HOME}/.harness/sessions`,
    skeleton: AGENT_HOME,
    command(turn) {
      const { header, prompt } = readRunHeader(turn.prompt);
      const inner = options.cli.command({ ...turn, prompt, header });
      return {
        ...inner,
        argv: [
          "sh",
          "-c",
          LAUNCH,
          "sandbox-cli",
          runtimeId,
          header?.cwd ?? SANDBOX_ROOT,
          ...inner.argv
        ]
      };
    }
  });
  return withControlSession(cli);
}

/** Serve the daemon with the identity, secret and port the object started the container with. */
export function serveSandboxDaemon(
  options: SandboxDaemonOptions
): Promise<DaemonServer> {
  const env = options.env ?? process.env;
  const runtimeId = env[CONTAINER_ENV.runtimeId];
  if (!runtimeId)
    throw new Error(
      `${CONTAINER_ENV.runtimeId} is not set: the sandbox object starts this image`
    );
  return serveFromEnv(sandboxAdapter(options, runtimeId), env);
}
