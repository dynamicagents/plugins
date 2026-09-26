import type { WorkspaceClient } from "@cloudflare/computer";

/**
 * Does this path exist?
 *
 * `getWorkspace()` types `fs` as the in-process `WorkspaceFilesystem`, but the
 * value on the far side of a Durable Object boundary is a
 * `WorkspaceFilesystemStub`, which carries a few methods the local class does
 * not — `exists` among them. So the fast path is asked for rather than cast to,
 * and `stat` is the fallback for a host that hands back a local workspace.
 *
 * The fallback treats *any* `stat` failure as absence, which is the honest
 * reading for a tool whose entire answer is a boolean: there is no error channel
 * to distinguish "missing" from "unreadable", and the caller's next move — look
 * somewhere else — is the same either way.
 */
export async function pathExists(
  fs: WorkspaceClient["fs"],
  path: string
): Promise<boolean> {
  // Called as a method, never through `.call`: on an RPC stub `.call` is read as
  // a remote method, and the stub it would pass as `this` cannot be serialised.
  const remote = fs as { exists?: (p: string) => Promise<boolean> };
  if (typeof remote.exists === "function") return remote.exists(path);
  return fs.stat(path).then(
    () => true,
    () => false
  );
}
