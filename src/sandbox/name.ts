/**
 * Which sandbox a caller reaches: its name, and how a parent hands it to a
 * sub-agent.
 *
 * One sandbox is one container is one repository, so a caller's sandboxes are
 * keyed on the repository it works in. A module of its own, with no imports,
 * because every path into a sandbox — a plugin's tools, a host's shell, a
 * sub-agent's `prepare` — must spell it the same way.
 */

/**
 * The Durable Object name for one caller's sandbox for one repository.
 *
 * A pipe rather than a slash, so the caller half cannot forge a repository
 * boundary by containing one. `repo` may be a sentinel rather than a
 * repository — a scratchpad, a worktree — as long as no caller could clone
 * something that collides with it. Undefined is the window before a task has
 * chosen one, which resolves to a caller-level sandbox nothing works in.
 */
export function sandboxName(callerKey: string, repo?: string): string {
  return repo ? `${callerKey}|${repo}` : `${callerKey}|<unassigned>`;
}

/** The key a parent's `prepare` puts a sub-agent's sandbox name under, in its `runtime()`. */
export const SANDBOX_RUNTIME_KEY = "sandboxName";

/**
 * A parent-resolved sandbox name, read off a sub-agent's `runtime()`.
 * `undefined` for anything else: a parent has no runtime, and falls back to its
 * own name.
 */
export function sandboxNameFromRuntime(runtime: unknown): string | undefined {
  const value = (runtime as Record<string, unknown> | null | undefined)?.[
    SANDBOX_RUNTIME_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
