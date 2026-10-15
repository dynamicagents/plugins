/**
 * Running a command in the container as the agent, and only as the agent.
 *
 * `ctx.container.exec(argv, { user })` changes the uid and keeps root's
 * capability set: a process started that way as `10001:10001` was measured with
 * `CapEff 0xabac35fb`, `CAP_DAC_OVERRIDE` and `CAP_SYS_PTRACE` among it, and
 * read root's mode-400 `/proc/1/environ`, where the daemon's token is. The CLI
 * the daemon spawns is clean; only commands a host sends in this way are not.
 * So every host command goes through `setpriv`, which drops the inheritable and
 * bounding sets and changes identity in one step, and the image provides it
 * (util-linux).
 */

/** The image's unprivileged user, which owns `/workspace` and runs the CLI. */
export const AGENT_UID = 10001;
export const AGENT_GID = 10001;
export const AGENT_HOME = "/home/agent";

/** `argv`, run as the agent with no capabilities. */
export function asAgent(argv: readonly string[]): string[] {
  if (argv.length === 0) throw new Error("asAgent: an empty command");
  return [
    "setpriv",
    `--reuid=${AGENT_UID}`,
    `--regid=${AGENT_GID}`,
    "--init-groups",
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--",
    ...argv
  ];
}

/** The environment a command run {@link asAgent} expects of its user. */
export function agentEnv(
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return { HOME: AGENT_HOME, USER: "agent", LOGNAME: "agent", ...extra };
}

/** A shell string for `sh -c`, single-quoted so nothing in it is expanded. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
