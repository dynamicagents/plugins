import type { ArtifactEntryDetail } from "@dynamicagents/core/artifacts";
import { isPlatformTransientError } from "agents";
import type { ContainerOperationResult } from "agents/harness/container";
import { SANDBOX_CONTRACT } from "../sandbox/constants.js";
import { withRunHeader, type RunHeader } from "../sandbox/header.js";
import type { PolledMessage, PollResult } from "../sandbox/object.js";
import { containerLostCard, lostCard } from "./cards.js";
import type { EffortLevel, PermissionMode } from "./config.js";
import {
  decodeNote,
  decodeRunEnd,
  decodeSessionId,
  type RunEnd
} from "./harness-wire.js";
import {
  lastUserText,
  reportingModel,
  type CallOptions,
  type LanguageModelV3
} from "./language-model.js";
import type { SessionEnd, SessionOutcome, SessionRecord } from "./model.js";

/**
 * A Claude Code session in a sandbox, as a sub-agent's model.
 *
 * The shape of `./model.ts` `claudeCodeModel` — the session is the model, the
 * report is its only text, every step's outcome is kept in the sub-agent's
 * storage under the same keys — over a sandbox rather than a workspace. What
 * that changes is what can be lost:
 *
 * - **Nothing streams.** The session runs as a harness operation the sandbox
 *   keeps, and this polls it. A poll is short, so a reset of either object
 *   costs one poll, and Think's recovery of this turn polls the same operation.
 * - **A lost container resumes the session.** The operation settles as
 *   `container_lost`, and this submits the next attempt to the same harness
 *   session, whose CLI conversation the harness kept: the session is told what
 *   happened, not briefed again.
 */

/** The sandbox RPCs a run uses. */
export interface SandboxRuns {
  createRun(
    runId: string,
    options: { cwd: string; forkOf?: string; continues?: string }
  ): Promise<unknown>;
  submit(runId: string, text: string, operationId: string): Promise<unknown>;
  poll(
    runId: string,
    operationId: string,
    waitMs?: number,
    from?: number
  ): Promise<PollResult>;
  stopRun(runId: string): Promise<unknown>;
}

export interface ClaudeCodeHarnessModelOptions {
  /**
   * The sandbox the run is in. Called again after a failed call, so each call
   * should reach the object through a new stub.
   */
  sandbox: () => SandboxRuns;
  /** The sub-agent's own storage, where every step's outcome is kept. */
  storage: DurableObjectStorage;
  /** The sub-agent's name, which is the run's id in the sandbox. */
  runId: string;
  /** The checkout, under the sandbox's `/workspace`. */
  dir: string;
  /** The CLI's model. Unset, the daemon's. */
  model?: string;
  effort?: EffortLevel;
  /** A JSON schema the daemon was built with, by name, that the answer must match. */
  schema?: string;
  /** `plan` runs read-only and answers to {@link schema}; anything else is the daemon's mode. */
  permissionMode?: PermissionMode;
  /**
   * Another run in this sandbox whose conversation this one carries on: as more
   * of it, or with `fork`, as a new branch of it. Its prompt is then the next
   * user turn.
   */
  resume?: { run: string; fork?: boolean };
  /**
   * How long a session may run, from its first submission, before it is
   * stopped. Default {@link DEFAULT_HARNESS_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  note: (
    key: string,
    text: string,
    detail?: ArtifactEntryDetail
  ) => Promise<void>;
  /** As `./model.ts` `ClaudeCodeModelOptions.onSession`. */
  onSession?: (record: SessionRecord) => Promise<void>;
  /** As `./model.ts` `ClaudeCodeModelOptions.brief`. */
  brief?: (task: string) => Promise<string>;
  /** As `./model.ts` `ClaudeCodeModelOptions.followUp`. */
  followUp?: (session: SessionEnd) => Promise<string | undefined>;
  report: (outcome: SessionOutcome) => Promise<string>;
}

/**
 * Three hours: a ceiling on a session that has stopped making progress, not a
 * budget for one that is. No timer in the sandbox races it, since the
 * container's idle stop never fires while an operation is open.
 */
export const DEFAULT_HARNESS_TIMEOUT_MS = 3 * 60 * 60_000;

