/**
 * One mutation per file at a time, across every tool set in this isolate.
 *
 * `sb_edit` reads, replaces and writes back over RPC, and the AI SDK runs one
 * step's tool calls concurrently — so two edits to one file would both report
 * success and the first would be lost. Module-level because a parent and a
 * subagent can hold separate tool sets over one workspace; another isolate is
 * out of reach.
 */
const tails = new Map<string, Promise<unknown>>();

/**
 * `path` is canonicalised the way the filesystem resolves it, so spellings with
 * `.`, `..` or doubled slashes share one lock.
 */
export async function withFileLock<T>(
  scope: string,
  path: string,
  body: () => Promise<T>
): Promise<T> {
  const key = `${scope}\0${canonical(path)}`;
  const run = (tails.get(key) ?? Promise.resolve()).then(body);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function canonical(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}
