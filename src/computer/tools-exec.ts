import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { withAbort } from "@dynamicagents/core";
import { renderResult } from "./render.js";
import { execLostNote, type ExecGate } from "./gate.js";
import { withShellTranscript } from "./shell.js";
import type { ComputerContext } from "./context.js";

/** Running one command in the container. */

/**
 * Wait for a disposable resource without outliving `signal`.
 *
 * `withAbort` can abandon the wait but not the resource, and one that arrives
 * after its caller has given up has nobody left to dispose it. So it is released
 * on arrival instead — disposed by default, or handed to `release` where
 * disposing alone would leave work running.
 */
function acquire<R extends Disposable>(
  signal: AbortSignal | undefined,
  opening: Promise<R>,
  release: (resource: R) => unknown = (resource) => resource[Symbol.dispose]()
): Promise<R> {
  return withAbort(signal, opening, () => {
    void opening.then(release).catch(() => {});
  });
}

/**
 * How an exec handle that arrived too late is released. Disposing only detaches
 * this side, so the process is killed first.
 */
async function killLate(handle: {
  kill(signal?: "SIGTERM"): Promise<void>;
  [Symbol.dispose](): void;
}): Promise<void> {
  try {
    await handle.kill("SIGTERM");
  } finally {
    handle[Symbol.dispose]();
  }
}

