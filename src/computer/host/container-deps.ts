import { shellQuote, type Workspace } from "@cloudflare/computer";
import { deploymentFault } from "./container-fault.js";

/**
 * Dependency trees live on the container's disk, never in the workspace.
 *
 * A tree in the workspace is written through FUSE into computerd's in-memory
 * store, pulled into this object's SQLite, and pushed back into every fresh
 * container before its first command — measured at 76,740 entries and nine
 * minutes for one cold container. So a package root's `node_modules` is a bind
 * mount of container disk, and a new container reinstalls.
 *
 * The mount is made by the package manager's own invocation, through wrappers
 * this installs ahead of the real binaries on `PATH`. Mounting earlier cannot
 * work: a bootstrap that initialises submodules and installs each of them in one
 * command creates the directories the mounts belong in.
 */

/** Where the trees live on the container's disk. */
const DEPS_DISK = "/var/lib/workspace-deps";

/** First on Debian's default `PATH`, so a wrapper here shadows the real tool. */
const WRAPPER_DIR = "/usr/local/sbin";

const MOUNT_HELPER = `${WRAPPER_DIR}/workspace-deps-mount`;

/**
 * Every entry point that can write a `node_modules`, wrapped whether or not it
 * is installed yet: `corepack enable` or `npm i -g pnpm` adds one later.
 */
const WRAPPED = [
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "corepack",
  "bun",
  "bunx"
] as const;

/** Written into the tree by a successful host install; see `./install-job.ts`. */
export const INSTALLED_MARKER = ".da-installed";

/**
 * The per-container setup, and a read of the marker under `dir`.
 *
 * The helper mounts the package root the command targets — its directory, or
 * `--prefix`, `--cwd`, `--dir`, `-C` — only under the workspace, never inside
 * another tree. Workspace members are not mounted: a mount point cannot be
 * removed, so one guessed into `dist/` breaks `rm -rf dist`, and an install at
 * the root puts the bulk of the tree there.
 *
 * Wrappers are written with `install`, never through the path: `npm` is
 * commonly a symlink to `npm-cli.js`, and writing through it replaces npm with a
 * wrapper that execs itself. For the same reason a wrapper finds its tool on
 * `PATH` with `WRAPPER_DIR` skipped, when it runs. `corepack enable` puts its
 * shims beside the `corepack` on `PATH` — the wrapper — so it is pointed at the
 * real one's directory instead.
 */
export function depsSetupCommand(workspaceDir: string, dir?: string): string {
  const helper = [
    "#!/bin/sh",
    'cwd="$1"; dir="$1"; shift',
    'while [ $# -gt 0 ]; do case "$1" in',
    "  --) break;;",
    '  --prefix=*|--cwd=*|--dir=*) dir="${1#*=}";;',
    '  --prefix|--cwd|--dir|-C) [ $# -gt 1 ] && { dir="$2"; shift; };;',
    "esac; shift; done",
    'case "$dir" in /*) ;; *) dir="$cwd/$dir";; esac',
    'dir=$(cd "$dir" 2>/dev/null && pwd -P) || exit 0',
    'while [ "$dir" != / ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done',
    `case "$dir" in */node_modules/*) exit 0;; ${workspaceDir}|${workspaceDir}/*) ;; *) exit 0;; esac`,
    'nm="$dir/node_modules"',
    'mountpoint -q "$nm" && exit 0',
    `disk="${DEPS_DISK}/$(printf %s "$dir" | sha256sum | cut -c1-16)"`,
    'mkdir -p "$disk" "$nm" && mount --bind "$disk" "$nm" && exit 0',
    `echo "workspace-deps: could not put $nm on the container's disk" >&2`,
    "exit 1"
  ].join("\n");
  const wrapper = [
    "#!/bin/sh",
    `${MOUNT_HELPER} "$PWD" "$@" || exit 1`,
    'tool=$(basename "$0"); real=',
    `IFS=:; for d in $PATH; do [ "$d" = ${WRAPPER_DIR} ] && continue; [ -x "$d/$tool" ] && { real="$d"; break; }; done; unset IFS`,
    '[ -n "$real" ] || { echo "$tool: not found" >&2; exit 127; }',
    'case "$tool:${1:-}:$*" in',
    "  *--install-directory*) ;;",
    '  corepack:enable:*|corepack:disable:*) cmd="$1"; shift; set -- "$cmd" --install-directory "$real" "$@";;',
    "esac",
    'exec "$real/$tool" "$@"'
  ].join("\n");
  return [
    `printf '%s\\n' ${shellQuote(helper)} > /tmp/workspace-deps-mount`,
    `install -m 755 /tmp/workspace-deps-mount ${MOUNT_HELPER} || exit 1`,
    `printf '%s\\n' ${shellQuote(wrapper)} > /tmp/workspace-deps-wrap`,
    `for tool in ${WRAPPED.join(" ")}; do install -m 755 /tmp/workspace-deps-wrap "${WRAPPER_DIR}/$tool" || exit 1; done`,
    ...(dir
      ? [
          `echo "MARKER $(cat ${shellQuote(`${dir}/node_modules/${INSTALLED_MARKER}`)} 2>/dev/null || echo -)"`
        ]
      : []),
    "echo SETUP OK"
  ].join("\n");
}

/** What a setup run found in the container. */
export interface DepsFound {
  /** The marker's contents, or `null` when no host install completed here. */
  marker: string | null;
}

export interface ContainerDepsDeps {
  workspace: () => Workspace;
  workspaceDir: string;
  tag: () => string;
  id: () => string;
}

/**
 * The setup above, once per container.
 *
 * In memory, with {@link file://./ca-trust.ts}'s lifetime and for its reason: it
 * describes one container, and an isolate that lost it re-runs an idempotent
 * command.
 */
export class ContainerDeps {
  #done = false;

  constructor(private readonly deps: ContainerDepsDeps) {}

  forget(): void {
    this.#done = false;
  }

  /**
   * Run the setup if this container has not had it, and report the marker under
   * `dir`. `undefined` when it had, or with no `dir`.
   *
   * Throws when the container answered and the setup did not finish: nothing
   * would say so later, since an unwrapped install succeeds, into the workspace.
   * An unreachable container is only logged, like the CA install: the command
   * after it fails the same way.
   */
  async ensure(dir?: string): Promise<DepsFound | undefined> {
    if (this.#done) return undefined;
    const startedAt = Date.now();
    let output: string;
    try {
      using handle = await this.deps
        .workspace()
        .runtime.exec(depsSetupCommand(this.deps.workspaceDir, dir), {
          cwd: "/",
          encoding: "utf8",
          timeoutMs: 30_000
        });
      const result = await handle.result();
      output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      this.#done = result.exitCode === 0 && output.includes("SETUP OK");
    } catch (err) {
      const fault = deploymentFault(err);
      console.warn(
        `[${this.deps.tag()}] ${fault?.summary ?? "could not set up container dependencies"}`,
        {
          id: this.deps.id(),
          ...(fault ? { remedy: fault.remedy } : {}),
          err: String(err)
        }
      );
      return undefined;
    }
    console.info(`[${this.deps.tag()}] container dependency setup`, {
      id: this.deps.id(),
      ok: this.#done,
      ms: Date.now() - startedAt,
      ...(this.#done ? {} : { output })
    });
    if (!this.#done)
      throw new Error(
        `could not put node_modules on the container's disk: ${output.trim() || "the setup exited without output"}`
      );
    const marker = /^MARKER (.*)$/m.exec(output)?.[1]?.trim();
    if (marker === undefined) return undefined;
    return { marker: marker === "-" ? null : marker };
  }
}
