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
  decodeSkills,
  type RunEnd
} from "./harness-wire.js";
import type { ClaudeCodeResult, RateLimitInfo } from "./events.js";
import {
  lastUserText,
  reportingModel,
  type CallOptions,
  type LanguageModelV3
} from "./language-model.js";

/** How one turn of a session ended. */
export interface SessionEnd {
  exitCode: number;
  /** Absent when the process died without ever emitting a `result` line. */
  result?: ClaudeCodeResult;
  /** Bounded, and only when there is no `result` to explain the exit. */
  stderr?: string;
  /** The subscription bucket as the client last reported it, if it did. */
  rateLimit?: RateLimitInfo;
  /**
   * The Claude Code session id, from the `init` line by way of the daemon's
   * parser.
   *
   * Here as well as on `result` because the sessions worth continuing are often
   * the ones with no result: a session ended by its time limit or a cancel
   * reports none, and this is then the only handle to the conversation it got
   * half-way through.
   */
  sessionId?: string;
}

/**
 * A session's handle, as the host is told it.
 *
 * Told **twice**: once with the id alone, as soon as the session's `init` line
 * names it, and once with the session's end. The first call is what makes a
 * session that is about to be killed resumable at all; the second says how the
 * conversation it left stands.
 *
 * So a host keys its record on `sessionId` and keeps an `end` once it has one: a
 * recovered turn can report the same id again without an end, and a record that
 * let that erase the end would forget how the session finished.
 */
export interface SessionRecord {
  sessionId: string;
  /** Absent on the first call; the session's end on the second. */
  end?: SessionEnd;
}

/** What a run amounted to, handed to `report`. */
export interface SessionOutcome {
  /** The session's own end. */
  session: SessionEnd;
  /** The follow-up's end, when `followUp` asked for one. */
  followUp?: SessionEnd;
}

/**
 * A Claude Code session in a sandbox, as a sub-agent's model.
 *
 * Claude Code brings its own tools, its own loop and its own context, so there
 * is nothing for Think to drive but the one call that runs it — and making that
 * call the model is what puts the session under Think's recovery. The report
 * is its only text: what the session says as it works goes to the parent as
 * notes, through `note`. Every step's outcome is kept in the sub-agent's
 * storage, so a recovered turn picks up where it was. What can be lost:
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
  ): Promise<{ sessionId: string; created: boolean }>;
  submit(
    runId: string,
    text: string,
    operationId: string
  ): Promise<{ operationId: string; accepted: boolean }>;
  poll(
    runId: string,
    operationId: string,
    waitMs?: number,
    from?: number
  ): Promise<PollResult>;
  stopRun(runId: string): Promise<{ stopped: boolean }>;
}

export interface ClaudeCodeModelOptions {
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
  /**
   * A skill in the checkout the session starts in, by name: the caller's own
   * choice of process, rather than one the model picks off a description.
   *
   * It applies to the session's first turn, which is the only one that starts a
   * conversation — see the run header's `skill` and how
   * `./daemon/index.ts` launches it. A run whose CLI does not report
   * loading it is stopped rather than left doing generic work.
   *
   * So it does nothing beside {@link resume}, whose conversation already has
   * whatever process it started under: the launch injects nothing and this
   * confirms nothing. A caller with a choice to offer refuses the pair rather
   * than passing both — starter's writer tool does.
   */
  skill?: string;
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
   * stopped. Default {@link DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * File one note on the parent's transcript. `at` is when the daemon read the
   * line it came from: a poll files a batch at once, so the filing time would
   * give a tool's call and its result the same moment.
   */
  note: (
    key: string,
    text: string,
    detail?: ArtifactEntryDetail,
    at?: number
  ) => Promise<void>;
  /**
   * The session's handle, as soon as there is one and again when the session
   * ends — see {@link SessionRecord}.
   *
   * Best-effort, like `note`: a throw is logged and the run goes on. Recording a
   * handle is what makes a later run able to continue this conversation, and
   * losing that is not worth losing the session over.
   */
  onSession?: (record: SessionRecord) => Promise<void>;
  /**
   * The session's prompt, from the task the parent sent. Defaults to the task.
   *
   * Runs once per run, before the session starts, and its answer is kept. A
   * throw fails the run with its message — how a host refuses a run it cannot
   * pay for, or has nothing to work in.
   */
  brief?: (task: string) => Promise<string>;
  /**
   * One more turn for a session that ended, or `undefined`. Asked once; its
   * answer is kept, so a resumed run does not ask again.
   */
  followUp?: (session: SessionEnd) => Promise<string | undefined>;
  /** The text the parent receives. Run once, and kept. */
  report: (outcome: SessionOutcome) => Promise<string>;
}

/**
 * Three hours: a ceiling on a session that has stopped making progress, not a
 * budget for one that is. No timer in the sandbox races it, since the
 * container's idle stop never fires while an operation is open.
 */
export const DEFAULT_TIMEOUT_MS = 3 * 60 * 60_000;

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

