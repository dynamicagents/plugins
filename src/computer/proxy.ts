import type { ThinkWorkspace } from "@cloudflare/think";
import type { SandboxAdvisory } from "../sandbox/advisory.js";
import type { ComputerClient } from "./client.js";
import { withFileLock } from "./file-lock.js";
import { writeGate } from "./gate.js";
import { guardPath, walkSkips } from "./paths.js";

/**
 * The container's checkout, as the agent's own `this.workspace`.
 *
 * Think's `read`, `write`, `edit` and `delete` run against whatever an agent's
 * workspace is, and the computer tools replace only the ones they name. So an
 * agent with a container and Think's default workspace would run `exec` in the
 * container and `write` in its own SQLite, and nothing would say so. An agent
 * that installs the tools sets its workspace to `computerWorkspace`
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
  advisories(name: string): Promise<readonly SandboxAdvisory[]>;
}

/**
 * The key the route is carried under. `Symbol.for`, so a second copy of this
 * module in one bundle still recognises the first's workspaces.
 */
const ROUTE = Symbol.for("@dynamicagents/plugins/computer:workspace");

/**
 * The filesystem Think reads and writes through. It is Computer's own
 * `Workspace["fs"]`, narrowed to the methods Think uses, so this package's
 * `ComputerFs` (`./client.ts`) is the same surface by construction and the
 * adapters below only add the route, the guard, the gate and the lock.
 */
type ThinkFs = ThinkWorkspace["fs"];

/** The route of a workspace {@link routedWorkspace} built, or `undefined`. */
export function workspaceRoute(workspace: unknown): WorkspaceRoute | undefined {
  if (typeof workspace !== "object" || workspace === null) return undefined;
  return (workspace as Record<symbol, WorkspaceRoute | undefined>)[ROUTE];
}

/** The bytes of a stream, for a host RPC that takes a value rather than one. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Think's file tools over `route`, carrying it for the computer tools to find. */
export function routedWorkspace(
  route: WorkspaceRoute,
  cwd: string
): ThinkWorkspace {
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

  /**
   * Read whole or ranged, and as text or as bytes, in the one overloaded
   * method Computer's filesystem declares. The options go through untouched:
   * an `edit` reads text and writes back what it read, and a `read` of an
   * evicted image asks for the bytes.
   *
   * **A host's `readFile` has to materialise what it answers**, because the
   * client is released when this call returns and a stream that outlived it
   * would be read against a disposed one. `/sandbox`'s does: it awaits the
   * bytes and hands back a stream over them.
   */
  const readFile = (path: string, options?: unknown) =>
    withFs(path, "read", (fs) =>
      options === undefined
        ? fs.readFile(path)
        : (fs.readFile as (p: string, o: unknown) => Promise<unknown>)(
            path,
            options
          )
    );

  const fs = {
    readFile: readFile as ThinkFs["readFile"],

    stat: (path: string) =>
      withFs(path, "read", async (fs) => ({
        ...(await fs.stat(path)),
        // The container has one, and the sandbox does not report it. Nothing
        // downstream reads it: Computer's tools take `size`, `mtime`, `mode`
        // and the three kind flags, and a number is all the type needs.
        inode: 0
      })),

    readdir: (path: string, options?: { limit?: number; offset?: number }) =>
      withFs(path, "list", async (fs) =>
        (await fs.readdir(path, options)).map((entry) => ({
          ...entry,
          // The directory this listing was read from, which is what a caller
          // joins a name onto. The sandbox lists names and kinds, so the size
          // and the time are the entry's own where it has them and zero where
          // it does not: `ls` shows both to the model, and a second round trip
          // per entry to fill them in would cost a directory's worth of RPCs.
          parentPath: path,
          size: entry.size ?? 0,
          mtime: entry.mtime ?? 0,
          isSymbolicLink: entry.isSymbolicLink ?? false
        }))
      ),

    // Pruned rather than filtered: at a repository root either skipped
    // directory outnumbers everything else. No limit of this layer's own —
    // `./sandbox.ts` caps a walk that arrives without one.
    find: (
      directory: string,
      pattern?: string,
      options?: { limit?: number; offset?: number; exclude?: string[] }
    ) =>
      withFs(directory, "find", (fs) =>
        fs.find(directory, pattern, {
          ...options,
          exclude: [...walkSkips(directory, cwd), ...(options?.exclude ?? [])]
        })
      ),

    grep: (pattern: string, path: string, options?: object) =>
      withFs(path, "search", (fs) =>
        fs.grep(pattern, path, {
          ...options,
          exclude: [
            ...walkSkips(path, cwd),
            ...((options as { exclude?: string[] } | undefined)?.exclude ?? [])
          ]
        })
      ),

    /**
     * Locked per file, so a write never lands inside the `edit` tool's read and
     * write of the same file — see `./file-lock.ts`.
     *
     * A stream is drained here because the sandbox RPC takes a value. The
     * `mode` a caller may send is dropped: the sandbox's write has nowhere to
     * put one, so a mode this cannot set is not one it can claim to preserve.
     */
    writeFile: (
      path: string,
      content: string | Uint8Array | ReadableStream<Uint8Array>
    ) =>
      withWritableFs(path, "write", async (fs, name) => {
        const body =
          content instanceof ReadableStream ? await drain(content) : content;
        return withFileLock(name, path, () => fs.writeFile(path, body));
      }),

    mkdir: (path: string, options?: { recursive?: boolean }) =>
      withWritableFs(path, "write", (fs) => fs.mkdir(path, options)),

    // Locked too: a delete landing between an edit's read and its write would
    // be undone by the write, and both would report success.
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) =>
      withWritableFs(path, "delete", (fs, name) =>
        withFileLock(name, path, () => fs.rm(path, options))
      )
  };

  /**
   * `fs` alone. Computer's exec tool is offered only for a workspace carrying a
   * `runtime`, so withholding one is how this keeps Think from building a
   * second shell over the same container — `./tools-exec.ts` is the one the
   * model gets, and it is this package's.
   */
  const workspace = { fs };
  Object.defineProperty(workspace, ROUTE, { value: route });
  return workspace as ThinkWorkspace;
}
