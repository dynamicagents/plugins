import type { WorkspaceLike } from "@cloudflare/think";
import type { WorkspaceClient } from "@cloudflare/computer";
import { withFileLock } from "./file-lock.js";
import { writeGate } from "./gate.js";
import { openWorkspaceFs, workspaceNameFromRuntime } from "./open.js";
import type { WorkspaceHost } from "./open.js";
import { guardPath, WALK_SKIPS } from "./paths.js";
import type { ComputerConfig } from "./index.js";

/**
 * The container's workspace, as the agent's own `this.workspace`.
 *
 * Think's `read`, `write`, `edit` and `delete` run against whatever an agent's
 * workspace is, and `computer()`'s tools replace only the ones it names. So an
 * agent with a container and Think's default workspace would run `bash` in the
 * container and `write` in its own SQLite, and nothing would say so. An agent
 * that installs `computer` sets this instead:
 *
 * ```ts
 * override workspace = computerWorkspace(config, () => this.pluginContext().runtime());
 * ```
 *
 * and `computer(config).tools(ctx)` refuses to start without it.
 *
 * Built on the workspace's own filesystem, not on `@cloudflare/computer`'s
 * Think adapter: that one's `glob` and `readDir` read every entry, and its
 * `writeFile` knows nothing of the paths and the states this plugin refuses.
 */

/**
 * The brand {@link isComputerWorkspace} reads. `Symbol.for`, so a second copy
 * of this module in one bundle still recognises the first's workspaces.
 */
const BRAND = Symbol.for("@dynamicagents/plugins/computer:workspace");

type FileInfo = Awaited<ReturnType<WorkspaceLike["glob"]>>[number];

/** Whether `workspace` is one {@link computerWorkspace} built. */
export function isComputerWorkspace(workspace: unknown): boolean {
  return (
    typeof workspace === "object" &&
    workspace !== null &&
    (workspace as Record<symbol, unknown>)[BRAND] === true
  );
}

/**
 * Missing, as the filesystem says it across the boundary. The code does not
 * always survive RPC, so the message is read too.
 */
function isMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "ENOENT") return true;
  return typeof message === "string" && /ENOENT|no such/i.test(message);
}

/** `null` for a path that is not there, which is what Think's tools expect. */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * `stat`, with a missing path answered as `null`.
 *
 * Asked of the stub's own `statOrNull` where it has one, as `pathExists` asks
 * for `exists` (`./read.ts`): Think's `read` stats before it reads, so a
 * missing file is an ordinary answer here, and a `stat` that throws across the
 * boundary leaves the object an unhandled rejection to log for it.
 */