/** What a session is told when it resumes in a new container. */
export const CONTAINER_LOST_PROMPT =
  "The container this session was running in was lost, and the session has " +
  "resumed in a new one. Its disk is as of the sandbox's last snapshot, so " +
  "files written since may be gone, and nothing you started is still running. " +
  "Check the checkout's state before carrying on with the task.";

/**
 * Attempts after the first. A turn that kills its container every time — an
 * install that runs it out of memory — would otherwise be resubmitted forever.
 */
const LOST_RESUBMITS = 3;
/** Why an operation settled that a new attempt may get past. */
const LOST_REASONS = new Set(["container_lost", "container_unavailable"]);

/** Polls in a row a note may fail to file before it is given up on. */
const NOTE_TRIES = 3;

/** The sandbox's own ceiling on one poll's wait. */
const POLL_WAIT_MS = 20_000;
/**
 * Failed calls in a row before one is thrown. A sandbox reset costs one call;
 * an isolate this run's object has been replaced on fails every call, and is
 * left to the restart's recovery of the turn.
 */
const TRANSIENT_TRIES = 8;
const TRANSIENT_BACKOFF_MS = 1_000;

/** Where one step of the run is, kept so a recovered turn picks it up. */
interface TurnState {
  attempt: number;
  startedAt: number;
  /** The CLI's session id, once an attempt's `init` named it. */
  sessionId?: string;
  /** The current attempt's messages already filed — see `poll`'s `from`. */
  from: number;
}

type Step = "session" | "follow-up";

