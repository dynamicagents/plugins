import type { WorkspaceLike } from "@cloudflare/think";
import type { WorkspaceAdvisory } from "../workspace/advisory.js";
import { workspaceNameFromRuntime } from "../workspace/open.js";
import type {
  ComputerClient,
  ComputerFs,
  FoundEntry,
  GrepMatch,
  GrepOptions
} from "./client.js";
import { RUN_DIR } from "../sandbox/constants.js";
import { routedWorkspace } from "./proxy.js";

/**
 * The computer tools over a `/sandbox` object instead of a workspace.
 *
 * The checkout is the container's own disk, so every call reaches the
 * container: a file read wakes a stopped one (measured at about two seconds,
 * once), and `grep` and `find` are `ripgrep` there. The sandbox's RPCs run as
 * the agent and refuse anything outside `/workspace`.
 *
 * ```ts
 * override workspace = sandboxWorkspace(config, () => this.pluginContext().runtime());
 * ```
 *
 * `sandboxComputer(config)` then finds it the way `computer(config)` finds a
 * workspace's.
 */

/** The sandbox RPCs this uses. A `/sandbox` object answers all of them. */
export interface SandboxComputerHost extends Rpc.DurableObjectBranded {
  exec(
    argv: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string): Promise<void>;
  stat(
    path: string
  ): Promise<{ type: string; size: number; modifiedAt: number } | null>;
  readDir(path: string): Promise<{ name: string; type: string }[]>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  advisories(): Promise<readonly WorkspaceAdvisory[]>;
}

export interface SandboxComputerConfig {
  /** Addressed by name only: the sandbox's lifecycle needs it. */
  binding: DurableObjectNamespace<SandboxComputerHost>;
  /** The sandbox a parent's own turn works in. A sub-agent's comes from its `runtime()`. */
  sandboxName: () => string;
  cwd?: string;
}

/** After `timeout`'s TERM, how long before its KILL. */
const KILL_AFTER_S = 5;
/** `timeout`'s exits for a command it ended: TERM taken, or KILL after it was not. */
const TIMED_OUT = new Set([124, 137]);

/**
 * A command's processes carry a marker, for `kill` to find them by — through
 * the launch and after it, since `exec` keeps it in every command line.
 * `timeout` ends the command where it runs at its limit, which a Worker-side
 * signal cannot.
 */
const MARKER = "da-exec-";
const CANCELLED = `${RUN_DIR}/cancelled`;

/**
 * The launch and `kill` are a handshake, because a command can still be on its
 * way in — starting the container — when it is cancelled: `kill` marks the
 * command cancelled before it signals, and the launch checks the mark before
 * it starts. Either the command never starts, or it is running when `kill`
 * signals it.
 */
const LAUNCH = [
  `[ -e "${CANCELLED}/$0" ] && exit 130`,
  `exec timeout --kill-after=${KILL_AFTER_S} "$2" sh -c "$1" "$0"`
].join("\n");

/** The marker arrives in two halves, so this script's own command line is not one `pkill` matches. */
const CANCEL = [
  'm="$1$2"',
  `mkdir -p ${CANCELLED} && : > "${CANCELLED}/$m"`,
  'pkill -TERM -f "$m"',
  "exit 0"
].join("\n");
/** What one `find` or `grep` returns at most, with no `limit` of its own. */
const MAX_FOUND = 10_000;

export function sandboxWorkspace(
  config: SandboxComputerConfig,
  runtime?: () => unknown
): WorkspaceLike {
  const host = (name: string) =>
    config.binding.getByName(name) as unknown as SandboxComputerHost;
  return routedWorkspace(
    {
      kind: "sandbox",
      name: () => workspaceNameFromRuntime(runtime?.()) ?? config.sandboxName(),
      open: async (name) => sandboxClient(host(name)),
      // The same: there is no copy of the files outside the container.
      openFs: async (name) => sandboxClient(host(name)),
      advisories: (name) => host(name).advisories()
    },
    config.cwd ?? "/workspace"
  );
}

