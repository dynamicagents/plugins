import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/container";
import { CONTROL_SESSION, EGRESS_READY } from "./constants.js";
import {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallProbe
} from "./install-plan.js";

/**
 * What an install into `dir` would mark itself as, in a test sandbox whose
 * files all read `{}`: its files' fingerprint and the environment's digest.
 */
async function installKey(
  dir: string,
  env: Record<string, string>
): Promise<string> {
  const files: InstallProbe = {
    exists: async () => true,
    readFile: async () => "{}"
  };
  const resolution = await resolveInstallCommand(
    files,
    dir,
    DEFAULT_INSTALL_PLAN
  );
  const fingerprint = await installFingerprint(files, dir, resolution);
  const sorted = Object.entries(env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sorted))
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return `${fingerprint}:${hex}`;
}
import {
  eventually,
  freshHttpsSandbox,
  freshSandbox,
  pollRun
} from "../../test/sandbox/do.js";

/**
 * `SandboxObjectBase` over the real `ContainerHarness` and the real daemon
 * core, behind a fake container. Every rule here is one the sandbox relies on
 * the harness for and closes from outside it; a harness that changes any of
 * them fails here rather than in a running session.
 */

const joined = (execs: readonly (readonly string[])[]) =>
  execs.map((cmd) => cmd.join(" "));