export function claudeCodeHarnessModel(
  options: ClaudeCodeHarnessModelOptions
): LanguageModelV3 {
  const { storage, runId } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS;
  const key = (name: string) => `claude-code:${runId}:${name}`;
  const KEYS = {
    brief: key("brief"),
    session: key("session"),
    followUp: key("follow-up"),
    followUpEnd: key("follow-up-end"),
    report: key("report"),
    turn: (step: Step) => key(`turn:${step}`),
    /** `./model.ts`'s, which marks a run that started on a workspace. */
    cursor: key("cursor")
  };

  const run = async (call: CallOptions): Promise<string> => {
    const reported = await storage.get<string>(KEYS.report);
    if (reported !== undefined) return reported;
    if (
      (await storage.get(KEYS.cursor)) !== undefined &&
      (await storage.get(KEYS.turn("session"))) === undefined
    ) {
      throw new Error(
        "claude-code: this run's session started in a workspace container, " +
          "which a sandbox cannot attach to, so it ended when the deployment moved to sandboxes"
      );
    }
    const signal = call.abortSignal;

    /** As `./model.ts`: set only once the host has taken the handle. */
    let announced = "";
    const announce = async (record: SessionRecord): Promise<void> => {
      const sink = options.onSession;
      if (!sink || (record.end === undefined && announced === record.sessionId))
        return;
      try {
        await sink(record);
        announced = record.sessionId;
      } catch (err) {
        console.warn("[claude-code] the session's handle was not recorded", {
          runId,
          sessionId: record.sessionId,
          err: String(err)
        });
      }
    };

    const file = async (
      noteKey: string,
      text: string,
      detail?: ArtifactEntryDetail
    ): Promise<void> => {
      await options.note(noteKey, text, detail).catch((err: unknown) =>
        console.warn("[claude-code] a note was not filed", {
          runId,
          key: noteKey,
          err: String(err)
        })
      );
    };

    /**
     * One sandbox call, through a new stub after each transient failure. The
     * abort ends the wait, not the call: an RPC cannot be taken back.
     */
    const rpc = async <T>(
      fn: (sandbox: SandboxRuns) => Promise<T>
    ): Promise<T> => {
      for (let tries = 1; ; tries++) {
        try {
          return await untilAborted(fn(options.sandbox()), signal);
        } catch (err) {
          if (
            signal?.aborted ||
            !isPlatformTransientError(err) ||
            tries >= TRANSIENT_TRIES
          )
            throw err;
          console.warn("[claude-code] a sandbox call failed — retrying", {
            runId,
            tries,
            err: String(err)
          });
          await untilAborted(sleep(TRANSIENT_BACKOFF_MS * tries), signal);
        }
      }
    };

    /** Stop the session, file its end, and end the run with `reason`. */
    const stop = async (
      operationId: string,
      reason: unknown
    ): Promise<never> => {
      await options
        .sandbox()
        .stopRun(runId)
        .catch((err: unknown) =>
          console.warn("[claude-code] could not stop the session", {
            runId,
            err: String(err)
          })
        );
      const card = lostCard(
        reason instanceof Error ? reason.message : String(reason)
      );
      await file(`${operationId}:lost`, card.text, card.detail);
      throw reason;
    };

    /**
     * One step of the run, to its end: the brief's session, or the follow-up.
     * Both count against one limit, from the session's first submission.
     */
    const turn = async (
      step: Step,
      prompt: string,
      header: RunHeader
    ): Promise<SessionEnd> => {
      const origin =
        step === "session"
          ? undefined
          : (await storage.get<TurnState>(KEYS.turn("session")))?.startedAt;
      let state: TurnState = (await storage.get<TurnState>(
        KEYS.turn(step)
      )) ?? {
        attempt: 0,
        startedAt: origin ?? Date.now(),
        from: 0
      };
      const save = async (next: TurnState) => {
        state = next;
        await storage.put(KEYS.turn(step), state);
      };
      await save(state);
      const resume = options.resume;
      await rpc((sandbox) =>
        sandbox.createRun(runId, {
          cwd: options.dir,
          ...(resume
            ? resume.fork
              ? { forkOf: resume.run }
              : { continues: resume.run }
            : {})
        })
      );

      for (;;) {
        const operationId = `${runId}:${step}:a${state.attempt}`;
        // A resubmission that reached the CLI is told what happened, in the
        // conversation it already had; one that never did is the step again.
        const { fork: _fork, ...resumed } = header;
        const text =
          state.attempt > 0 && state.sessionId
            ? withRunHeader(resumed, CONTAINER_LOST_PROMPT)
            : withRunHeader(header, prompt);
        try {
          await rpc((sandbox) => sandbox.submit(runId, text, operationId));
        } catch (err) {
          // The submission may have landed: an abort stops what it started.
          if (signal?.aborted) await stop(operationId, signal.reason ?? err);
          throw err;
        }

        let result: ContainerOperationResult | undefined;
        /** Polls in a row that stopped at one unfiled note. */
        let stuck = 0;
        while (!result) {
          if (signal?.aborted)
            await stop(
              operationId,
              signal.reason ?? new Error("the session was stopped")
            );
          if (Date.now() - state.startedAt > timeoutMs) {
            await stop(
              operationId,
              new Error(
                `the session ran past its limit of ${Math.round(timeoutMs / 60_000)} minutes`
              )
            );
          }
          let polled: PollResult;
          try {
            polled = await rpc((sandbox) =>
              sandbox.poll(runId, operationId, POLL_WAIT_MS, state.from)
            );
          } catch (err) {
            if (signal?.aborted) continue;
            throw err;
          }
          if (polled.contract !== SANDBOX_CONTRACT) {
            throw new Error(
              `claude-code: the sandbox answered with contract ${polled.contract} and this run expects ${SANDBOX_CONTRACT}: ` +
                "a sandbox kept busy on older code through a deploy answered it"
            );
          }
          // In order, and the position never past a note that was not filed:
          // the next poll sends it again. One that never files is given up on
          // after a few polls, so the session's end still arrives.
          let filedTo = polled.next;
          for (const [i, message] of polled.messages.entries()) {
            const taken = await take(message);
            if (taken.failed && stuck < NOTE_TRIES) {
              stuck += 1;
              filedTo = state.from + i;
              break;
            }
            if (taken.failed) {
              console.warn("[claude-code] a note was given up on", {
                runId,
                key: message.id
              });
            }
            stuck = 0;
            if (taken.sessionId !== undefined) {
              if (taken.sessionId !== state.sessionId)
                await save({ ...state, sessionId: taken.sessionId });
              await announce({ sessionId: taken.sessionId });
            }
          }
          if (filedTo !== state.from) await save({ ...state, from: filedTo });
          if (filedTo === polled.next) result = polled.result;
        }

        if (result.status === "done") {
          const end = decodeRunEnd(result.text);
          if (!end?.result) {
            throw new Error(
              `claude-code: the sandbox settled the session with no end it could read: ${String(result.text).slice(0, 200)}`
            );
          }
          return sessionEnd(end, 0, state.sessionId);
        }
        const reason = result.reason ?? "";
        const end = decodeRunEnd(reason);
        if (end) return sessionEnd(end, end.exitCode ?? 1, state.sessionId);
        if (signal?.aborted)
          await stop(
            operationId,
            signal.reason ?? new Error("the session was stopped")
          );
        if (!LOST_REASONS.has(reason) || state.attempt >= LOST_RESUBMITS) {
          const card = lostCard(reason || "the sandbox gave no reason");
          await file(`${operationId}:lost`, card.text, card.detail);
          throw new Error(
            `claude-code: the sandbox ended the session: ${reason || "no reason given"}`
          );
        }
        console.warn(
          "[claude-code] the session's container was lost — resuming",
          {
            runId,
            operationId,
            reason
          }
        );
        const card = containerLostCard(reason);
        await file(`${operationId}:container-lost`, card.text, card.detail);
        await save({ ...state, attempt: state.attempt + 1, from: 0 });
      }
    };

    /** File one polled message's note, or read the session id it carries. */
    const take = async (
      message: PolledMessage
    ): Promise<{ sessionId?: string; failed?: true }> => {
      const part = message.message.parts[0];
      if (part?.type !== "text") return {};
      const sessionId = decodeSessionId(part.text);
      if (sessionId !== undefined) return { sessionId };
      const note = decodeNote(part.text);
      if (!note) return {};
      // Keyed on the message, which is the operation and the note's position:
      // the parent's transcript dedupes on the key, so a refiled poll is free.
      try {
        await options.note(message.id, note.text, note.detail);
        return {};
      } catch (err) {
        console.warn("[claude-code] a note was not filed — polling it again", {
          runId,
          key: message.id,
          err: String(err)
        });
        return { failed: true };
      }
    };

    const header: RunHeader = {
      cwd: options.dir,
      ...(options.permissionMode === "plan"
        ? { mode: "plan" as const }
        : { mode: "build" as const }),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.model !== undefined ? { model: options.model } : {})
    };

    let ended = await storage.get<SessionEnd>(KEYS.session);
    if (!ended) {
      let prompt = await storage.get<string>(KEYS.brief);
      if (prompt === undefined) {
        const task = lastUserText(call.prompt);
        prompt = options.brief ? await options.brief(task) : task;
        await storage.put(KEYS.brief, prompt);
      }
      ended = await turn("session", prompt, {
        ...header,
        ...(options.resume?.fork ? { fork: true } : {})
      });
      await storage.put(KEYS.session, ended);
    }
    if (ended.sessionId)
      await announce({ sessionId: ended.sessionId, end: ended });

    let followUpEnd = await storage.get<SessionEnd>(KEYS.followUpEnd);
    if (!followUpEnd && options.followUp) {
      let asked = await storage.get<{ prompt?: string }>(KEYS.followUp);
      if (!asked) {
        const prompt = await options.followUp(ended);
        asked = prompt ? { prompt } : {};
        await storage.put(KEYS.followUp, asked);
      }
      // A session with no conversation has nothing to follow up. Its schema
      // was the session's answer, not the follow-up's — except a plan's, which
      // answers to one every turn.
      if (asked.prompt && (ended.result?.sessionId ?? ended.sessionId)) {
        const { schema: _schema, ...unbound } = header;
        const followUpHeader = header.mode === "plan" ? header : unbound;
        followUpEnd = await turn("follow-up", asked.prompt, followUpHeader);
        await storage.put(KEYS.followUpEnd, followUpEnd);
      }
    }

    const text = await options.report({
      session: ended,
      ...(followUpEnd ? { followUp: followUpEnd } : {})
    });
    await storage.put(KEYS.report, text);
    return text;
  };

  return reportingModel(options.model ?? "claude-code", run);
}

function sessionEnd(
  end: RunEnd,
  exitCode: number,
  seen: string | undefined
): SessionEnd {
  const sessionId = end.sessionId ?? seen;
  return {
    exitCode,
    ...(end.result ? { result: end.result } : {}),
    ...(end.stderr ? { stderr: end.stderr } : {}),
    ...(end.rateLimit ? { rateLimit: end.rateLimit } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `promise`, or the abort's reason as soon as `signal` fires. */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
