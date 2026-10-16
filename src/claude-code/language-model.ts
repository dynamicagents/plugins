import type { LanguageModel } from "ai";

/**
 * A run whose only output is its report, as a sub-agent's model.
 *
 * Both Claude Code models are this: the session is the whole turn, so the
 * stream carries nothing but the report, and Think's stall watchdog is off, so
 * a silent stream is not cut.
 */

/** The provider interface this implements, read off `ai` rather than imported. */
export type LanguageModelV3 = Extract<
  LanguageModel,
  { specificationVersion: "v3" }
>;
export type CallOptions = Parameters<LanguageModelV3["doStream"]>[0];
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

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

export function reportingModel(
  modelId: string,
  run: (call: CallOptions) => Promise<string>
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "claude-code",
    modelId,
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
export function lastUserText(prompt: CallOptions["prompt"]): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== "user") continue;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  throw new Error("claude-code: the run has no task — no user message");
}