function missing(path: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${path}`),
    { code: "ENOENT" }
  );
}

/** The computer tools' client over one sandbox. */
export function sandboxClient(host: SandboxComputerHost): ComputerClient {
  const readFile = async (path: string, encoding?: "utf8") => {
    const bytes = await host.readFile(path);
    if (bytes === null) throw missing(path);
    return encoding === "utf8"
      ? new TextDecoder().decode(bytes)
      : new Blob([bytes]).stream();
  };

  const fs: ComputerFs = {
    readFile: readFile as ComputerFs["readFile"],
    async stat(path) {
      const stat = await host.stat(path);
      if (!stat) throw missing(path);
      return {
        size: stat.size,
        mtime: stat.modifiedAt,
        isFile: stat.type === "file",
        isDirectory: stat.type === "directory",
        isSymbolicLink: stat.type === "symlink"
      };
    },
    async readdir(path, options = {}) {
      const from = options.offset ?? 0;
      return (await host.readDir(path))
        .slice(
          from,
          options.limit === undefined ? undefined : from + options.limit
        )
        .map((entry) => ({
          name: entry.name,
          isFile: entry.type === "file",
          isDirectory: entry.type === "directory"
        }));
    },
    find: (directory, pattern, options = {}) =>
      find(host, directory, pattern, options),
    grep: (pattern, path, options = {}) => grep(host, pattern, path, options),
    writeFile: (path, content) => host.writeFile(path, content),
    mkdir: (path) => host.mkdir(path),
    rm: (path, options = {}) =>
      host.rm(path, options.recursive ? { recursive: true } : {})
  };

  return {
    fs,
    runtime: {
      async exec(command, options) {
        const id = crypto.randomUUID();
        const marker = `${MARKER}${id}`;
        const startedAt = Date.now();
        let killed = false;
        const running = host.exec(
          [
            "sh",
            "-c",
            LAUNCH,
            marker,
            command,
            // At least a second: `timeout 0` is no limit at all.
            String(Math.max(1, Math.ceil(options.timeoutMs / 1000)))
          ],
          {
            cwd: options.cwd,
            ...(options.env ? { env: options.env } : {}),
            timeoutMs: options.timeoutMs + (KILL_AFTER_S + 5) * 1000
          }
        );
        running.catch(() => undefined);
        return {
          async result() {
            const result = await running;
            const timedOut =
              TIMED_OUT.has(result.exitCode) &&
              Date.now() - startedAt >= options.timeoutMs;
            return {
              ...result,
              status:
                killed || timedOut
                  ? ("cancelled" as const)
                  : ("completed" as const)
            };
          },
          async kill() {
            killed = true;
            await host.exec(["sh", "-c", CANCEL, "da-cancel", MARKER, id]);
          },
          [Symbol.dispose]() {}
        };
      }
    },
    [Symbol.dispose]() {}
  };
}

/**
 * `rg` over `target`, from where its globs anchor: a directory's own, with
 * `include` applied, or a file's parent. The script prints that directory
 * first, then `rg`'s output cut at `lines`, so a search of a whole checkout
 * returns what the tool can show rather than everything.
 */
const RG_SCRIPT = [
  't="$1"; include="$2"; lines="$3"; shift 3',
  '[ -e "$t" ] || { echo "ENOENT" >&2; exit 2; }',
  'if [ -d "$t" ]; then cd "$t" || exit 2; a=.',
  '  if [ -n "$include" ]; then set -- -g "/$include" "$@"; fi',
  'else cd "$(dirname "$t")" || exit 2; a="./$(basename "$t")"; fi',
  "pwd",
  'rg "$@" -- "$a" < /dev/null | head -n "$lines"'
].join("\n");

async function rg(
  host: SandboxComputerHost,
  target: string,
  include: string | undefined,
  args: string[],
  lines: number
): Promise<{ cwd: string; out: string[] }> {
  const run = await host.exec([
    "sh",
    "-c",
    RG_SCRIPT,
    "rg",
    target,
    (include ?? "").replace(/^\/+/, ""),
    String(lines),
    ...args
  ]);
  if (run.exitCode === 2 && /ENOENT/.test(run.stderr)) throw missing(target);
  const [cwd = target, ...out] = run.stdout.split("\n");
  if (out.every((line) => line === "") && run.stderr.trim() !== "")
    throw new Error(run.stderr.trim());
  return { cwd, out: out.filter(Boolean) };
}

function absolute(cwd: string, printed: string): string {
  const rest = printed.replace(/^\.\//, "");
  return cwd === "/" ? `/${rest}` : `${cwd}/${rest}`;
}

/** Hidden and ignored files too, as the old walk read them; `exclude` pruned. */
function scope(exclude: readonly string[] | undefined): string[] {
  return [
    "--hidden",
    "--no-ignore",
    "--sort",
    "path",
    ...(exclude ?? []).flatMap((glob) => ["-g", `!${glob}`])
  ];
}

async function find(
  host: SandboxComputerHost,
  directory: string,
  pattern: string | undefined,
  options: { limit?: number; offset?: number; exclude?: string[] }
): Promise<FoundEntry[]> {
  const from = options.offset ?? 0;
  const take = options.limit ?? MAX_FOUND;
  const { cwd, out } = await rg(
    host,
    directory,
    pattern,
    ["--files", ...scope(options.exclude)],
    Math.min(from + take, MAX_FOUND)
  );
  // Files only: `rg --files` lists no directories.
  return out
    .slice(from, from + take)
    .map((path) => ({ path: absolute(cwd, path), type: "file" }));
}

interface RgLine {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

async function grep(
  host: SandboxComputerHost,
  pattern: string,
  path: string,
  options: GrepOptions
): Promise<GrepMatch[]> {
  const around = options.context ?? 0;
  const from = options.offset ?? 0;
  const take = options.limit ?? MAX_FOUND;
  const { cwd, out } = await rg(
    host,
    path,
    options.include,
    [
      "--json",
      ...scope(options.exclude),
      ...(options.regex ? [] : ["--fixed-strings"]),
      ...(options.ignoreCase ? ["--ignore-case"] : []),
      ...(around > 0 ? ["--context", String(around)] : []),
      "-e",
      pattern
    ],
    // Enough for every match it can return to arrive whole: each brings at
    // most its context, and opens and closes a file.
    (from + take) * (2 * around + 3) + 16
  );

  // Per file, every line rg printed, so each match takes its context from them.
  const files = new Map<
    string,
    { line: number; text: string; isMatch: boolean }[]
  >();
  const order: { file: string; line: number; text: string }[] = [];
  for (const raw of out) {
    let entry: RgLine;
    try {
      entry = JSON.parse(raw) as RgLine;
    } catch {
      continue;
    }
    if (entry.type !== "match" && entry.type !== "context") continue;
    const file = absolute(cwd, entry.data?.path?.text ?? "");
    const line = entry.data?.line_number ?? 0;
    const text = (entry.data?.lines?.text ?? "").replace(/\r?\n$/, "");
    const lines = files.get(file) ?? [];
    lines.push({ line, text, isMatch: entry.type === "match" });
    files.set(file, lines);
    if (entry.type === "match") order.push({ file, line, text });
  }

  return order.slice(from, from + take).map(({ file, line, text }) => ({
    path: file,
    line,
    text,
    ...(around > 0
      ? {
          context: (files.get(file) ?? []).filter(
            (other) => Math.abs(other.line - line) <= around
          )
        }
      : {})
  }));
}
