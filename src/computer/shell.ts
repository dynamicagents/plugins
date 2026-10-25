import { shellQuote } from "../sandbox/agent-exec.js";

/**
 * Run a command under {@link file://./index.ts ComputerToolsConfig.shell} with its
 * two output streams merged into one transcript, in the order they were
 * written, or hand it back untouched when no shell is configured.
 *
 * The shell tool's consumer is **a model reading output**. A project's check is a
 * chain
 * — `wrangler types && prettier && eslint && tsc` — and *which tool spoke last*
 * is how you know which one failed. A stdout block and a separate stderr block
 * destroy that ordering, and a model that wants it back re-runs the whole gate
 * as `npm run check > /tmp/out 2>&1; cat /tmp/out`. This is that workaround,
 * done once, for free.
 *
 * One quoted argument, not string concatenation: the command is model-authored
 * and routinely contains quotes of its own (`git commit -m "…"`), so anything
 * less than `shellQuote` re-parses the model's quoting and mangles it. The
 * redirect binds to the wrapper process, so it applies to everything the
 * command writes however deeply nested.
 *
 * ## Why `-o pipefail`
 *
 * Without it a pipeline's exit status is its **last** stage's, so
 * `npm run check | tail -100` reports `exit 0` for a gate that failed outright —
 * and models pipe into `tail` constantly. A tool that reports success for a
 * failed build is worse than one that reports nothing.
 *
 * The trade is worth stating. `pipefail` surfaces SIGPIPE too, so
 * `ls big-dir | head -1` reports 141 rather than 0 — noisy, but *visible*. The
 * tool's description is Computer's and says nothing about either, so the
 * plugin's own context block in {@link file://./index.ts} is where the model is
 * told not to pipe into `head`/`tail`. It needs a shell that implements it —
 * `bash`, `zsh`, `ksh`, not `sh`/dash.
 *
 * With no shell configured the two streams arrive separate, and the tool reports
 * them as the `stdout` and `stderr` of its result.
 */
export function withShellTranscript(
  command: string,
  shell: string | undefined
): string {
  return shell
    ? `${shell} -o pipefail -c ${shellQuote(command)} 2>&1`
    : command;
}