function statOrNull(fs: WorkspaceClient["fs"], path: string) {
  // Called as a method, never through `.call`: on an RPC stub `.call` is read
  // as a remote method.
  const remote = fs as {
    statOrNull?: (p: string) => ReturnType<WorkspaceClient["fs"]["stat"]>;
  };
  if (typeof remote.statOrNull === "function") return remote.statOrNull(path);
  return orNull(fs.stat(path));
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fileInfo(entry: {
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}): FileInfo {
  const type = entry.isDirectory ? "directory" : "file";
  return {
    path: entry.path,
    name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
    type,
    // Generic on purpose: Think's `read` sniffs a generic type from the bytes,
    // and an extension is not evidence of what a file holds.
    mimeType:
      type === "directory" ? "inode/directory" : "application/octet-stream",
    size: entry.size ?? 0,
    createdAt: entry.mtime ?? 0,
    updatedAt: entry.mtime ?? 0
  };
}

/** The directory a glob walks from, and the pattern relative to it. */
function splitGlob(
  pattern: string,
  cwd: string
): { dir: string; rest: string } {
  const absolute = pattern.startsWith("/") ? pattern : `${cwd}/${pattern}`;
  const wildcard = absolute.search(/[*?[{]/);
  const cut =
    wildcard === -1
      ? absolute.lastIndexOf("/")
      : absolute.lastIndexOf("/", wildcard);
  return {
    dir: cut <= 0 ? "/" : absolute.slice(0, cut),
    rest: absolute.slice(cut + 1)
  };
}

/**
 * @param runtime The running sub-agent's `runtime()`, read per call — how a
 *   sub-agent's file tools reach the workspace its parent prepared. A parent's
 *   is `undefined`, and {@link ComputerConfig.workspaceName} names it.
 */
export function computerWorkspace(
  config: ComputerConfig,
  runtime?: () => unknown
): WorkspaceLike {
  const cwd = config.cwd ?? "/workspace";

  // Resolved per call, never memoized: the name belongs to the turn, and a
  // stale one would route this caller's writes into another's files.
  const named = () =>
    workspaceNameFromRuntime(runtime?.()) ?? config.workspaceName();
  const host = (name: string): DurableObjectStub<WorkspaceHost> =>
    config.binding.get(config.binding.idFromName(name));

  /**
   * One call, against the workspace this turn names. Opened without starting a
   * container — see `WorkspaceHost.__getWorkspaceFsStub`.
   */
  const withFs = async <T>(
    path: string,
    verb: string,
    body: (fs: WorkspaceClient["fs"], name: string) => Promise<T>
  ): Promise<T> => {
    const refusal = guardPath(path, verb);
    if (refusal) throw new Error(refusal);
    const name = named();
    using ws = await openWorkspaceFs(host(name));
    return await body(ws.fs, name);
  };

  /**
   * A write, refused while the workspace cannot keep it. Thrown rather than
   * returned: Think's tools report a thrown error to the model, and a write
   * that returned would read as one that landed.
   */
  const withWritableFs = <T>(
    path: string,
    verb: string,
    body: (fs: WorkspaceClient["fs"], name: string) => Promise<T>
  ): Promise<T> =>
    withFs(path, verb, async (fs, name) => {
      // Fails open, for the reason the tools' own write gate does: a read of
      // another Durable Object's state must not take out a working tool.
      const lost = await host(name)
        .advisories()
        .then(writeGate, () => undefined);
      if (lost) throw new Error(lost);
      return body(fs, name);
    });

  const workspace = {
    readFile: (path: string) =>
      // Whole, never truncated: Think's `edit` writes back what it read.
      withFs(path, "read", (fs) => orNull(fs.readFile(path, "utf8"))),

    readFileBytes: (path: string) =>
      withFs(path, "read", async (fs) => {
        const stream = await orNull(fs.readFile(path));
        return stream === null ? null : drain(stream);
      }),

    stat: (path: string) =>
      withFs(path, "read", async (fs) => {
        const stat = await statOrNull(fs, path);
        return stat === null ? null : fileInfo({ ...stat, path });
      }),

    readDir: (dir = cwd, opts?: { limit?: number; offset?: number }) =>
      withFs(dir, "list", async (fs) =>
        (await fs.readdir(dir, opts)).map((entry) =>
          fileInfo({
            ...entry,
            path: dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`
          })
        )
      ),

    // Pruned rather than filtered: at a repository root either skipped
    // directory outnumbers everything else.
    glob: (pattern: string) => {
      const { dir, rest } = splitGlob(pattern, cwd);
      return withFs(dir, "find", async (fs) =>
        (
          await fs.find(dir, rest, {
            exclude: WALK_SKIPS.map((segment) => `**/${segment}`)
          })
        ).map((entry) =>
          fileInfo({ path: entry.path, isDirectory: entry.type === "dir" })
        )
      );
    },

    // Locked per file, so a write never lands inside the `edit` tool's read and
    // write of the same file — see `./file-lock.ts`.
    writeFile: (path: string, content: string) =>
      withWritableFs(path, "write", (fs, name) =>
        withFileLock(name, path, () => fs.writeFile(path, content))
      ),

    mkdir: (path: string, opts?: { recursive?: boolean }) =>
      withWritableFs(path, "write", (fs) => fs.mkdir(path, opts)),

    rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) =>
      withWritableFs(path, "delete", (fs) => fs.rm(path, opts))

    // No `writeFileBytes`. Think writes through it on its own account —
    // evicted media, projected skills — and none of that belongs in a
    // repository's checkout. Without it Think skips both, with a warning.
  };
  Object.defineProperty(workspace, BRAND, { value: true });
  return workspace as WorkspaceLike;
}
