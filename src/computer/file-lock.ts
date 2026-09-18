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

export async function withFileLock<T>(
  key: string,
  body: () => Promise<T>
): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(body);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