describe("the harness behaviour a sandbox is built on", () => {
  it("names its control session as the harness names its root", () => {
    expect(CONTROL_SESSION).toBe(ROOT_SESSION);
  });

  it("starts a stopped container with a control prompt, and prepares it once", async () => {
    const sandbox = freshSandbox("wake");
    const { runtimeId } = await sandbox.ensureRunning();
    const fake = await sandbox.fake();
    expect(fake.running).toBe(true);
    expect(fake.starts).toBe(1);
    expect(fake.lastStart.image).toBe("test-image");
    // The lifecycle started, so the inactivity timeout is armed.
    expect(fake.inactivityTimeoutMs).toBeGreaterThan(0);
    const markers = joined(fake.execs).filter((cmd) =>
      cmd.includes(EGRESS_READY)
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toContain(runtimeId);

    await sandbox.ensureRunning();
    expect((await sandbox.fake()).starts).toBe(1);
    expect(
      joined((await sandbox.fake()).execs).filter((cmd) =>
        cmd.includes(EGRESS_READY)
      )
    ).toHaveLength(1);
  });

  it("runs a turn in a session the sandbox made, and reports only that operation's messages", async () => {
    const sandbox = freshSandbox("turn");
    const { sessionId } = await sandbox.createRun("run-1", {
      cwd: "/workspace/repo"
    });
    expect(sessionId).not.toBe(ROOT_SESSION);
    expect(
      (await sandbox.createRun("run-1", { cwd: "/workspace/repo" })).created
    ).toBe(false);

    const receipt = await sandbox.submit("run-1", "hello", "op-1");
    expect(receipt).toEqual({ operationId: "op-1", accepted: true });
    const polled = await eventually(
      () => pollRun(sandbox, "run-1", "op-1"),
      (poll) => poll.result !== undefined
    );
    expect(polled.result).toMatchObject({
      status: "done",
      text: "echo: hello (turn 1)"
    });
    expect(polled.messages.map((m) => m.message.role)).toEqual(["assistant"]);
    expect(polled.messages[0]?.digest).toMatch(/^[0-9a-f]{24}$/);
    // Paged: what a poll already sent is not sent again.
    expect(polled.next).toBe(1);
    expect(
      (await pollRun(sandbox, "run-1", "op-1", polled.next)).messages
    ).toEqual([]);
  });

  it("runs every turn of a run in its directory, and refuses one aimed elsewhere", async () => {
    const sandbox = freshSandbox("cwd");
    await sandbox.createRun("run-1", { cwd: "/workspace/repo" });
    await sandbox.submit("run-1", "no header", "op-1");
    await eventually(
      () => pollRun(sandbox, "run-1", "op-1"),
      (poll) => poll.result !== undefined
    );
    expect(await sandbox.headerOf("op-1")).toEqual({ cwd: "/workspace/repo" });
    await runInDurableObject(sandbox, async (instance) => {
      await expect(
        instance.submit(
          "run-1",
          `@@da ${JSON.stringify({ cwd: "/workspace/other" })}\nmoved`,
          "op-2"
        )
      ).rejects.toThrow(/cannot run in \/workspace\/other/);
    });
  });

  it("dedupes an operation id, so a lost run is resubmitted under a new one", async () => {
    const sandbox = freshSandbox("dedupe");
    await sandbox.createRun("run-1", { cwd: "/workspace/repo" });
    await sandbox.submit("run-1", "once", "op-1");
    await eventually(
      () => pollRun(sandbox, "run-1", "op-1"),
      (poll) => poll.result !== undefined
    );
    expect(await sandbox.submit("run-1", "once", "op-1")).toEqual({
      operationId: "op-1",
      accepted: false
    });
  });

  it("settles a run whose container died as container_lost, and the session goes on", async () => {
    const sandbox = freshSandbox("lost");
    await sandbox.createRun("run-1", { cwd: "/workspace/repo" });
    await sandbox.submit("run-1", "first", "op-1");
    await eventually(
      () => pollRun(sandbox, "run-1", "op-1"),
      (poll) => poll.result !== undefined
    );

    await sandbox.submit("run-1", "slow 60000 never", "op-2");
    await eventually(
      () => sandbox.fake(),
      (fake) => fake.running
    );
    await sandbox.crash();
    const lost = await eventually(
      () => pollRun(sandbox, "run-1", "op-2"),
      (poll) => poll.result !== undefined
    );
    expect(lost.result).toMatchObject({
      status: "unanswered",
      reason: "container_lost"
    });

    await sandbox.submit("run-1", "second", "op-2:a1");
    const resumed = await eventually(
      () => pollRun(sandbox, "run-1", "op-2:a1"),
      (poll) => poll.result !== undefined
    );
    // The echo adapter counts the turns its session persisted: the conversation survived.
    expect(resumed.result).toMatchObject({
      status: "done",
      text: "echo: second (turn 2)"
    });
  });

  it("forks a run's conversation and reports none of the parent's messages as the fork's", async () => {
    const sandbox = freshSandbox("fork");
    await sandbox.createRun("plan", { cwd: "/workspace/repo" });
    await sandbox.submit("plan", "planned", "op-plan");
    await eventually(
      () => pollRun(sandbox, "plan", "op-plan"),
      (poll) => poll.result !== undefined
    );

    const forked = await sandbox.createRun("write", {
      cwd: "/workspace/repo",
      forkOf: "plan"
    });
    expect(forked.created).toBe(true);
    await sandbox.submit("write", "written", "op-write");
    const polled = await eventually(
      () => pollRun(sandbox, "write", "op-write"),
      (poll) => poll.result !== undefined
    );
    expect(polled.result).toMatchObject({
      status: "done",
      text: "echo: written (turn 2)"
    });
    expect(
      polled.messages.every((m) => m.message.operationId === "op-write")
    ).toBe(true);
  });

  it(
    "starts nothing for a submission that arrives after its run was stopped",
    { timeout: 20_000 },
    async () => {
      const sandbox = freshSandbox("late");
      await sandbox.answer("--output-format stream-jso[n]", "", 1);
      await sandbox.createRun("run-1", { cwd: "/workspace/repo" });
      // Held where a submission waits on a new container: its egress marker.
      await sandbox.holdExec(EGRESS_READY);
      await runInDurableObject(sandbox, async (instance, state) => {
        const late = instance.submit("run-1", "too late", "op-1").then(
          () => "accepted",
          (err: unknown) => String(err)
        );
        await eventually(
          async () => instance.fake(),
          (fake) => joined(fake.execs).some((cmd) => cmd.includes(EGRESS_READY))
        );
        // The stop lands while the submission is still starting the container.
        const stopping = instance.stopRun("run-1");
        await eventually(
          async () =>
            state.storage.sql
              .exec<{ stopped_at: number | null }>(
                "SELECT stopped_at FROM sandbox_runs WHERE run_id = 'run-1'"
              )
              .one().stopped_at,
          (stoppedAt) => stoppedAt !== null
        );
        instance.freeExec();
        await stopping;
        expect(await late).toMatch(/was stopped/);
        await expect(instance.submit("run-1", "again", "op-2")).rejects.toThrow(
          /was stopped/
        );
      });
    }
  );

  it("continues a run's conversation as another run, in the same directory only", async () => {
    const sandbox = freshSandbox("continue");
    await sandbox.createRun("first", { cwd: "/workspace/repo" });
    await sandbox.submit("first", "began", "op-first");
    await eventually(
      () => pollRun(sandbox, "first", "op-first"),
      (poll) => poll.result !== undefined
    );
    const next = await sandbox.createRun("second", {
      cwd: "/workspace/repo",
      continues: "first"
    });
    expect(next.created).toBe(true);
    await sandbox.submit("second", "carried on", "op-second");
    const polled = await eventually(
      () => pollRun(sandbox, "second", "op-second"),
      (poll) => poll.result !== undefined
    );
    expect(polled.result).toMatchObject({
      status: "done",
      text: "echo: carried on (turn 2)"
    });
    await runInDurableObject(sandbox, async (instance) => {
      await expect(
        instance.createRun("third", {
          cwd: "/workspace/other",
          continues: "first"
        })
      ).rejects.toThrow(/cannot work in \/workspace\/other/);
      await expect(
        instance.createRun("fourth", {
          cwd: "/workspace/repo",
          continues: "first",
          forkOf: "first"
        })
      ).rejects.toThrow(/not both/);
    });
  });

  it(
    "stops only a run's own operations, never those of a run that continues it",
    { timeout: 30_000 },
    async () => {
      const sandbox = freshSandbox("successor");
      // No CLI is left to wait for once a stop has aborted.
      await sandbox.answer("--output-format stream-jso[n]", "", 1);
      await sandbox.createRun("first", { cwd: "/workspace/repo" });
      await sandbox.submit("first", "began", "op-first");
      await eventually(
        () => pollRun(sandbox, "first", "op-first"),
        (poll) => poll.result !== undefined
      );
      await sandbox.createRun("second", {
        cwd: "/workspace/repo",
        continues: "first"
      });
      await sandbox.submit("second", "slow 8000 carried on", "op-second");
      // Stopping the predecessor, on the session the two runs share.
      expect(await sandbox.stopRun("first")).toEqual({ stopped: false });
      const polled = await eventually(
        () => pollRun(sandbox, "second", "op-second"),
        (poll) => poll.result !== undefined,
        20_000
      );
      expect(polled.result).toMatchObject({ status: "done" });
      await runInDurableObject(sandbox, async (instance) => {
        await expect(
          instance.submit("second", "taken", "op-first")
        ).rejects.toThrow(/is run first's/);
      });
    }
  );

  it("starts the next container from a checkpoint it wrote, and another sandbox from that checkpoint", async () => {
    const parent = freshSandbox("checkpoint");
    await parent.ensureRunning();
    const seed = await parent.checkpoint();
    expect(seed).toMatchObject({
      key: "image:test-image",
      snapshot: { id: "snapshot-1" }
    });
    expect(await parent.snapshotRecord()).toEqual(seed);

    await parent.crash();
    await parent.ensureRunning();
    expect((await parent.fake()).lastStart.containerSnapshot).toEqual({
      id: "snapshot-1"
    });

    const slot = freshSandbox("seeded");
    expect(await slot.seedFrom(seed!)).toEqual({ seeded: true });
    await slot.ensureRunning();
    expect((await slot.fake()).lastStart.containerSnapshot).toEqual({
      id: "snapshot-1"
    });
    expect(await slot.seedFrom(seed!)).toMatchObject({ seeded: false });
    expect(
      await slot.seedFrom({ key: "image:other", snapshot: { id: "x" } })
    ).toMatchObject({ seeded: false });
  });

  it(
    "will not release while a run is open, since stopping would start it again",
    { timeout: 20_000 },
    async () => {
      const sandbox = freshSandbox("release");
      // No CLI is left once the run is aborted: the probe for one finds nothing.
      await sandbox.answer("--output-format stream-jso[n]", "", 1);
      await sandbox.createRun("run-1", { cwd: "/workspace/repo" });
      await sandbox.submit("run-1", "slow 60000 busy", "op-1");
      await eventually(
        () => sandbox.fake(),
        (fake) => fake.running
      );
      expect(await sandbox.release()).toMatchObject({ released: false });
      await sandbox.stopRun("run-1");
      expect(await sandbox.release()).toEqual({ released: true });
      expect((await sandbox.fake()).running).toBe(false);
    }
  );

  it("will not release under a command, and holds new work until a release is done", async () => {
    const sandbox = freshSandbox("held");
    await sandbox.ensureRunning();
    await sandbox.holdExec("sleep 600");
    const running = sandbox.exec(["sleep", "600"]);
    await eventually(
      () => sandbox.fake(),
      (fake) => joined(fake.execs).some((cmd) => cmd.includes("sleep 600"))
    );
    expect(await sandbox.release()).toEqual({
      released: false,
      reason: "a command is still running"
    });
    await sandbox.freeExec();
    expect((await running).exitCode).toBe(0);
    expect(await sandbox.release()).toEqual({ released: true });
    expect((await sandbox.fake()).running).toBe(false);
  });
});

describe("commands", () => {
  it("starts an agent's command with no environment of its own, so root's setpriv honours none of it", async () => {
    const sandbox = freshSandbox("env");
    await sandbox.ensureRunning();
    await sandbox.exec(["true"], { env: { LD_PRELOAD: "/workspace/evil.so" } });
    const fake = await sandbox.fake();
    const at = fake.execs.findIndex((cmd) =>
      cmd.includes("LD_PRELOAD=/workspace/evil.so")
    );
    expect(fake.execs[at]?.[0]).toBe("/usr/bin/setpriv");
    expect(fake.execEnvs[at]).toBeNull();
  });
});

describe("checkouts and installs", () => {
  it("marks a checkout once it is on the disk, so an image's own directory is never taken for it", async () => {
    const sandbox = freshSandbox("mark");
    await sandbox.ensureRunning();
    expect(
      await sandbox.noteCheckout({ dir: "/workspace/repo", kind: "repo" })
    ).toEqual({ dir: "/workspace/repo", present: true });
    expect(
      joined((await sandbox.fake()).execs).some((cmd) =>
        cmd.includes("/var/lib/da/checkouts/%2Fworkspace%2Frepo")
      )
    ).toBe(true);
  });

  it("answers a stopped sandbox's checkout from its record, starting nothing", async () => {
    const sandbox = freshSandbox("record");
    expect(
      await sandbox.noteCheckout({ dir: "/workspace/repo", kind: "repo" })
    ).toEqual({ dir: "/workspace/repo", present: false });
    expect(await sandbox.checkoutDir()).toBe("/workspace/repo");
    expect((await sandbox.fake()).starts).toBe(0);
    // A scratchpad is a checkout like any other.
    await sandbox.noteCheckout({ dir: "/workspace/scratch", kind: "scratch" });
    expect(await sandbox.checkoutDir()).toBe("/workspace/scratch");
    await sandbox.noteCheckout({ dir: "/workspace/repo", kind: "repo" });
    // A running one is asked once it is prepared: a `.git` gone is no checkout.
    await sandbox.ensureRunning();
    await sandbox.answer("test -d /workspace/repo/.git", "", 1);
    expect(await sandbox.checkoutDir()).toBeUndefined();
    // Before then, a start may still be restoring it: the record answers.
    await runInDurableObject(sandbox, async (_, state) => {
      await state.storage.delete("sandbox:runtime-ready");
    });
    expect(await sandbox.checkoutDir()).toBe("/workspace/repo");
  });

  it("installs nothing a finished install already put on this disk", async () => {
    const sandbox = freshSandbox("current");
    await sandbox.answer("cat ", "{}");
    const key = await installKey("/workspace/a", { HOST_ENV: "host" });
    // The mark names the tree it was made for, and this one is that tree.
    await sandbox.answer(
      "/var/lib/da/installs/%2Fworkspace%2Fa",
      `11\n11 ${key}`
    );
    expect(await sandbox.startInstall({ dir: "/workspace/a" })).toMatchObject({
      state: "done",
      ms: 0
    });
    expect(
      joined((await sandbox.fake()).execs).some((cmd) =>
        cmd.includes("timeout --kill-after=10 ")
      )
    ).toBe(false);
    // Changed files install again, unmarked until the install finishes.
    await sandbox.answer(
      "/var/lib/da/installs/%2Fworkspace%2Fa",
      "11\n11 stale"
    );
    expect((await sandbox.startInstall({ dir: "/workspace/a" })).state).toBe(
      "running"
    );
    const execs = joined((await sandbox.fake()).execs);
    const unmarked = execs.findIndex(
      (cmd) =>
        cmd.startsWith("rm -f ") &&
        cmd.includes("/var/lib/da/installs/%2Fworkspace%2Fa")
    );
    const launched = execs.findIndex((cmd) =>
      cmd.includes("timeout --kill-after=10 ")
    );
    expect(unmarked).toBeGreaterThanOrEqual(0);
    expect(launched).toBeGreaterThan(unmarked);
  });

  it.each([
    // Removed and made again, by an install that failed part-way: another tree.
    ["a tree the mark was not made for", "12\n11 {key}", { HOST_ENV: "host" }],
    // `NODE_ENV` and its like change what an install installs.
    ["a tree installed under another environment", "11\n11 {key}", {}]
  ])("installs again over %s", async (_what, mark, markedEnv) => {
    const sandbox = freshSandbox("replaced");
    await sandbox.answer("cat ", "{}");
    const key = await installKey("/workspace/a", markedEnv);
    await sandbox.answer(
      "/var/lib/da/installs/%2Fworkspace%2Fa",
      mark.replace("{key}", key)
    );
    expect((await sandbox.startInstall({ dir: "/workspace/a" })).state).toBe(
      "running"
    );
  });

  it(
    "checkpoints an install that finished, when the next in the queue finds its tree current",
    { timeout: 45_000 },
    async () => {
      const sandbox = freshSandbox("owed");
      await sandbox.answer("cat ", "{}");
      const key = await installKey("/workspace/b", { HOST_ENV: "host" });
      await sandbox.answer(
        "/var/lib/da/installs/%2Fworkspace%2Fb",
        `22\n22 ${key}`
      );
      expect((await sandbox.startInstall({ dir: "/workspace/a" })).state).toBe(
        "running"
      );
      await sandbox.startInstall({ dir: "/workspace/b" });
      // The first install exits 0 when its poll next reads it.
      await sandbox.answer(".exit 2>/dev/null; echo", "0\n");
      await sandbox.answer("stat -c %i /workspace/a/node_modules", "11");
      const fake = await eventually(
        () => sandbox.fake(),
        (state) => state.snapshots > 0,
        40_000
      );
      expect(fake.snapshots).toBe(1);
      expect(await sandbox.snapshotRecord()).toBeDefined();
    }
  );

  it("installs one checkout at a time, under the plan's limit", async () => {
    const sandbox = freshSandbox("installs");
    await sandbox.answer("cat ", "{}");
    const first = await sandbox.startInstall({ dir: "/workspace/a" });
    expect(first.state).toBe("running");
    const second = await sandbox.startInstall({ dir: "/workspace/b" });
    expect(second).toEqual(first);
    const installs = joined((await sandbox.fake()).execs).filter((cmd) =>
      cmd.includes("timeout --kill-after=10 1200 ")
    );
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("/workspace/a");
    // The host's environment, and no egress rule's.
    expect(installs[0]).toContain("HOST_ENV=host");
    // A checkout's files may be the agent's symlinks: never read as root.
    const reads = joined((await sandbox.fake()).execs).filter((cmd) =>
      cmd.includes("cat ")
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(/^\/usr\/bin\/setpriv /);
  });
});

describe("egress", () => {
  it("routes a rule's host to its handler, which reaches back to the sandbox the request came from", async () => {
    const sandbox = freshHttpsSandbox("through");
    await sandbox.answer("update-ca-certificates", "TRUSTED");
    await sandbox.ensureRunning();
    const answer = JSON.parse(
      await sandbox.throughEgress("https://api.example.com/repos?page=2")
    ) as { target: string; sandbox: string | null };
    expect(answer.target).toBe("https://api.example.com/v1/repos?page=2");
    expect(answer.sandbox).toBe(await sandbox.whoami());
    expect(answer.sandbox).not.toBeNull();
  });

  it("gives the rules' environment to the CLI's container and to every command, over the command's own", async () => {
    const sandbox = freshHttpsSandbox("env");
    await sandbox.answer("update-ca-certificates", "TRUSTED");
    await sandbox.exec(["true"], { env: { PROBE_TOKEN: "mine", OTHER: "1" } });
    const fake = await sandbox.fake();
    expect(fake.startEnv.PROBE_TOKEN).toBe("placeholder");
    const command = fake.execs.at(-1) ?? [];
    expect(command).toContain("PROBE_TOKEN=placeholder");
    expect(command).not.toContain("PROBE_TOKEN=mine");
    expect(command).toContain("OTHER=1");
    expect(command).toContain("HOST_ENV=host");
  });

  it("registers HTTPS hosts per container, with the CA trusted before the marker is written", async () => {
    const sandbox = freshHttpsSandbox("https");
    await sandbox.answer("update-ca-certificates", "TRUSTED");
    const { runtimeId } = await sandbox.ensureRunning();
    const fake = await sandbox.fake();
    expect(fake.httpsHosts).toEqual(["api.example.com"]);
    expect(fake.httpHosts).toEqual([]);
    const execs = joined(fake.execs);
    const trust = execs.findIndex((cmd) =>
      cmd.includes("update-ca-certificates")
    );
    const marker = execs.findIndex((cmd) => cmd.includes(EGRESS_READY));
    expect(trust).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(trust);
    expect(execs[marker]).toContain(runtimeId);
  });

  it("refuses to call a container ready whose CA did not take", async () => {
    const sandbox = freshHttpsSandbox("untrusted");
    await sandbox.answer(
      "update-ca-certificates",
      "NO CA AT /etc/cloudflare/certs/cloudflare-containers-ca.crt"
    );
    await runInDurableObject(sandbox, async (instance) => {
      await expect(instance.ensureRunning()).rejects.toThrow(/not trusted/);
    });
  });
});

describe("files", () => {
  it("serves nothing outside /workspace, and starts no container to refuse", async () => {
    const sandbox = freshSandbox("confine");
    await runInDurableObject(sandbox, async (instance) => {
      await expect(instance.readFile("/proc/1/environ")).rejects.toThrow(
        /outside \/workspace/
      );
      await expect(instance.createRun("run", { cwd: "/etc" })).rejects.toThrow(
        /outside \/workspace/
      );
    });
    expect((await sandbox.fake()).starts).toBe(0);
  });
});
