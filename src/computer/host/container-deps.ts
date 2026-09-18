import { shellQuote, type Workspace } from "@cloudflare/computer";
import { deploymentFault } from "./container-fault.js";

/**
 * Dependency trees live on the container's disk, never in the workspace.
 *
 * A tree in the workspace is written through FUSE into computerd's in-memory
 * store, pulled into this object's SQLite, and pushed back into every fresh
 * container before its first command — measured at 76,740 entries and nine
 * minutes for one cold container. So every `node_modules` under the workspace
 * is a bind mount of container disk, and a new container reinstalls.
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

/** Every entry point that can write a `node_modules`. */
const WRAPPED = ["npm", "npx", "pnpm", "yarn", "corepack"] as const;

/** Written into the tree by a successful host install; see `./install-job.ts`. */
export const INSTALLED_MARKER = ".da-installed";

/**
 * The per-container setup, and a read of the marker under `dir`.
 *
 * The helper walks up to the package root, and mounts only under the workspace
 * and never inside another tree. Wrappers are written with `install`, never
 * through the path: `npm` is commonly a symlink to `npm-cli.js`, and writing
 * through it replaces npm with a wrapper that execs itself. For the same reason
 * the real binary is resolved with `WRAPPER_DIR` skipped, so re-running this
 * finds the tool rather than its wrapper.
 */
export function depsSetupCommand(workspaceDir: string, dir?: string): string {
  const helper = [
    "#!/bin/sh",
    'dir="$1"',
    'while [ "$dir" != / ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done',
    `case "$dir" in */node_modules/*) exit 0;; ${workspaceDir}|${workspaceDir}/*) ;; *) exit 0;; esac`,
    'nm="$dir/node_modules"',
    'mountpoint -q "$nm" && exit 0',
    `disk="${DEPS_DISK}/$(printf %s "$dir" | sha256sum | cut -c1-16)"`,
    'mkdir -p "$disk" "$nm" && mount --bind "$disk" "$nm" && exit 0',
    `echo "workspace-deps: could not put $nm on the container's disk" >&2`,
    "exit 1"
  ].join("\n");
  return [
    `printf '%s\\n' ${shellQuote(helper)} > /tmp/workspace-deps-mount`,
    `install -m 755 /tmp/workspace-deps-mount ${MOUNT_HELPER} || exit 1`,
    `for tool in ${WRAPPED.join(" ")}; do`,
    "  real=",
    `  IFS=:; for d in $PATH; do [ "$d" = ${WRAPPER_DIR} ] && continue; if [ -x "$d/$tool" ]; then real="$d/$tool"; break; fi; done; unset IFS`,
    '  [ -n "$real" ] || continue',
    `  printf '#!/bin/sh\\n${MOUNT_HELPER} "$PWD" || exit 1\\nexec %s "$@"\\n' "$real" > /tmp/workspace-deps-wrap`,
    `  install -m 755 /tmp/workspace-deps-wrap "${WRAPPER_DIR}/$tool" || exit 1`,
    '  echo "WRAPPED $tool"',
    "done",
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
   * `dir`. `undefined` when nothing ran — already set up, or unreachable.
   *
   * Never throws, like the CA install: a command run without wrappers fails
   * loudly on its own.
   */
  async ensure(dir?: string): Promise<DepsFound | undefined> {
    if (this.#done) return undefined;
    const startedAt = Date.now();
    try {
      using handle = await this.deps
        .workspace()
        .runtime.exec(depsSetupCommand(this.deps.workspaceDir, dir), {
          cwd: "/",
          encoding: "utf8",
          timeoutMs: 30_000
        });
      const result = await handle.result();
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      this.#done = result.exitCode === 0 && output.includes("SETUP OK");
      const marker = /^MARKER (.*)$/m.exec(output)?.[1]?.trim();
      console.info(`[${this.deps.tag()}] container dependency setup`, {
        id: this.deps.id(),
        ok: this.#done,
        wrapped: [...output.matchAll(/^WRAPPED (\S+)$/gm)].map((m) => m[1]),
        ms: Date.now() - startedAt,
        ...(this.#done ? {} : { exitCode: result.exitCode, output })
      });
      if (!this.#done || marker === undefined) return undefined;
      return { marker: marker === "-" ? null : marker };
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
  }
}