export function execTools(ctx: ComputerContext): ToolSet {
  const {
    config,
    cwd,
    timeoutMs,
    maxChars,
    workspace,
    awaitAdvisories,
    definedEnv
  } = ctx;

  return {
    sb_exec: tool({
      /**
       * States what the tool guarantees, rather than what it might withhold.
       *
       * A description that leads with "output is truncated if it is large" and
       * gives no exit code hands the model two independent reasons to re-run a
       * command and capture the output "properly" — at 60 seconds a go on a real
       * gate, whose few hundred characters were never near the ceiling anyway.
       *
       * Two of these sentences are only true when a shell is configured, so the
       * description says whichever is. `withShellTranscript` is a no-op without
       * {@link ComputerConfig.shell}: no `2>&1`, so the streams arrive separate
       * and {@link renderResult} labels them; no `-o pipefail`, so `/bin/sh`
       * reports a pipeline's *last* stage. Promising a transcript and
       * first-failure semantics there would be the lie `wrapped` explains the
       * cost of.
       */
      description:
        "Run a shell command in the container and return its output. Use this for builds, tests, package installs, git, and anything else a terminal can do. " +
        (config.shell
          ? "The result is the command's full transcript — stdout and stderr interleaved in the order they were written — followed by a line reporting the exit code, e.g. `--- exit 0 ---`. A command killed at the time limit says so on that line. " +
            "You do not need to append `echo $?`, add `2>&1`, or redirect to a file to see any of this. " +
            "Do not pipe into `head` or `tail` to shorten output: long output is already truncated from the middle, keeping the beginning and the end, and piping costs you the parts you wanted. Pipelines report the first failing stage, so a piped command reports its real failure rather than the pipe's — but `cmd | head` may report 141 when `head` closes the pipe early, which is not a failure of `cmd`. "
          : "The result is the command's stdout, then any stderr under a `--- stderr ---` heading, then a line reporting the exit code, e.g. `--- exit 0 ---`. A command killed at the time limit says so on that line. " +
            "You do not need to append `echo $?` to see the exit code. Add `2>&1` yourself if you need the two streams in the order they were written. " +
            "Do not pipe into `head` or `tail` to shorten output: long output is already truncated from the middle, keeping the beginning and the end, and piping costs you the parts you wanted. A pipeline reports its **last** stage, so check the exit code of the command you care about rather than the pipe's. ") +
        "Prefer targeted commands over ones that print everything.",
      inputSchema: z.object({
        command: z.string().describe("The shell command, e.g. 'npm test'"),
        cwd: z
          .string()
          .optional()
          .describe(`Working directory (default: ${cwd})`)
      }),
      execute: async ({ command, cwd: overrideCwd }, { abortSignal }) => {
        /**
         * One line per command, and it is the only view of where a task's wall
         * clock actually goes.
         *
         * Everything on the Worker side of a container command is an `await`, so
         * Workers Observability records the invocation at ~0% CPU and a long wall
         * time and cannot say what ran. Without this line, diagnosing a 59-minute
         * task means inferring the shape of each command from the *gaps between
         * AI Gateway calls*. The three numbers below — how long the install gate
         * held, how long the command took, what it exited with — answer it
         * directly.
         *
         * Timed around the gate as well as the command, since a subagent blocked
         * waiting for `npm ci` and one running a slow test suite are
         * indistinguishable from the outside and want opposite fixes.
         */
        const startedAtMs = Date.now();

        /**
         * What the model is told when this call stops before the command
         * finishes. Said plainly, because the likeliest next move after a bare
         * error is the same command again — and whether that is right depends on
         * where the call stopped. A command that outran the limit once will again;
         * one that never started because the workspace did not answer may not.
         *
         * `sb_exec` reads its call's signal rather than leaving the wait to core,
         * and this is why: core's abandonment can say only that the command may
         * still be running. Core's `TOOL_CALL_GRACE_MS` is the window this answer
         * has to arrive in, and it covers sending the kill below.
         */
        const stopped = (gateMs: number, started: boolean): string => {
          const timedOut =
            (abortSignal?.reason as { name?: string } | undefined)?.name ===
            "TimeoutError";
          console.info("[computer] sb_exec stopped", {
            command,
            gateMs,
            durationMs: Date.now() - startedAtMs - gateMs,
            started,
            reason: timedOut ? "time limit" : "cancelled"
          });
          if (!timedOut)
            return "the command was stopped because this call was cancelled. Anything it changed before then is still changed.";
          return started
            ? "the command was stopped: it ran past this call's time limit. Anything it changed before then is still changed. Try something narrower."
            : "the command did not run: this call reached its time limit while the workspace was still getting ready, so nothing was changed. Try again; if it happens again, the workspace is not responding.";
        };

        // Only `sb_exec` waits on an install. The file tools read and write
        // source, which is in the workspace and unaffected by an install in
        // flight — blocking them would stop the subagent doing the reading it
        // could usefully do while it waits. They do consult `writeGate`, which
        // is a different question: not "is the tree ready" but "does a write
        // survive at all".
        let gate: ExecGate;
        try {
          gate = await awaitAdvisories(command, abortSignal);
        } catch (err) {
          // Only a cancel gets out of the gate; a failed advisory read opens it.
          if (abortSignal?.aborted)
            return stopped(Date.now() - startedAtMs, false);
          throw err;
        }
        const gateMsWaited = Date.now() - startedAtMs;
        if (gate.block) {
          console.info("[computer] sb_exec blocked by a workspace advisory", {
            command,
            gateMs: gateMsWaited
          });
          return gate.block;
        }
        // Prepended to whatever happens next, success or failure. The warning
        // is context for the output, not a substitute for it — which is why it
        // is carried through the catch as well.
        const note = (body: string) =>
          gate.warn ? `${gate.warn}\n\n${body}` : body;
        // Set once the exec is sent. See `stopped`.
        let started = false;

        try {
          // A workspace that stops answering would hold the call before any of the
          // cancellation below is reached.
          abortSignal?.throwIfAborted();
          using ws = await acquire(abortSignal, workspace());
          // Read once per command. This is the *host's* thunk, so calling it
          // twice in the construction of one command's options is two chances to
          // disagree — the check and the value would come from different reads.
          const commandEnv = definedEnv();
          const options = {
            cwd: overrideCwd ?? cwd,
            encoding: "utf8" as const,
            timeoutMs,
            ...(commandEnv ? { env: commandEnv } : {})
          };
          // Transcript, not two streams: this result goes to a model, which
          // reads it as a terminal session rather than parsing it.
          // Not started at all on a signal that has already fired: a process that
          // is killed on the next line still ran long enough to change something.
          abortSignal?.throwIfAborted();
          // From here a stop cannot promise nothing ran: the exec may reach the
          // container before its handle reaches this side.
          started = true;
          using handle = await acquire(
            abortSignal,
            ws.runtime.exec(
              withShellTranscript(command, config.shell),
              options
            ),
            killLate
          );
          // The runtime takes no signal, so stopping the wait and stopping the
          // process are two acts. Disposing the handle is neither — it releases
          // this side's attachment and leaves the command running.
          const result = await withAbort(abortSignal, handle.result(), () =>
            handle.kill("SIGTERM")
          );
          console.info("[computer] sb_exec", {
            command,
            exitCode: result.exitCode,
            // Split so a slow command and a slow *wait* never look alike.
            gateMs: gateMsWaited,
            durationMs: Date.now() - startedAtMs - gateMsWaited,
            // The ceiling this was measured against — a duration sitting on it is
            // a timeout wearing a normal-looking number.
            timeoutMs
          });
          return note(renderResult(result, maxChars));
        } catch (err) {
          if (abortSignal?.aborted) return note(stopped(gateMsWaited, started));
          const lost = execLostNote(err);
          console.warn("[computer] sb_exec failed", {
            command,
            gateMs: gateMsWaited,
            durationMs: Date.now() - startedAtMs - gateMsWaited,
            timeoutMs,
            // Distinguished in the log for the same reason it is distinguished
            // for the model: a container replacement and a broken command want
            // different people looking at them.
            ...(lost ? { lost: true } : {}),
            err: String(err)
          });
          // Returned, not thrown: a failed command is usually the model's to
          // recover from, and it can only recover from what it is told.
          return note(lost ?? `error running command: ${String(err)}`);
        }
      }
    })
  };
}
