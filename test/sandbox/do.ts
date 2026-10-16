import { env } from "cloudflare:workers";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import type { TestSandboxDO, TestSandboxHttpsDO } from "../worker.js";
import type { PollResult } from "../../src/sandbox/index.js";

// Cast, because this package generates no ambient `Env` (see
// `scripts/verify-runtime-types.mjs`); the bindings are in `wrangler.jsonc`.
const bindings = env as unknown as {
  TEST_SANDBOX: DurableObjectNamespace<TestSandboxDO>;
  TEST_SANDBOX_HTTPS: DurableObjectNamespace<TestSandboxHttpsDO>;
};

/** A fresh sandbox per test, over its own fake container. */
export const { freshStub: freshSandbox } = makeDoHelpers<TestSandboxDO>(
  bindings.TEST_SANDBOX
);
export const { freshStub: freshHttpsSandbox } =
  makeDoHelpers<TestSandboxHttpsDO>(bindings.TEST_SANDBOX_HTTPS);

/**
 * A run's poll, as its plain type: `PollResult` carries the transcript's JSON
 * values, whose RPC-stub mapping is too deep for the checker to instantiate.
 */
export async function pollRun(
  sandbox: unknown,
  runId: string,
  operationId: string
): Promise<PollResult> {
  const stub = sandbox as {
    poll(runId: string, operationId: string, waitMs: number): Promise<unknown>;
  };
  return (await stub.poll(runId, operationId, 2_000)) as PollResult;
}

/** Poll until `check` holds, for what the harness settles from its own alarm. */
export async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  ms = 10_000
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
