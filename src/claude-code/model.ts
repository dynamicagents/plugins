import type { LanguageModel } from "ai";
import type { ClaudeCodeConfig } from "./config.js";
import type { ClaudeCodeResult, RateLimitInfo } from "./events.js";
import { claudeCodeSession, requireCredentials } from "./session.js";
import {
  execIdFor,
  followUpExecIdFor,
  type DrainCursor,
  type DrainOutcome,
  type SessionRuntime
} from "./run.js";

/**
 * A Claude Code session as a sub-agent's **model**.
 *
 * Claude Code brings its own tools, its own loop and its own context, so there
 * is nothing for Think to drive but the one call that runs it — and making that
 * call the model is what puts the session under Think's recovery. A turn cut by
 * an eviction or a deploy is continued; the continuation calls `doStream`
 * again, and every step below it has already taken is stored, so it resumes
 * where it was: the session is re-attached from its cursor, and a report
 * already made is emitted again rather than made again.
 *
 * ## The report is the only text
 *
 * A run's result is what its assistant messages say, so narration streamed as
 * text would become the result and bury the report. What the session says as
 * it works goes to the parent as notes instead, through `note`. Nothing else is
 * streamed at all: Think's stall watchdog is off, so a silent stream is not cut.
 */

/** The provider interface this implements, read off `ai` rather than imported. */
type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type CallOptions = Parameters<LanguageModelV3["doStream"]>[0];
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** How one exec of a session ended. */
export interface SessionEnd {
  exitCode: number;
  /** Absent when the process died without ever emitting a `result` line. */
  result?: ClaudeCodeResult;
  /** Bounded, and only when there is no `result` to explain the exit. */
  stderr?: string;
  /** The subscription bucket as the client last reported it, if it did. */
  rateLimit?: RateLimitInfo;
}

/** What a run amounted to, handed to `report`. */
export interface SessionOutcome {
  /** The session's own end. */
  session: SessionEnd;
  /** The follow-up's end, when `followUp` asked for one. */
  followUp?: SessionEnd;
}

/** The container a session runs in, released when the call that opened it ends. */
export interface SessionWorkspace extends Disposable {
  readonly runtime: SessionRuntime;
}

export interface ClaudeCodeModelOptions {
  config: ClaudeCodeConfig;
  /** Opens the run's container — the workspace the run's `runtime()` names. */
  workspace: () => Promise<SessionWorkspace>;
  /** The sub-agent's own storage, where every step's outcome is kept. */
  storage: DurableObjectStorage;
  /** The sub-agent's name, which is the run's id. The exec ids derive from it. */
  runId: string;
  /** A reading session runs in a throwaway copy of `dir`; see `./copy.ts`. */
  kind: "write" | "read";
  /** The checkout. */
  dir: string;
  /** Files one note on the parent's transcript: the sub-agent's `note`. */
  note: (key: string, text: string) => Promise<void>;
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

/** Zeroed: the session's tokens are the CLI's context, not this conversation's. */
const USAGE = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0
  },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

