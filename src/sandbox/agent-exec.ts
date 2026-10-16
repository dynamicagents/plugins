/**
 * Running a command in the container as the agent, and only as the agent.
 *
 * `ctx.container.exec(argv, { user })` changes the uid and keeps root's
 * capability set: a process started that way as `10001:10001` was measured with
 * `CapEff 0xabac35fb`, `CAP_DAC_OVERRIDE` and `CAP_SYS_PTRACE` among it. So
 * every host command goes through `setpriv`, which drops the inheritable and
 * bounding sets and changes identity in one step, and the image provides it
 * (util-linux).
 *
 * `setpriv` starts as root, so it is named by its absolute path and given no
 * environment of the caller's: a `PATH` or `LD_PRELOAD` would otherwise be
 * honoured as root before the drop. The command's environment is applied after
 * it, by `env -i`, which also clears whatever the container's own carries.
 */

/** The image's unprivileged user, which owns `/workspace` and runs the CLI. */
export const AGENT_UID = 10001;
export const AGENT_GID = 10001;
export const AGENT_HOME = "/home/agent";

const SETPRIV = "/usr/bin/setpriv";
const ENV = "/usr/bin/env";
/** Where the image's tools are. A command's own `env` may replace it. */
const AGENT_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** `argv`, run as the agent with no capabilities, in exactly {@link agentEnv}`(env)`. */
export function asAgent(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {}
): string[] {
  if (argv.length === 0) throw new Error("asAgent: an empty command");
  return [
    SETPRIV,
    `--reuid=${AGENT_UID}`,
    `--regid=${AGENT_GID}`,
    "--init-groups",
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--",
    ENV,
    "-i",
    ...Object.entries(agentEnv(env)).map(([name, value]) => `${name}=${value}`),
    ...argv
  ];
}

/** The environment a command run {@link asAgent} expects of its user. */
export function agentEnv(
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return {
    HOME: AGENT_HOME,
    USER: "agent",
    LOGNAME: "agent",
    PATH: AGENT_PATH,
    ...extra
  };
}

/** A shell string for `sh -c`, single-quoted so nothing in it is expanded. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
