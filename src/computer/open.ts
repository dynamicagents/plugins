import { getWorkspace } from "@cloudflare/computer";
import type { WorkspaceClient, WorkspaceStub } from "@cloudflare/computer";
import type { WorkspaceAdvisory } from "./advisory.js";

/**
 * Reaching a workspace: which one a call names, and the two ways to open it.
 *
 * A leaf, so both the tools and the proxy in `./proxy.ts` can import it without
 * going through the barrel that re-exports them.
 */

/**
 * Where a parent puts the workspace name so its sub-agents reach the same one.
 *
 * A sub-agent cannot compute this itself. The name is derived from the caller
 * and the repository, and the checkout it should work in is one its parent
 * chose — so a sub-agent that named its own would land beside the parent's
 * checkout, in a workspace with nothing in it.
 *
 * A spec's `prepare` runs on the parent, where the name resolves, and its
 * return value reaches the sub-agent's plugins as `runtime()`. That is the
 * channel core built for exactly this, and it is emphatically *not* the
 * sub-agent's input, which the parent's model writes — a workspace name there
 * would be model-authored, and a model naming another caller's workspace would
 * get that caller's files.
 */
export const WORKSPACE_RUNTIME_KEY = "workspaceName";

/**
 * Read a parent-resolved workspace name off a sub-agent's `runtime()`.
 *
 * Returns `undefined` rather than throwing on anything unexpected: a parent has
 * no runtime at all, and falling back to the configured thunk is right there.
 */
export function workspaceNameFromRuntime(runtime: unknown): string | undefined {
  const value = (runtime as Record<string, unknown> | null | undefined)?.[
    WORKSPACE_RUNTIME_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The Durable Object the workspace lives in, as this plugin needs to see it.
 *
 * Structural rather than imported: the class is the host's — it owns the
 * container binding, the alarm and the install job — and a plugin that imported
 * it would stop a second host from bringing its own. `__getWorkspaceStub` is the
 * one method `getWorkspace()` calls across the boundary, and it is what
 * `withWorkspace` installs (or what a host that constructs `Workspace` itself
 * reimplements, which is the same three lines).
 */
export interface WorkspaceHost extends Rpc.DurableObjectBranded {
  // Typed as `WorkspaceStub` rather than `unknown`, and not for documentation:
  // Workers RPC maps an `unknown` return to `never`, which makes any concrete
  // Durable Object class fail to satisfy this interface.
  __getWorkspaceStub(): Promise<WorkspaceStub>;
  /**
   * The same workspace for filesystem-only work, which the host must serve
   * **without starting a container**.
   *
   * The filesystem is the Durable Object's own SQLite, while the first command
   * in a fresh container waits for the whole tree to be pushed into it — so a
   * file tool served the other way waits minutes for a local `readdir`. See
   * `WorkspaceObjectBase.__getWorkspaceFsStub` in `./host/workspace.ts`.
   *
   * Required rather than optional, for the reason {@link advisories} gives. A
   * host with nothing to distinguish returns its own `__getWorkspaceStub()`.
   */
  __getWorkspaceFsStub(): Promise<WorkspaceStub>;
  /**
   * Everything currently true about the workspace that a caller must not assume
   * away — see {@link file://./advisory.ts}. An empty array is the good case.
   *
   * Required rather than optional, and not only because Workers RPC types an
   * optional method as a union nothing can call. A host with nothing to report
   * returns `[]` in one line; a host that forgot to expose it gets a compile
   * error instead of a `bash` that silently runs against a half-built
   * `node_modules`, or against a workspace whose writes are being dropped.
   *
   * `deriveAdvisories` builds the array from what the host already knows, so
   * implementing this is gathering what the host has rather than writing policy.
   */
  advisories(): Promise<readonly WorkspaceAdvisory[]>;
}

/**
 * Open the workspace behind a Durable Object stub.
 *
 * The cast is unavoidable, and narrow enough to be worth isolating here rather
 * than repeating. `getWorkspace` wants a handle whose `__getWorkspaceStub()`
 * resolves to a `WorkspaceStub` — the concrete class, private fields and all.
 * Across a Durable Object boundary Workers RPC hands back a structural
 * `Stub<WorkspaceStub>`, which forwards every method faithfully but carries none
 * of the class's private brand: runtime-compatible, type-incompatible. This is
 * the only place in the plugin that gap is crossed.
 */
export function openWorkspace(
  host: DurableObjectStub<WorkspaceHost>
): Promise<WorkspaceClient> {
  return getWorkspace(host as unknown as Parameters<typeof getWorkspace>[0]);
}

/**
 * The same workspace, opened for filesystem work alone.
 *
 * `getWorkspace` calls exactly one method on what it is handed, so the host is
 * wrapped in an object answering it from the other side of the seam — see
 * {@link WorkspaceHost.__getWorkspaceFsStub}. Everything past that is identical.
 *
 * **Only the file tools take this.** `bash` and `computerExec` need the
 * container started and its CA installed, so they open it the other way.
 */
export function openWorkspaceFs(
  host: DurableObjectStub<WorkspaceHost>
): Promise<WorkspaceClient> {
  return getWorkspace({
    __getWorkspaceStub: () => host.__getWorkspaceFsStub()
  } as unknown as Parameters<typeof getWorkspace>[0]);
}
