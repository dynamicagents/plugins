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
import { readFileSync } from "node:fs";
import { AGENT_HOME, AGENT_UID } from "../agent-exec.js";
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
 * The one capability the daemon holds, `CAP_NET_BIND_SERVICE`, which grants
 * nothing here. It is held so the daemon's capabilities are not a subset of
 * an agent process's: Linux then refuses same-uid processes its
 * `/proc/<pid>/environ` and `mem`, where the harness token is. Measured: a CLI
 * launched this way reads neither, and one that kept the capability reads the
 * token. A same-uid process can still signal the daemon, which ends the
 * container, as a crash would.
 */
const DAEMON_CAPABILITY = 10;

/** How the daemon launches the CLI: without the capability it holds. */
const DROP_DAEMON_CAPABILITY = [
  "/usr/bin/setpriv",
  "--ambient-caps=-all",
  "--inh-caps=-all",
  "--"
];

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

/**
 * What a session's home starts as: root-owned in the image, so a session starts
 * from what the image says rather than from what an earlier one left.
 */
export const SESSION_SKELETON = "/etc/da/skel";

/** The adapter a sandbox image serves. Exported for specs; an image calls {@link serveSandboxDaemon}. */
export function sandboxAdapter(
  options: SandboxDaemonOptions,
  runtimeId: string
): ContainerAdapter {
  const cli = cliAdapter({
    ...options.cli,
    // No `user`: the daemon is already the agent (see `serveSandboxDaemon`), so
    // the adapter chowns nothing. Given one, it chowns each home as root, and
    // chown follows a symlink the agent left there to whatever file it names.
    homes: `${AGENT_HOME}/.harness/sessions`,
    skeleton: SESSION_SKELETON,
    command(turn) {
      const { header, prompt } = readRunHeader(turn.prompt);
      const inner = options.cli.command({ ...turn, prompt, header });
      return {
        ...inner,
        argv: [
          ...DROP_DAEMON_CAPABILITY,
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

/**
 * Serve the daemon with the identity, secret and port the object started the
 * container with — as the agent, never root, holding {@link DAEMON_CAPABILITY}:
 * the image starts it through `setpriv` (see the README), and this refuses to
 * start otherwise.
 */
export function serveSandboxDaemon(
  options: SandboxDaemonOptions
): Promise<DaemonServer> {
  const uid = process.getuid?.();
  if (uid !== AGENT_UID || !holdsCapability(DAEMON_CAPABILITY))
    throw new Error(
      `the sandbox daemon runs as the agent (uid ${AGENT_UID}) holding net_bind_service, ` +
        `and this is uid ${uid}: start it through setpriv, as the README's ENTRYPOINT does`
    );
  const env = options.env ?? process.env;
  // `serveFromEnv` deletes it from the env it is given, and the CLI inherits
  // `process.env`: whatever env was given, the CLI gets no way to the daemon.
  if (env !== process.env) delete process.env[CONTAINER_ENV.token];
  const runtimeId = env[CONTAINER_ENV.runtimeId];
  if (!runtimeId)
    throw new Error(
      `${CONTAINER_ENV.runtimeId} is not set: the sandbox object starts this image`
    );
  return serveFromEnv(sandboxAdapter(options, runtimeId), env);
}

/** Whether this process's permitted set holds capability `bit`. */
function holdsCapability(bit: number): boolean {
  const permitted = /^CapPrm:\s*([0-9a-f]+)$/m.exec(
    readFileSync("/proc/self/status", "utf8")
  )?.[1];
  return (
    permitted !== undefined &&
    ((BigInt(`0x${permitted}`) >> BigInt(bit)) & 1n) === 1n
  );
}
