import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@cloudflare/computer";
import { ContainerTrust } from "./ca-trust.js";

/**
 * Which trust outcomes are terminal for a container, and which are retried.
 *
 * The command exits 0 whatever happens — it reports itself in stdout — so "it
 * ran" is not "it worked", and the flag has to read the transcript rather than
 * the exit code. Getting that wrong is invisible: a container marked trusted
 * whose CA install failed has no working HTTPS client, and nothing tries again.
 *
 * Driven against a fake workspace because the pool starts no container, which is
 * also why the specs next door reach only the throwing path.
 */

function trustWith(output: string | Error) {
  const exec = vi.fn(async () => ({
    result: async () => {
      if (output instanceof Error) throw output;
      return { exitCode: 0, stdout: output, stderr: "" };
    },
    [Symbol.dispose]: () => {}
  }));
  const workspace = { runtime: { exec } } as unknown as Workspace;
  const trust = new ContainerTrust({
    workspace: () => workspace,
    // No container, so no exit watch is armed — that path is about a container
    // being *replaced*, which is a different question from this one.
    container: () => undefined,
    tag: () => "spec",
    id: () => "spec-id"
  });
  return { trust, exec };
}

/** How many times the trust command was actually sent. */
async function runsAfterTwoEnsures(output: string | Error): Promise<number> {
  const { trust, exec } = trustWith(output);
  const quiet = [
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {})
  ];
  try {
    await trust.ensure();
    await trust.ensure();
    return exec.mock.calls.length;
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}

describe("when the container is asked to trust the CA again", () => {
  it("stops after a successful install", async () => {
    expect(await runsAfterTwoEnsures("TRUSTED")).toBe(1);
  });

  it("stops when there was no CA to install", async () => {
    // Terminal on purpose: interception is configured by the `connect()` already
    // awaited, so a CA absent now stays absent until the container is replaced,
    // and retrying would cost a round trip on the object's hottest path.
    expect(
      await runsAfterTwoEnsures("NO CA AT /etc/cloudflare/certs/x.crt")
    ).toBe(1);
  });

  it("tries again when the install ran and failed", async () => {
    // The case the exit code cannot distinguish. A container left marked trusted
    // here fails every later HTTPS connection with nothing naming the cause.
    expect(await runsAfterTwoEnsures("TRUST FAILED")).toBe(2);
  });

  it("tries again when the container could not be reached", async () => {
    expect(await runsAfterTwoEnsures(new Error("EEXEC_LOST"))).toBe(2);
  });

  it("forgets a container it had already trusted", async () => {
    const { trust, exec } = trustWith("TRUSTED");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await trust.ensure();
      trust.forget();
      await trust.ensure();
      expect(exec.mock.calls.length).toBe(2);
    } finally {
      info.mockRestore();
    }
  });
});
