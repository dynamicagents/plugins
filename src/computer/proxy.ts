import type { WorkspaceLike } from "@cloudflare/think";
import type { WorkspaceAdvisory } from "../sandbox/advisory.js";
import type { ComputerClient } from "./client.js";
import { withFileLock } from "./file-lock.js";
import { writeGate } from "./gate.js";
import { guardPath, WALK_SKIPS } from "./paths.js";

/**
 * The container's checkout, as the agent's own `this.workspace`.
 *
 * Think's `read`, `write`, `edit` and `delete` run against whatever an agent's
 * workspace is, and the computer tools replace only the ones they name. So an
 * agent with a container and Think's default workspace would run `bash` in the
 * container and `write` in its own SQLite, and nothing would say so. An agent
 * that installs the tools sets its workspace to `sandboxWorkspace`
 * (`./sandbox.ts`), and the plugin refuses to start without it — and reaches
 * the container through it, so the tools and Think's file tools cannot resolve
 * two different ones.
 */

/**
 * Where a workspace sends each call, carried on it under {@link ROUTE}. The
 * tools route through this rather than through their own config, which is
 * what makes a workspace built from another config, or without its runtime, a
 * wrong workspace for both rather than a split.
 */
export interface WorkspaceRoute {
  /** The sandbox the running turn names. Read per call. */
  name(): string;
  open(name: string): Promise<ComputerClient>;
  advisories(name: string): Promise<readonly WorkspaceAdvisory[]>;
}

/**
 * The key the route is carried under. `Symbol.for`, so a second copy of this
 * module in one bundle still recognises the first's workspaces.
 */
const ROUTE = Symbol.for("@dynamicagents/plugins/computer:workspace");

type FileInfo = Awaited<ReturnType<WorkspaceLike["glob"]>>[number];

/**
 * The most one `glob` returns. Its caller is Think's `find`, which shows 200
 * and says when there were more — so one past that is all it can use, and
 * reading the rest of a large checkout into the object would buy nothing.
 */
const GLOB_LIMIT = 201;

/** The route of a workspace {@link routedWorkspace} built, or `undefined`. */
export function workspaceRoute(workspace: unknown): WorkspaceRoute | undefined {
  if (typeof workspace !== "object" || workspace === null) return undefined;
  return (workspace as Record<symbol, WorkspaceRoute | undefined>)[ROUTE];
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

/** Think's file tools over `route`, carrying it for the computer tools to find. */
export function routedWorkspace(
  route: WorkspaceRoute,
  cwd: string
): WorkspaceLike {
  /** One call, against the workspace this turn names. */
  const withFs = async <T>(
    path: string,
    verb: string,
    body: (fs: ComputerClient["fs"], name: string) => Promise<T>
  ): Promise<T> => {
    const refusal = guardPath(path, verb);
    if (refusal) throw new Error(refusal);
    const name = route.name();
    using ws = await route.open(name);
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
    body: (fs: ComputerClient["fs"], name: string) => Promise<T>
  ): Promise<T> =>
    withFs(path, verb, async (fs, name) => {
      // Fails open, for the reason the tools' own write gate does: a read of
      // another Durable Object's state must not take out a working tool.
      const lost = await route
        .advisories(name)
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
        const stat = await orNull(fs.stat(path));
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
            limit: GLOB_LIMIT,
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

    // Locked too: a delete landing between an edit's read and its write would
    // be undone by the write, and both would report success.
    rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) =>
      withWritableFs(path, "delete", (fs, name) =>
        withFileLock(name, path, () => fs.rm(path, opts))
      )

    // No `writeFileBytes`. Think writes through it on its own account —
    // evicted media, projected skills — and none of that belongs in a
    // repository's checkout. Without it Think skips both, with a warning.
  };
  Object.defineProperty(workspace, ROUTE, { value: route });
  return workspace as WorkspaceLike;
}