export function claudeCodeModel(
  options: ClaudeCodeModelOptions
): LanguageModelV3 {
  requireCredentials(options.config);
  const { storage, runId } = options;
  const session = claudeCodeSession(options.config);
  const key = (name: string) => `claude-code:${runId}:${name}`;
  const KEYS = {
    brief: key("brief"),
    cursor: key("cursor"),
    session: key("session"),
    followUp: key("follow-up"),
    followUpEnd: key("follow-up-end"),
    report: key("report")
  };

  const run = async (call: CallOptions): Promise<string> => {
    // The once-guarantee: a run that already reported says so again.
    const reported = await storage.get<string>(KEYS.report);
    if (reported !== undefined) return reported;

    const signal = call.abortSignal;
    using workspace = await options.workspace();
    const { runtime } = workspace;

    /** The exec being drained, which leads each note's key. */
    let current = "";
    /**
     * Each note, filed as it is parsed, then the cursor behind it. Keyed on the
     * exec as well as the position: the parent's transcript is one per task and
     * dedupes on the key, so a run's notes must not collide with another run's
     * — or with its own follow-up's, which counts from zero again.
     */
    const sinks = {
      onProgress: (note: { key: string; text: string }) =>
        options.note(`${current}:${note.key}`, note.text),
      onCheckpoint: (cursor: DrainCursor) => storage.put(KEYS.cursor, cursor),
      ...(signal ? { signal } : {})
    };

    /** Drain one exec to its end, starting it or re-attaching from the cursor. */
    const drain = async (
      execId: string,
      begin: () => Promise<DrainOutcome>
    ): Promise<SessionEnd> => {
      current = execId;
      const cursor = await storage.get<DrainCursor>(KEYS.cursor);
      const outcome =
        cursor?.execId === execId
          ? await session.resume(runtime, cursor, sinks)
          : await begin();
      await storage.put(KEYS.cursor, outcome.cursor);
      if (!outcome.done) {
        // Only the signal stops a drain short of the end: the turn was
        // cancelled, so the session goes with it.
        await session.stop(runtime, runId).catch((err: unknown) =>
          console.warn("[claude-code] could not stop a cancelled session", {
            runId,
            err: String(err)
          })
        );
        throw signal?.reason ?? new Error("the session was stopped");
      }
      return {
        exitCode: outcome.exitCode,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.stderr ? { stderr: outcome.stderr } : {}),
        ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {})
      };
    };

    let ended = await storage.get<SessionEnd>(KEYS.session);
    if (!ended) {
      let prompt = await storage.get<string>(KEYS.brief);
      if (prompt === undefined) {
        const task = lastUserText(call.prompt);
        prompt = options.brief ? await options.brief(task) : task;
        await storage.put(KEYS.brief, prompt);
      }
      const brief = prompt;
      ended = await drain(execIdFor(runId), () =>
        session.start(runtime, runId, options.kind, brief, options.dir, sinks)
      );
      await storage.put(KEYS.session, ended);
    }

    let followUpEnd = await storage.get<SessionEnd>(KEYS.followUpEnd);
    if (!followUpEnd && options.followUp) {
      let asked = await storage.get<{ prompt?: string }>(KEYS.followUp);
      if (!asked) {
        const prompt = await options.followUp(ended);
        asked = prompt ? { prompt } : {};
        await storage.put(KEYS.followUp, asked);
      }
      const sessionId = ended.result?.sessionId;
      if (asked.prompt && sessionId) {
        const prompt = asked.prompt;
        followUpEnd = await drain(followUpExecIdFor(runId), () =>
          session.followUp(
            runtime,
            runId,
            sessionId,
            prompt,
            options.dir,
            sinks
          )
        );
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

  return {
    specificationVersion: "v3",
    provider: "claude-code",
    modelId: options.config.model ?? "claude-code",
    supportedUrls: {},

    async doStream(call) {
      // The stream is returned at once and the session runs inside it, so
      // nothing waits on a promise for the length of a session.
      const stream = new ReadableStream<StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          try {
            const text = await run(call);
            controller.enqueue({ type: "text-start", id: "report" });
            controller.enqueue({
              type: "text-delta",
              id: "report",
              delta: text
            });
            controller.enqueue({ type: "text-end", id: "report" });
            controller.enqueue({
              type: "finish",
              usage: USAGE,
              finishReason: { unified: "stop", raw: undefined }
            });
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        }
      });
      return { stream };
    },

    async doGenerate(call) {
      const text = await run(call);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: []
      };
    }
  };
}

/**
 * The task: the last user message's text. On a continued turn the prompt ends
 * with the interrupted assistant message, so the last message is not it.
 */
function lastUserText(prompt: CallOptions["prompt"]): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== "user") continue;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  throw new Error("claude-code: the run has no task — no user message");
}
