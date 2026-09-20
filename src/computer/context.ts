import { withAbort } from "@dynamicagents/core";
import type { WorkspaceClient } from "@cloudflare/computer";
import { execGate, writeGate, type ExecGate } from "./gate.js";
import type { WorkspaceAdvisory } from "./advisory.js";
import type { ComputerConfig } from "./index.js";

/**
 * The machinery every container tool closes over: the resolved config, the
 * advisory gates, and the workspace opener the file tools share.
 */

/**
 * How much command output the model is allowed to see, in characters.
 *
 * One `npm install` prints more than a small context window holds, and the
 * interesting part of a failing build is the first error and the last summary —
 * never the middle. So output is truncated from the middle rather than the end,
 * which is what a naive `slice` would do and would drop the exit summary that
 * says what actually failed.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

/** A command that has not finished in this long is a hung command. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Where checkouts live, in the container and in the workspace alike. */
export const DEFAULT_CWD = "/workspace";

/**
 * How often the install gate re-reads the install's status.
 *
 * An interval rather than a subscription because the status lives in another
 * Durable Object with no event to wait on. Never slept past the gate itself —
 * see `awaitAdvisories` in {@link computerContext}.
 */
const INSTALL_POLL_MS = 3_000;

/** What {@link computerContext} hands each group of tools. */
export interface ComputerContext {
  config: ComputerConfig;
  cwd: string;
  timeoutMs: number;
  maxChars: number;
  workspace: () => Promise<WorkspaceClient>;
  awaitAdvisories: (command: string, signal?: AbortSignal) => Promise<ExecGate>;
  definedEnv: () => Record<string, string> | undefined;
  inWorkspace: (
    gerund: string,
    subject: string,
    body: (fs: WorkspaceClient["fs"]) => Promise<string>
  ) => Promise<string>;
  refuseWrite: () => Promise<string | undefined>;
  scope: () => string;
}

/** Takes what {@link file://./index.ts buildComputerTools} takes. */
export function computerContext(
  workspace: () => Promise<WorkspaceClient>,
  config: ComputerConfig,
  advisories?: () => Promise<readonly WorkspaceAdvisory[]>,
  fsWorkspace: () => Promise<WorkspaceClient> = workspace,
  lockScope?: () => string
): ComputerContext {
  const cwd = config.cwd ?? DEFAULT_CWD;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const gateMs = config.installGateMs ?? 90_000;
  const env = config.env;
  const ownScope = crypto.randomUUID();
  const scope = () => lockScope?.() ?? ownScope;

  /**
   * Wait out anything transient, up to the gate, and report whatever is left.
   *
   * Polled rather than subscribed: the state lives in another Durable Object,
   * there is no event to wait on, and the whole window is under two minutes.
   *
   * **Read for every command, including the ones that need no dependencies.**
   * The filter that spares `cat README.md` from queueing behind an `npm ci`
   * lives in `execGate`, where it applies per advisory — because a dependency
   * install and a full workspace are not relevant to the same commands, and one
   * filter over both leaves a workspace at its ceiling silent for exactly the
   * commands whose writes it is dropping. The cost is one same-colo RPC per
   * command, against a class of silent data loss.
   */
  const awaitAdvisories = async (
    command: string,
    signal?: AbortSignal
  ): Promise<ExecGate> => {
    if (!advisories) return {};

    // Fails **open**, and that belongs here rather than at the call site: this
    // is a read of another Durable Object's state. An error must not take out a
    // working shell — running the command is exactly what would have happened
    // before the gate existed, and a spurious blockage would strand the
    // subagent.
    const read = async (): Promise<readonly WorkspaceAdvisory[]> => {
      try {
        signal?.throwIfAborted();
        return await withAbort(signal, advisories());
      } catch (err) {
        // Open on a failed read, never on a cancel: failing open here would go on
        // to run the command the caller just gave up on.
        if (signal?.aborted) throw err;
        return [];
      }
    };

    // Clamped to whatever is left of the gate, not the bare interval. A fixed
    // sleep makes `installGateMs` a floor rather than the ceiling it is
    // documented to be: at a 100 ms gate the loop still slept the full three
    // seconds before looking again, so a public timeout overshot by 30×.
    const deadline = Date.now() + gateMs;
    let current = await read();
    // Keyed on the gate's own verdict rather than on a state name, so "what is
    // worth waiting for" has one definition and it is the one that will decide
    // the outcome.
    while (execGate(current, command).block && Date.now() < deadline) {
      const wait = Math.min(INSTALL_POLL_MS, deadline - Date.now());
      // Throws on a cancel rather than returning the verdict so far: a gate that
      // outlived its caller would otherwise go on to run the command it was holding.
      await withAbort(
        signal,
        new Promise((resolve) => setTimeout(resolve, wait))
      );
      current = await read();
    }
    return execGate(current, command);
  };

  /**
   * Whether a write can succeed at all, asked once and not polled.
   *
   * Separate from {@link awaitAdvisories} because the question is different:
   * there is no command to classify and nothing worth waiting for. An install in
   * flight does not stop a file being written, and the one thing that does —
   * a workspace that no longer accepts writes — never resolves on its own.
   *
   * Fails **open** for the same reason the exec gate does: a read of another
   * Durable Object's state must not take out a working tool.
   */
  const refuseWrite = async (): Promise<string | undefined> => {
    if (!advisories) return undefined;
    try {
      return writeGate(await advisories());
    } catch {
      return undefined;
    }
  };

  /**
   * Host-supplied environment, with the undefined entries dropped.
   *
   * `RuntimeExecOptions.env` is `Record<string, string>`, and a config thunk
   * that reads straight off `env` will hand back `undefined` for anything
   * unset — which would otherwise arrive in the container as the string
   * "undefined".
   */
  const definedEnv = (): Record<string, string> | undefined => {
    if (!env) return undefined;
    const entries = Object.entries(env()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  /**
   * Open the workspace, run one file operation in it, and own the failure.
   *
   * Five lines every file tool would otherwise repeat with only the verb changed
   * — five chances for the seventh to be written without them. The catch is the
   * point: a failed file operation is the model's to recover from, and it can
   * only recover from what it is told, so this returns the sentence rather than
   * throwing it.
   *
   * `sb_exec` deliberately does not use it. That one recognises `EEXEC_LOST`,
   * logs, and carries an install warning through the failure path — a bespoke
   * catch saying something this cannot.
   *
   * It opens through `fsWorkspace`, which is what makes the capability sentence
   * about these tools true: they answer while the container is down.
   */
  const inWorkspace = async (
    gerund: string,
    subject: string,
    body: (fs: WorkspaceClient["fs"]) => Promise<string>
  ): Promise<string> => {
    try {
      using ws = await fsWorkspace();
      return await body(ws.fs);
    } catch (err) {
      return `error ${gerund} ${subject}: ${String(err)}`;
    }
  };

  return {
    config,
    cwd,
    timeoutMs,
    maxChars,
    workspace,
    awaitAdvisories,
    definedEnv,
    inWorkspace,
    refuseWrite,
    scope
  };
}
