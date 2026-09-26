import { describe, expect, it } from "vitest";
import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle
} from "@cloudflare/computer";
import {
  CLOSE_SCRIPT,
  COPY_ROOT,
  OPEN_SCRIPT,
  WORKSPACE_MOUNT,
  closeCopy,
  copyDirFor,
  copyNote,
  openCopy
} from "./copy.js";
import { READ_ONLY_LAUNCH, type SessionRuntime } from "./run.js";

type Event = WorkspaceRuntimeEvent<"utf8">;

/** A finished exec that printed `out` and exited with `code`. */
function finished(id: string, out: string, code = 0, err = "") {
  const events: Event[] = [
    { id, seq: 1, name: "stdout", value: out },
    ...(err ? [{ id, seq: 2, name: "stderr", value: err } as Event] : []),
    { id, seq: 3, name: "exit", code }
  ];
  const stream = new ReadableStream<Event>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    }
  });
  return Object.assign(stream, {
    id,
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
}

interface Call {
  source: string;
  options: {
    id?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  };
}

/** A runtime whose `exec` answers from `reply`, recording every call. */
function recorder(reply: (call: Call) => WorkspaceRuntimeExecHandle<"utf8">) {
  const calls: Call[] = [];
  const runtime = {
    exec: async (source: string, options: Call["options"]) => {
      const call = { source, options };
      calls.push(call);
      return reply(call);
    },
    getExec: async () => {
      throw new Error("not called");
    },
    killExec: async () => {}
  } as unknown as SessionRuntime;
  return { calls, runtime };
}

const READY =
  "tree=/var/tmp/claude-read/claude-code-run_3/tree\ndeps=2/2\nupper=disk\nisolated=yes\n";

describe("where a copy lives", () => {
  /**
   * Anything under the workspace mount is synced back into the Durable Object
   * and read by the parent and every other reader at once — which is the whole
   * reason for a copy.
   */
  it("is on container disk, never under the workspace mount", () => {
    expect(COPY_ROOT.startsWith(WORKSPACE_MOUNT)).toBe(false);
    expect(copyDirFor("claude-code-run:3").startsWith(`${COPY_ROOT}/`)).toBe(
      true
    );
  });

  it("is one path segment per session, whatever the exec id holds", () => {
    expect(copyDirFor("claude-code-run:3")).toBe(
      `${COPY_ROOT}/claude-code-run_3`
    );
    expect(copyDirFor("../../etc")).toBe(`${COPY_ROOT}/.._.._etc`);
  });
});

describe("openCopy", () => {
  it("hands the script its paths through the environment, never the source", async () => {
    const { calls, runtime } = recorder((call) =>
      finished(call.options.id ?? "", READY)
    );

    const copy = await openCopy(runtime, {
      execId: "claude-code-run:3",
      source: "/workspace/dev-agents/",
      timeoutMs: 15 * 60_000
    });

    expect(copy).toEqual({
      dir: "/var/tmp/claude-read/claude-code-run_3/tree",
      source: "/workspace/dev-agents",
      deps: { laid: 2, found: 2 },
      isolated: true
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe(OPEN_SCRIPT);
    expect(calls[0]?.options).toMatchObject({
      id: "claude-code-run:3:copy",
      cwd: "/",
      env: {
        SRC: "/workspace/dev-agents",
        COPY: `${COPY_ROOT}/claude-code-run_3`,
        COPY_ROOT,
        // The session ceiling plus the sweep margin, in minutes.
        STALE_MIN: "30",
        // The probe runs the same script the launch will.
        WORKSPACE: WORKSPACE_MOUNT,
        READ_ONLY_LAUNCH
      }
    });
  });

  /**
   * Falling back to the parent's tree is the one thing a reading session must
   * never do, so a copy that could not be made fails the session instead.
   */
  it("throws with the script's own words when it cannot make one", async () => {
    const { runtime } = recorder((call) =>
      finished(call.options.id ?? "", "", 1, "fatal: not a git repository")
    );

    await expect(
      openCopy(runtime, {
        execId: "claude-code-run:3",
        source: "/workspace/r",
        timeoutMs: 60_000
      })
    ).rejects.toThrow(/could not make a copy.*not a git repository/s);
  });

  it("treats an exit 0 that named no copy as a failure", async () => {
    const { runtime } = recorder((call) =>
      finished(call.options.id ?? "", "nothing useful\n")
    );

    await expect(
      openCopy(runtime, {
        execId: "claude-code-run:3",
        source: "/workspace/r",
        timeoutMs: 60_000
      })
    ).rejects.toThrow(/could not make a copy/);
  });

  /**
   * A recovered turn finds the first attempt's script still running. Two of them
   * building one copy would each delete what the other was making, so the retry
   * waits on the first instead.
   */
  /**
   * A session that could write the original through an absolute path is only
   * held back by its brief, so a copy that could not get the namespace says so.
   */
  it("reports a container that refused the read-only namespace", async () => {
    const { runtime } = recorder((call) =>
      finished(
        call.options.id ?? "",
        READY.replace("isolated=yes", "isolated=no")
      )
    );

    const copy = await openCopy(runtime, {
      execId: "claude-code-run:3",
      source: "/workspace/r",
      timeoutMs: 60_000
    });

    expect(copy.isolated).toBe(false);
  });

  it("waits on a copy a previous attempt is still making", async () => {
    const attached: string[] = [];
    const runtime = {
      exec: async () => {
        throw Object.assign(new Error("busy"), { code: "EEXEC_BUSY" });
      },
      getExec: async (id: string) => {
        attached.push(id);
        return finished(id, READY);
      },
      killExec: async () => {}
    } as unknown as SessionRuntime;

    const copy = await openCopy(runtime, {
      execId: "claude-code-run:3",
      source: "/workspace/r",
      timeoutMs: 60_000
    });

    expect(attached).toEqual(["claude-code-run:3:copy"]);
    expect(copy.dir).toBe("/var/tmp/claude-read/claude-code-run_3/tree");
  });
});

describe("closeCopy", () => {
  it("deletes this session's copy and no other", async () => {
    const { calls, runtime } = recorder((call) =>
      finished(call.options.id ?? "", "")
    );

    await closeCopy(runtime, "claude-code-run:3");

    expect(calls[0]?.source).toBe(CLOSE_SCRIPT);
    expect(calls[0]?.options.env).toEqual({
      COPY: `${COPY_ROOT}/claude-code-run_3`
    });
  });

  /** It runs on the way out of a session that already ended. */
  it("never throws, even when the container cannot be reached", async () => {
    const runtime = {
      exec: async () => {
        throw new Error("container unreachable");
      },
      getExec: async () => {
        throw new Error("not called");
      },
      killExec: async () => {}
    } as unknown as SessionRuntime;

    await expect(
      closeCopy(runtime, "claude-code-run:3")
    ).resolves.toBeUndefined();
  });
});

/**
 * What the scripts must hold, checked by shape because workerd has no shell. The
 * behaviour behind each line is in `./copy.ts`.
 */
describe("the scripts", () => {
  it("borrow the parent's objects rather than copying them", () => {
    expect(OPEN_SCRIPT).toContain("objects/info/alternates");
    expect(OPEN_SCRIPT).toContain("submodule foreach --quiet --recursive");
  });

  /** A copy of HEAD alone would answer questions about code nobody has. */
  it("carry the parent's uncommitted changes to tracked files", () => {
    expect(OPEN_SCRIPT).toContain("diff --binary --ignore-submodules=all HEAD");
    expect(OPEN_SCRIPT).toContain("apply --binary");
  });

  it("probe the namespace with the script the launch runs", () => {
    expect(OPEN_SCRIPT).toContain(
      'sh -c "$READ_ONLY_LAUNCH" sh test ! -w "$SRC"'
    );
  });

  it("lay dependency trees as overlays, never as bind mounts of the parent's", () => {
    expect(OPEN_SCRIPT).toContain("mount -t overlay overlay");
    expect(OPEN_SCRIPT).not.toContain("mount --bind");
  });

  it("never delete through a mount that is still attached", () => {
    for (const script of [OPEN_SCRIPT, CLOSE_SCRIPT]) {
      expect(script).toContain("still has a mount attached");
      expect(script).toContain("umount -l");
    }
  });
});

describe("copyNote", () => {
  const copy = {
    dir: "/var/tmp/claude-read/claude-code-run_3/tree",
    source: "/workspace/r",
    deps: { found: 1, laid: 1 },
    isolated: true
  };

  it("says the final message is the deliverable", () => {
    expect(copyNote(copy)).toMatch(
      /final message is the whole of what you deliver/
    );
    expect(copyNote(copy)).not.toMatch(/Install them/);
  });

  /** A brief that names the original by absolute path has to be translatable. */
  it("maps the original's paths onto the copy", () => {
    expect(copyNote(copy)).toContain(
      "`/workspace/r` itself is read-only to you. Where your brief names a path under it, use the same path under `/var/tmp/claude-read/claude-code-run_3/tree`."
    );
  });

  it("asks a session with no namespace not to write the original", () => {
    expect(copyNote({ ...copy, isolated: false })).toContain(
      "**Do not write under `/workspace/r`**"
    );
  });

  it("says when the dependency trees did not come across", () => {
    expect(copyNote({ ...copy, deps: { found: 2, laid: 0 } })).toMatch(
      /were not carried into this copy/
    );
    expect(copyNote({ ...copy, deps: { found: 2, laid: 1 } })).toMatch(
      /Some dependency trees/
    );
  });
});
