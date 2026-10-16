/**
 * The run header: how a host tells the daemon how to launch one run.
 *
 * `ContainerHarness` takes its adapter options once, for every session it holds,
 * and its adapters run every turn in one fixed working directory. A sandbox runs
 * a planner, a writer and a reviser in the same object, each in its own
 * checkout and under its own permission mode, so neither is enough. The
 * harness passes a prompt through untouched, so the run's own settings travel
 * as the prompt's first line, and the daemon takes that line off before the CLI
 * reads its stdin.
 *
 * Parsed on both sides from this one module, so the spelling cannot drift.
 */

/** The first characters of a prompt that carries a header. */
export const RUN_HEADER_PREFIX = "@@da ";

/** Where every run's working directory must sit. */
export const SANDBOX_ROOT = "/workspace";

export interface RunHeader {
  /** The checkout the run works in. Fixed for a session's life: the CLI files a transcript by directory. */
  cwd: string;
  /** `plan` runs read-only and answers to {@link schema}. */
  mode?: "plan" | "build";
  /** A schema the daemon was built with, by name. Not the schema itself: a prompt is stored. */
  schema?: string;
  /** The CLI's effort level, passed through. */
  effort?: string;
  /** Continue the session's conversation as a new branch of it. */
  fork?: boolean;
  /** The CLI's model, when the run needs one other than the session's. */
  model?: string;
}

/** A header the daemon cannot honour, refused rather than run with defaults. */
export class RunHeaderError extends Error {
  override readonly name = "RunHeaderError";
}

/** `prompt` with `header` as its first line. */
export function withRunHeader(header: RunHeader, prompt: string): string {
  assertRunHeader(header);
  return `${RUN_HEADER_PREFIX}${JSON.stringify(header)}\n${prompt}`;
}

/**
 * The header and the prompt beneath it. A prompt with no header line is
 * returned whole with `header: undefined`: control prompts and a session's own
 * follow-ups carry none.
 *
 * @throws {RunHeaderError} the first line claims to be a header and is not one.
 */
export function readRunHeader(text: string): {
  header: RunHeader | undefined;
  prompt: string;
} {
  if (!text.startsWith(RUN_HEADER_PREFIX))
    return { header: undefined, prompt: text };
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  const prompt = end === -1 ? "" : text.slice(end + 1);
  let value: unknown;
  try {
    value = JSON.parse(line.slice(RUN_HEADER_PREFIX.length));
  } catch {
    throw new RunHeaderError(
      `the run header is not JSON: ${line.slice(0, 120)}`
    );
  }
  assertRunHeader(value);
  return { header: value, prompt };
}

function assertRunHeader(value: unknown): asserts value is RunHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunHeaderError("the run header must be an object");
  }
  const header = value as Record<string, unknown>;
  const cwd = header.cwd;
  if (typeof cwd !== "string" || !isUnder(cwd, SANDBOX_ROOT)) {
    throw new RunHeaderError(
      `the run header's cwd must be an absolute path under ${SANDBOX_ROOT}, got ${JSON.stringify(cwd)}`
    );
  }
  if (
    header.mode !== undefined &&
    header.mode !== "plan" &&
    header.mode !== "build"
  ) {
    throw new RunHeaderError(`unknown run mode ${JSON.stringify(header.mode)}`);
  }
  for (const key of ["schema", "effort", "model"] as const) {
    if (header[key] !== undefined && typeof header[key] !== "string") {
      throw new RunHeaderError(`the run header's ${key} must be a string`);
    }
  }
  if (header.fork !== undefined && typeof header.fork !== "boolean") {
    throw new RunHeaderError("the run header's fork must be a boolean");
  }
  if (header.mode === "plan" && header.schema === undefined) {
    throw new RunHeaderError("a plan run names the schema its answer follows");
  }
}

/** Whether `path` is `root` or inside it, with no `..` escaping it. */
export function isUnder(path: string, root: string): boolean {
  if (!path.startsWith("/")) return false;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return false;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normal = `/${parts.join("/")}`;
  return normal === root || normal.startsWith(`${root}/`);
}