export function claudeCodeModel(
  options: ClaudeCodeModelOptions
): LanguageModelV3 {
  const { storage, runId } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = (name: string) => `claude-code:${runId}:${name}`;
  const KEYS = {
    brief: key("brief"),
    session: key("session"),
    followUp: key("follow-up"),
    followUpEnd: key("follow-up-end"),
    report: key("report"),
    turn: (step: Step) => key(`turn:${step}`),
    /**
     * Where a run that started in a workspace container kept its place. Such a
     * run can still be resumed by a task waiting on input, and the guard below
     * is what stops it being briefed again.
     */
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

    /** Set only once the host has taken the handle, so a failed record is tried again. */
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
     * The session has to be running the skill the caller chose, and the CLI's
     * `init` line is the only account of that worth having: a skill whose
     * frontmatter will not parse is dropped silently, so a directory on disk
     * says nothing. Stopped here rather than reported at the end, because the
     * alternative is a session of hours doing generic work under the name of a
     * process somebody chose.
     *
     * Only for a submission that starts a conversation, which is the only one
     * the launch spends the name on. One carrying a conversation on asks for no
     * skill, and the CLI's list on a resume is what the checkout holds now
     * rather than what that conversation loaded — a session that is editing the
     * skills themselves can legitimately rename the one it started under.
     *
     * `null` is a CLI that reported no list at all (`./harness-wire.ts`). It
     * stops the session too: an unconfirmed skill is the failure this check
     * exists for, and a CLI that stopped reporting them is one this package has
     * not been checked against.
     */
    const requireSkill = async (
      operationId: string,
      skill: string,
      loaded: readonly string[] | null
    ): Promise<void> => {
      if (loaded?.includes(skill)) return;
      await stop(
        operationId,
        new Error(
          loaded === null
            ? `claude-code: the session did not report which skills it loaded, so it cannot be shown to be running ${skill}`
            : `claude-code: the session did not load the skill ${skill} — the CLI reported ${loaded.join(", ") || "none"}`
        )
      );
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
      const stored = await storage.get<TurnState>(KEYS.turn(step));
      let state: TurnState = stored ?? {
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
      try {
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
      } catch (err) {
        // Recovering, the last invocation's turn may still be running: an
        // abort stops it. A step that never began has nothing to stop.
        if (signal?.aborted && stored)
          await stop(
            `${runId}:${step}:a${state.attempt}`,
            signal.reason ?? err
          );
        throw err;
      }

      for (;;) {
        const operationId = `${runId}:${step}:a${state.attempt}`;
        // A resubmission that reached the CLI is told what happened, in the
        // conversation it already had; one that never did is the step again.
        // Neither the fork nor the skill is re-asked for: both are decisions
        // the turn that started the conversation already made.
        const { fork: _fork, skill: _skill, ...resumed } = header;
        const resubmitting = state.attempt > 0 && state.sessionId !== undefined;
        const text = resubmitting
          ? withRunHeader(resumed, CONTAINER_LOST_PROMPT)
          : withRunHeader(header, prompt);
        /**
         * The skill *this* submission asked for — read here rather than off
         * `header` where it is checked, because the poll moves
         * `state.sessionId` on and what has to be confirmed is what the text
         * just sent carries.
         *
         * None, for a submission that carries a conversation on rather than
         * starting one: a resubmission into the session the last attempt
         * reached, or a run the caller opened on another run's conversation,
         * where the launch injects nothing either.
         */
        const chosen =
          resubmitting || options.resume !== undefined
            ? undefined
            : header.skill;
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
            if (taken.skills !== undefined && chosen !== undefined)
              await requireSkill(operationId, chosen, taken.skills);
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
          // No code is a process a signal ended.
          return sessionEnd(end, end.exitCode ?? -1, state.sessionId);
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

    /**
     * File one polled message's note, or read what the daemon reported rather
     * than said: the session id, or the skills the CLI loaded.
     */
    const take = async (
      message: PolledMessage
    ): Promise<{
      sessionId?: string;
      skills?: string[] | null;
      failed?: true;
    }> => {
      const part = message.message.parts[0];
      if (part?.type !== "text") return {};
      const sessionId = decodeSessionId(part.text);
      if (sessionId !== undefined) return { sessionId };
      const skills = decodeSkills(part.text);
      if (skills !== undefined) return { skills };
      const note = decodeNote(part.text);
      if (!note) return {};
      // Keyed on the message, which is the operation and the note's position:
      // the parent's transcript dedupes on the key, so a refiled poll is free.
      try {
        const at = message.message.createdAt;
        await options.note(
          message.id,
          note.text,
          note.detail,
          at > 0 ? at : undefined
        );
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
      ...(options.skill !== undefined ? { skill: options.skill } : {}),
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
      // answers to one every turn. A skill is neither: it was chosen for the
      // turn that started the conversation this one continues.
      if (asked.prompt && (ended.result?.sessionId ?? ended.sessionId)) {
        const { skill: _skill, ...carried } = header;
        const { schema: _schema, ...unbound } = carried;
        const followUpHeader = header.mode === "plan" ? carried : unbound;
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
