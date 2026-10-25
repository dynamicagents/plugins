import { createExecTool } from "@cloudflare/computer/tools/ai-sdk";
import { tool } from "ai";
import type { ToolSet } from "ai";
import type { CommandHandle, ComputerClient } from "./client.js";
import type { ComputerContext } from "./context.js";
import type { ExecGate } from "./gate.js";
import { withShellTranscript } from "./shell.js";

/** Running one command in the container, on Computer's own `exec` tool. */

/**
 * The one backend this workspace has, and the id the model never has to name.
 *
 * `createExecTool` refuses to build with no backend, and shows a `backend`
 * parameter only when there is more than one. So naming exactly one is what
 * keeps the model's call `{ command }` and nothing else.
 */
const BACKEND = "container";

/** What the model is told the backend is, under Computer's own description. */
const BACKEND_DESCRIPTION =
  "A Linux container whose disk is the checkout, with a package manager and network access.";

/**
 * The container's shell, as Computer's `exec` tool.
 *
 * **The tool is upstream's, and deliberately not wrapped past the advisory
 * gate.** Its schema, its description, its truncation and its result shape are
 * `@cloudflare/computer`'s, so the model sees the same `exec` everywhere that
 * package's tools are installed and this plugin has no second dialect to keep in
 * step. What that costs, each of it accepted rather than overlooked:
 *
 * - **Truncation keeps the tail, not both ends.** Upstream cuts each stream to
 *   its last lines, so a failure printed early in a long build is gone from what
 *   the model reads. The exit code still reports it, and the model's recourse is
 *   a narrower command.
 * - **The description promises a file this workspace does not write.** Upstream
 *   tells the model that truncated output is saved where `read` and `grep` can
 *   open it. That holds for a Workspace whose runtime saves it; this one reports
 *   no saved path, so the reply names none and the sentence is unfulfilled.
 *   Nothing can be set to turn it off: the sentence is built into the generated
 *   description.
 * - **A command stopped at the time limit or cancelled reads as a plain
 *   failure.** Upstream's result has somewhere for an exit code and somewhere
 *   for an error, and nowhere for the difference between a command that outran
 *   its limit, one whose call was cancelled, and one that simply failed.
 *   {@link file://./client.ts CommandResult.status} still carries it for the log
 *   line below, which is the only place it is read.
 *
 * What stays this plugin's, because neither belongs to a tool:
 *
 * - **The advisory gate**, below: a command waits out a running install, is
 *   refused while something transient makes it pointless, and carries a note
 *   about anything permanent. {@link file://./gate.ts ExecGate} is the contract.
 * - **How the container runs a command**, in
 *   {@link file://./sandbox.ts sandboxClient}: the launch-and-cancel handshake,
 *   the time limit, and the shell transcript. A configured shell merges the two
 *   streams onto one of them, so `stderr` arrives empty and the whole transcript
 *   is in `stdout` — see {@link file://./shell.ts withShellTranscript} for why a
 *   model reading output wants that, and why the plugin's context block rather
 *   than the tool description is where the model is told.
 */
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

  const upstream = createExecTool({
    workspace: {
      runtime: {
        /**
         * Computer's tool asks for a command and a working directory; the rest
         * of what a container command needs is this plugin's, and is filled in
         * here rather than left to the model.
         *
         * `output` is not forwarded: the sandbox has no way to cap a command's
         * output at the source, so the ceiling is spent on this side, which is
         * where it was spent before.
         */
        exec: async (command, options) => {
          const client = await workspace();
          // Read once per command. This is the host's thunk, so calling it
          // twice while building one command's options is two chances to
          // disagree.
          const env = definedEnv();
          try {
            const handle = await client.runtime.exec(
              withShellTranscript(command, config.shell),
              {
                cwd: options.cwd ?? cwd,
                encoding: "utf8",
                timeoutMs,
                ...(env ? { env } : {})
              }
            );
            return held(handle, client, command);
          } catch (err) {
            client[Symbol.dispose]();
            throw err;
          }
        },
        backends: () => [
          {
            id: BACKEND,
            protocol: "command",
            callable: false,
            description: BACKEND_DESCRIPTION
          }
        ]
      }
    },
    // Characters, spent as bytes: upstream's ceiling is in bytes and there is
    // no character form of it. The two coincide until the output is not ASCII,
    // where the model is shown a little less than the host asked for.
    // `maxLines` is left to upstream's own default.
    maxBytes: maxChars
  });

  return {
    exec: tool({
      description: upstream.description,
      inputSchema: upstream.inputSchema,
      execute: async function* (input, options) {
        const command = input.command;
        const startedAtMs = Date.now();

        // Only the shell waits on an install. The file tools read and write
        // source, which is in the workspace and unaffected by an install in
        // flight — blocking them would stop the agent doing the reading it
        // could usefully do while it waits. They do consult `writeGate`, which
        // is a different question: not "is the tree ready" but "does a write
        // survive at all".
        let gate: ExecGate;
        try {
          gate = await awaitAdvisories(command, options.abortSignal);
        } catch (err) {
          // Only a cancel gets out of the gate; a failed advisory read opens it.
          if (options.abortSignal?.aborted) {
            yield {
              command,
              cwd: input.cwd ?? null,
              backend: BACKEND,
              error:
                "the command was stopped because this call was cancelled before it ran."
            };
            return;
          }
          throw err;
        }
        const gateMs = Date.now() - startedAtMs;
        if (gate.block !== undefined) {
          console.info("[computer] exec blocked by a workspace advisory", {
            command,
            gateMs
          });
          yield {
            command,
            cwd: input.cwd ?? null,
            backend: BACKEND,
            error: gate.block
          };
          return;
        }
        /**
         * The one check kept in front of upstream's tool, and the reason is not
         * reporting.
         *
         * Computer's executor launches the command and only then reads the
         * signal, so a call already given up on would start `rm -rf build` in
         * the container and kill it a moment later. Nothing downstream can
         * undo that, so it is refused here instead.
         */
        if (options.abortSignal?.aborted) {
          yield {
            command,
            cwd: input.cwd ?? null,
            backend: BACKEND,
            error:
              "the command did not run: this call was cancelled before it started."
          };
          return;
        }

        // One line per command, and the only view of where a task's wall clock
        // goes: everything on the Worker side of a container command is an
        // `await`, so Workers Observability records the invocation at ~0% CPU
        // and a long wall time and cannot say what ran. Split, since an agent
        // blocked waiting for `npm ci` and one running a slow suite are
        // indistinguishable from outside and want opposite fixes.
        let last: unknown;
        for await (const part of parts(upstream.execute, input, options)) {
          last = part;
          yield gate.warn === undefined ? part : noted(part, gate.warn);
        }
        console.info("[computer] exec", {
          command,
          gateMs,
          durationMs: Date.now() - startedAtMs - gateMs,
          timeoutMs,
          ...summary(last)
        });
      }
    })
  };
}

