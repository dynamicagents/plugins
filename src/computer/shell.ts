import { shellQuote } from "@cloudflare/computer";

/** How a command reaches the shell, and what its two output streams do there. */

/**
 * The shell wrapper both variants share, minus the choice they differ on.
 *
 * One quoted argument, not string concatenation: the command is model-authored
 * and routinely contains quotes of its own (`git commit -m "…"`), so anything
 * less than `shellQuote` re-parses the model's quoting and mangles it.
 *
 * ## Why `-o pipefail`
 *
 * Without it a pipeline's exit status is its **last** stage's, so
 * `npm run check | tail -100` reports `exit 0` for a gate that failed outright —
 * and models pipe into `tail` constantly. A tool that reports success for a
 * failed build is worse than one that reports nothing. It also costs a re-run
 * every time: a model that cannot trust a piped exit code runs the whole thing
 * again unpiped to get one.
 *
 * The trade is worth stating. `pipefail` surfaces SIGPIPE too, so
 * `ls big-dir | head -1` reports 141 rather than 0 — noisy, but *visible*, where
 * the alternative is a failing gate that looks clean. The tool description tells
 * the model not to pipe into `head`/`tail` at all, since output is already
 * truncated with both ends kept.
 *
 * Requires a shell that implements it — `bash`, `zsh`, `ksh`, not `sh`/dash. A
 * host setting {@link ComputerConfig.shell} is choosing that shell explicitly.
 */
function wrapped(command: string, shell: string): string {
  return `${shell} -o pipefail -c ${shellQuote(command)}`;
}

/**
 * Run a command under {@link ComputerConfig.shell} with its two output streams
 * left as they are, or hand it back untouched when no shell is configured.
 *
 * This is the variant for a caller that **reads the result in code**: `stdout` is
 * a data channel it compares or parses, and `stderr` is a separate diagnostic.
 * {@link computerExec} is that caller, on behalf of `@dynamicagents/plugins/repo`,
 * which asks git questions like `symbolic-ref --short refs/remotes/origin/HEAD`
 * and `rev-list --count` and needs the answer alone.
 *
 * Two functions rather than one with a flag, because the difference is a change
 * to the *output contract* and a boolean hides it at the call site. Merging the
 * streams here would give every `/repo` git command an empty `stderr` and a
 * `stdout` that is a transcript rather than an answer — which fails silently,
 * since the commands `/repo` parses are quiet ones and a single `warning:` is
 * enough to skip the empty-branch guard.
 */
export function withShell(command: string, shell: string | undefined): string {
  return shell ? wrapped(command, shell) : command;
}

/**
 * Run a command under {@link ComputerConfig.shell} with its two output streams
 * merged into one transcript, in the order they were written.
 *
 * This is the variant for a caller whose consumer is **a model reading output**.
 * `sb_exec` is that caller. A project's check is a chain — `wrangler types &&
 * prettier && eslint && tsc` — and *which tool spoke last* is how you know which
 * one failed. A stdout block and a separate stderr block destroy that ordering,
 * and a model that wants it back re-runs the whole gate as
 * `npm run check > /tmp/out 2>&1; cat /tmp/out`. This is that workaround, done
 * once, for free.
 *
 * The redirect binds to the wrapper process, so it applies to everything the
 * command writes however deeply nested — and there is no inner brace group or
 * subshell to mis-parse a command that already contains `&&`, quotes or redirects
 * of its own.
 *
 * With no shell configured there is no wrapper process to redirect, so the
 * command goes to the runtime untouched and the two streams arrive separate.
 * That is not a gap: {@link renderResult} renders them as a labelled
 * `--- stderr ---` block for exactly this case. The transcript is the better
 * answer, not the only supported one.
 */
export function withShellTranscript(
  command: string,
  shell: string | undefined
): string {
  return shell ? `${wrapped(command, shell)} 2>&1` : command;
}
