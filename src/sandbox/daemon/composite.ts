import type {
  AdapterSession,
  ContainerAdapter,
  ContainerInput
} from "agents/harness/container/daemon";
import { CONTROL_SESSION, SANDBOX_CONTRACT } from "../constants.js";

/**
 * `adapter` for every session but the root one, which is the object's control
 * channel: it answers a `control:` prompt at once and starts nothing.
 *
 * Runtime-agnostic, so the specs serve it from a Worker the way an image serves
 * it from Node.
 */
export function withControlSession(
  adapter: ContainerAdapter
): ContainerAdapter {
  return {
    id: adapter.id,
    version: `${adapter.version}+sandbox.${SANDBOX_CONTRACT}`,
    ...(adapter.capabilities ? { capabilities: adapter.capabilities } : {}),
    open(context) {
      return context.session === CONTROL_SESSION
        ? controlSession()
        : adapter.open(context);
    }
  };
}

function controlSession(): AdapterSession {
  return {
    async run(turn) {
      return textOf(turn.input).startsWith("control:")
        ? { status: "done", text: "ok" }
        : { status: "unanswered", reason: "the control session runs no CLI" };
    },
    async close() {}
  };
}

function textOf(input: ContainerInput): string {
  return typeof input === "string"
    ? input
    : input.map((part) => (part.type === "text" ? part.text : "")).join("");
}