/**
 * The handle, holding its workspace open until the command settles.
 *
 * Nothing upstream disposes a handle, so the client it came from is released
 * here instead, when `result()` has answered or the handle is disposed, and
 * never on the kill in between. A `/sandbox` client holds nothing and its
 * disposal is a no-op, but the type a host implements says `Disposable`, so one
 * that does hold something is released exactly once and not before the command's
 * own result has been read.
 *
 * It is also the one place the difference between a command that was stopped and
 * one that merely failed is still visible. Upstream's result has nowhere to put
 * it, so it goes to the log rather than to the model.
 */
function held(
  handle: CommandHandle,
  client: ComputerClient,
  command: string
): CommandHandle {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    client[Symbol.dispose]();
  };
  return {
    async result() {
      try {
        const result = await handle.result();
        if (result.status !== undefined && result.status !== "completed")
          console.info("[computer] exec stopped", {
            command,
            status: result.status,
            exitCode: result.exitCode
          });
        return result;
      } finally {
        release();
      }
    },
    /**
     * A kill does not release the client, and that ordering is the point: the
     * caller reads `result()` straight after killing, so releasing here would
     * hand the rest of the command's own result a client somebody had already
     * disposed.
     */
    async kill(signal) {
      await handle.kill(signal);
    },
    [Symbol.dispose]() {
      handle[Symbol.dispose]();
      release();
    }
  };
}

/**
 * Whatever the wrapped executor produces, as something to iterate.
 *
 * Upstream's is an async generator that yields a snapshot while the command
 * runs, and the AI SDK's tool type also admits one value awaited once. Both are
 * handled here rather than asserted, so an upstream that stops streaming keeps
 * working and the gate above keeps wrapping it.
 */
async function* parts<I, O>(
  execute: ((input: I, options: O) => unknown) | undefined,
  input: I,
  options: O
): AsyncGenerator<unknown> {
  if (execute === undefined)
    throw new Error("@cloudflare/computer's exec tool has no executor");
  const produced = await execute(input, options);
  if (
    produced !== null &&
    typeof produced === "object" &&
    Symbol.asyncIterator in produced
  ) {
    yield* produced as AsyncIterable<unknown>;
    return;
  }
  yield produced;
}

/** What a finished `exec` tells the log, whichever shape it came back in. */
function summary(part: unknown): Record<string, unknown> {
  if (part === null || typeof part !== "object") return {};
  if ("error" in part) return { error: String(part.error) };
  return "exitCode" in part ? { exitCode: part.exitCode } : {};
}

/**
 * The gate's note, prepended to what the command said, which is the contract
 * {@link file://./gate.ts ExecGate} states for `warn`.
 *
 * It goes on `stdout`, or on `error` when the command did not produce either:
 * the note is context for whatever happened, not a substitute for it, so it
 * cannot be the only thing the model gets back.
 */
function noted(part: unknown, warn: string): unknown {
  if (part === null || typeof part !== "object") return part;
  if ("stdout" in part && typeof part.stdout === "string") {
    return { ...part, stdout: `${warn}\n\n${part.stdout}` };
  }
  if ("error" in part && typeof part.error === "string") {
    return { ...part, error: `${warn}\n\n${part.error}` };
  }
  return part;
}
