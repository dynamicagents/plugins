import { describe, expect, it, vi } from "vitest";
import { shellQuote } from "@cloudflare/computer";
import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle
} from "@cloudflare/computer";
import {
  attachRun,
  buildLaunch,
  drainRun,
  execIdFor,
  freshCursor,
  startRun,
  CREDENTIAL_PLACEHOLDER,
  SESSION_CONFIG_DIR,
  type DrainCursor,
  type DrainOutcome,
  type SessionRuntime
} from "./run.js";
import { DEFAULT_PERMISSION_MODE } from "./config.js";
import { FORGE_PLACEHOLDER } from "./forge.js";
import { SESSION_STATE_DIR } from "../computer/paths.js";

const EXEC = execIdFor("run-7");
const FRESH = freshCursor(EXEC);

/**
 * Launching and draining, and the failure that is invisible until production:
 * a cursor that does not carry loses whichever line a stopped drain happened
 * to cut in half — which for a stream of one-JSON-object-per-line is a whole
 * event, silently.
 */

/** A drain that stops itself after `ms`, as a cancelled turn's would. */
const stopAfter = (ms: number) => ({ signal: AbortSignal.timeout(ms) });

type Event = WorkspaceRuntimeEvent<"utf8">;

const stdout = (seq: number, value: string): Event => ({
  id: EXEC,
  seq,
  name: "stdout",
  value
});

const exit = (seq: number, code: number): Event => ({
  id: EXEC,
  seq,
  name: "exit",
  code
});

const stderrOut = (seq: number, value: string): Event => ({
  id: EXEC,
  seq,
  name: "stderr",
  value
});

/**
 * A handle over a fixed script of events. `open: true` leaves the stream running
 * after the script, which is what a session still thinking looks like.
 */
function fakeHandle(
  script: readonly Event[],
  open = false
): WorkspaceRuntimeExecHandle<"utf8"> {
  const stream = new ReadableStream<Event>({
    start(controller) {
      for (const event of script) controller.enqueue(event);
      if (!open) controller.close();
    }
  });
  return Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
}

/**
 * A handle whose stream stays open until the test closes it.
 *
 * {@link fakeHandle} enqueues a fixed script, so a drain over it either ends
 * immediately or waits until it is stopped — neither of which lets a test look
 * at a drain *while it is running*. This one can be ended on demand, which is
 * what makes the mid-flight assertions below deterministic rather than a race
 * against a short timer.
 */
function liveHandle(script: readonly Event[]): {
  handle: WorkspaceRuntimeExecHandle<"utf8">;
  end: (seq: number, code: number) => void;
} {
  let controller!: ReadableStreamDefaultController<Event>;
  const stream = new ReadableStream<Event>({
    start(c) {
      controller = c;
      for (const event of script) c.enqueue(event);
    }
  });
  const handle = Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;

  return {
    handle,
    end: (seq, code) => {
      controller.enqueue(exit(seq, code));
      controller.close();
    }
  };
}

/**
 * A handle whose stream breaks once its script is read, as a cut RPC stream
 * does. Pulled one event per read, because `controller.error` discards whatever
 * is still queued.
 */
function brokenHandle(script: readonly Event[]): {
  handle: WorkspaceRuntimeExecHandle<"utf8">;
  reads: () => number;
} {
  let reads = 0;
  const stream = new ReadableStream<Event>(
    {
      pull(controller) {
        const event = script[reads++];
        if (event) controller.enqueue(event);
        else
          controller.error(
            new Error(
              "ReadableStream received over RPC disconnected prematurely."
            )
          );
      }
    },
    { highWaterMark: 0 }
  );
  const handle = Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
  return { handle, reads: () => reads };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
/** The line that names the session, which the CLI emits within seconds. */
const initLine = (sessionId: string) =>
  line({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "opus"
  });
const RESULT_LINE = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 1.25,
  usage: { output_tokens: 900 }
});

/**
 * Walk a POSIX-ish command and yield the characters the shell would see
 * *outside* any quoting, so a test can assert what the shell actually gets
 * rather than what the string happens to contain.
 */
function* unquotedPositions(command: string): Generator<[number, string]> {
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    // A backslash escapes the next character everywhere except inside single
    // quotes. Missing this reads POSIX's `'\''` idiom — which is how
    // `shellQuote` embeds a quote — as *closing* the quoting, and then the rest
    // of a perfectly safe argument looks unquoted.
    if (ch === "\\" && !single) {
      i++;
      continue;
    }
    if (ch === "'" && !double) {
      single = !single;
      continue;
    }
    if (ch === '"' && !single) {
      double = !double;
      continue;
    }
    if (!single && !double) yield [i, ch];
  }
}

describe("buildLaunch", () => {
  const launch = (over = {}) =>
    buildLaunch({ prompt: "fix the bug", dir: "/workspace/repo", ...over });

  it("streams, and asks for the verbose form that actually streams", () => {
    // Without `--verbose`, stream-json emits only the final result — which would
    // make every progress note in this package arrive at once, at the end.
    expect(launch().command).toContain("--output-format stream-json --verbose");
  });

  it("passes a JSON Schema as one quoted argument, and nothing without one", () => {
    // A quote in the schema is the case the quoting exists for.
    const schema = {
      type: "object",
      properties: { "it's": { type: "string" } }
    };
    expect(launch({ jsonSchema: schema }).command).toContain(
      `--json-schema ${shellQuote(JSON.stringify(schema))}`
    );
    expect(launch().command).not.toContain("--json-schema");
  });

  describe("continuing a conversation", () => {
    it("resumes the id it is given, and forks only when asked", () => {
      expect(launch({ resume: "sess-7" }).command).toContain("--resume sess-7");
      // A continuation of the same kind accumulates in one conversation, which
      // is what `continue` means — the fork is for the kind changing.
      expect(launch({ resume: "sess-7" }).command).not.toContain(
        "--fork-session"
      );
      expect(launch({ resume: "sess-7", fork: true }).command).toContain(
        "--resume sess-7 --fork-session"
      );
    });

    /**
     * Dropped, the flag would leave a session that started a conversation of
     * its own and reported itself as the continuation of somebody else's.
     */
    it("refuses a fork with no conversation to fork", () => {
      expect(() => launch({ fork: true })).toThrow(
        /needs the .resume. session/
      );
    });

    /**
     * The id arrives from storage, and an empty one is what a host that never
     * recorded a handle has. Dropped, `--resume` would go missing and the run
     * would be a fresh conversation answering a prompt written as the next turn
     * of one the caller believes is still going.
     */
    it("refuses an empty id rather than starting a fresh session", () => {
      expect(() => launch({ resume: "" })).toThrow(/cannot be empty/);
      expect(() => launch({ resume: "", fork: true })).toThrow(
        /cannot be empty/
      );
    });

    /**
     * Under the workspace mount, so a conversation outlives its container — and
     * the same for every session, since a later run finds a transcript only
     * where it was written.
     */
    it("keeps every session's state in the workspace, in one place", () => {
      expect(SESSION_CONFIG_DIR).toBe("/workspace/.claude-sessions");
      expect(launch().env.CLAUDE_CONFIG_DIR).toBe(SESSION_CONFIG_DIR);
      expect(
        launch({ resume: "sess-1", fork: true, permissionMode: "plan" }).env
          .CLAUDE_CONFIG_DIR
      ).toBe(SESSION_CONFIG_DIR);
    });

    /**
     * Two subpaths spell the name — `/claude-code` writes there and
     * `/computer`'s walk steps over it — and neither may import the other.
     */
    it("names the directory the file tools' walk steps over", () => {
      expect(SESSION_CONFIG_DIR).toBe(`/workspace/${SESSION_STATE_DIR}`);
    });

    /** A deployment-wide `env` must not answer where a transcript goes. */
    it("refuses a host's environment that would move it", () => {
      expect(() =>
        launch({ env: { CLAUDE_CONFIG_DIR: "/root/.claude" } })
      ).toThrow(/CLAUDE_CONFIG_DIR cannot be set through `env`/);
    });
  });

  it("launches claude itself, in the exec's own directory", () => {
    expect(launch().command.startsWith("claude -p ")).toBe(true);
  });

  /**
   * The prompt is model-authored, so the only thing worth asserting is the
   * property a substring check cannot see: that every shell metacharacter ends
   * up *inside* a quoted token. `; rm -rf /` appearing in the command string is
   * fine and expected — what would not be fine is the shell reaching it.
   */
  it("leaves no shell metacharacter unquoted in the prompt", () => {
    const { command } = launch({ prompt: `it's "broken"; rm -rf / && id` });

    for (const [index, at] of unquotedPositions(command)) {
      expect(
        ";&|`$(){}<>".includes(at),
        `unquoted ${at} at ${index} in: ${command}`
      ).toBe(false);
    }
    // And the flags after it are still their own tokens.
    expect(command).toContain(" --output-format stream-json --verbose");
  });

  /**
   * A session commits in repositories nothing configured — a superproject's
   * submodules, a scratch clone — and amends and rebases in the one that is
   * configured. The environment is what every git it starts inherits, and it
   * outranks a checkout's own config.
   */
  it("attributes the session's commits to the configured identity", () => {
    const { env } = launch({
      author: { name: "coder", email: "coder@example.invalid" }
    });
    expect(env.GIT_AUTHOR_NAME).toBe("coder");
    expect(env.GIT_AUTHOR_EMAIL).toBe("coder@example.invalid");
    // Both halves: an amend keeps the author and stamps a fresh committer.
    expect(env.GIT_COMMITTER_NAME).toBe("coder");
    expect(env.GIT_COMMITTER_EMAIL).toBe("coder@example.invalid");
  });

  it("names no identity when the host configured none", () => {
    expect(Object.keys(launch().env)).not.toContain("GIT_AUTHOR_NAME");
  });

  /**
   * The four keys are one answer or they are nothing. A host that set part of
   * the identity through `env` and the rest through `author` would produce a
   * commit attributed to two people — the failure `author` exists to end.
   */
  it("keeps the identity whole against a host's own GIT_ keys", () => {
    const { env } = launch({
      author: { name: "coder", email: "coder@example.invalid" },
      env: { GIT_AUTHOR_NAME: "somebody else" }
    });
    expect(env.GIT_AUTHOR_NAME).toBe("coder");
    expect(env.GIT_COMMITTER_NAME).toBe("coder");
  });

  /** And a host that names no identity still gets its own keys through. */
  it("leaves a host's GIT_ keys alone when it configured no identity", () => {
    const { env } = launch({ env: { GIT_AUTHOR_NAME: "somebody else" } });
    expect(env.GIT_AUTHOR_NAME).toBe("somebody else");
  });

  it("passes the placeholder credential and never a real one", () => {
    expect(launch().env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
  });

  /**
   * The transparent intercept is what makes this absent, and its absence is the
   * point: nothing in the container is *told* to use a proxy, so nothing in the
   * container can be told not to.
   */
  it("sets no ANTHROPIC_BASE_URL — egress is intercepted, not configured", () => {
    expect(Object.keys(launch().env)).not.toContain("ANTHROPIC_BASE_URL");
  });

  /**
   * A repository's `CLAUDE.md`, skills and hooks are what make the agent good at
   * that repository, and the
   * container already runs the repo's `postinstall` and its test suite — so
   * stripping one door while the others stand open costs context and buys
   * nothing.
   */
  it("runs the repository's own configuration rather than suppressing it", () => {
    const { command, env } = launch();
    expect(command).not.toContain("--bare");
    expect(command).not.toContain("--settings");
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    // The client's own state moves; the checkout's `.claude/` is untouched.
    expect(env.CLAUDE_CONFIG_DIR).toBe(SESSION_CONFIG_DIR);
  });

  it("pins the version by refusing to autoupdate mid-run", () => {
    expect(launch().env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("caps the inner subagent tree when asked", () => {
    const { env } = launch({ maxSubagentDepth: 1, maxConcurrentSubagents: 4 });
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("4");
  });

  it("omits the caps entirely rather than inventing a default", () => {
    expect(launch().env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"
    );
  });

  it("adds the model only when given", () => {
    expect(launch().command).not.toContain("--model");
    expect(launch({ model: "claude-opus-5" }).command).toContain(
      "--model claude-opus-5"
    );
  });

  /**
   * Handed one anyway, through a helper loose enough to accept it — otherwise
   * this passes against an implementation that still emits the flag. The README
   * says why the package does not offer it.
   */
  it("never passes a turn ceiling, whatever it is handed", () => {
    expect(launch({ maxTurns: 30 }).command).not.toContain("--max-turns");
  });

  /**
   * Unset has to mean *absent*, not a level this package chose. An unrecognised
   * or unsupported effort is warned about on stderr and then ignored, so a
   * wrong default here would be indistinguishable from no default at all —
   * see `ClaudeCodeConfig.effort`.
   */
  describe("the effort level", () => {
    it("is omitted entirely when unset, leaving the model's own default", () => {
      expect(launch().command).not.toContain("--effort");
    });

    it("carries a host's level through", () => {
      expect(launch({ effort: "xhigh" }).command).toContain("--effort xhigh");
    });

    it("passes the level unquoted, as the flag's own enum", () => {
      expect(
        launch({ model: "claude-opus-5", effort: "max" }).command
      ).toContain("--model claude-opus-5 --effort max");
    });
  });

  it("lets a host add environment, merged last", () => {
    const { env } = launch({ env: { CI: "1", DISABLE_AUTOUPDATER: "0" } });
    expect(env.CI).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("0");
  });

  /**
   * The whole point of the option. `-p` is headless, so a mode that would prompt
   * auto-denies instead — a session left on the default reads the repository
   * perfectly and cannot write to it.
   */
  describe("the permission mode", () => {
    it("is always passed, so headless never falls back to auto-deny", () => {
      expect(launch().command).toContain(
        `--permission-mode ${DEFAULT_PERMISSION_MODE}`
      );
    });

    it("defaults to the only mode that can edit a checkout", () => {
      expect(DEFAULT_PERMISSION_MODE).toBe("bypassPermissions");
    });

    it("carries a host's choice through instead", () => {
      expect(launch({ permissionMode: "acceptEdits" }).command).toContain(
        "--permission-mode acceptEdits"
      );
    });

    /**
     * The root guard, and the reason these two live in one branch.
     *
     * The container runs as uid 0, and the CLI exits 1 — before its first JSON
     * line, explaining itself only on stderr — if asked to bypass permissions
     * under root without this. The flag alone is a worse failure than no flag.
     */
    it("clears the root guard whenever it bypasses", () => {
      expect(launch().env.IS_SANDBOX).toBe("1");
      expect(
        launch({ permissionMode: "bypassPermissions" }).env.IS_SANDBOX
      ).toBe("1");
    });

    it("sets nothing for a mode that does not need it", () => {
      for (const mode of ["default", "acceptEdits", "plan", "auto"] as const) {
        expect(launch({ permissionMode: mode }).env).not.toHaveProperty(
          "IS_SANDBOX"
        );
      }
    });

    /**
     * `env` is merged last so a deployment can add what a repository needs, and
     * that merge is exactly how this could be switched off from a config file —
     * silently, leaving a session that exits 1 for a reason nothing reports.
     */
    it("is not something a host's own environment can unset", () => {
      const { env } = launch({ env: { IS_SANDBOX: "0" } });
      expect(env.IS_SANDBOX).toBe("1");
    });
  });
});

describe("drainRun", () => {
  /**
   * A thinking block is timed by when its lines reach the drain: its first
   * `thinking_tokens` line, then its own. The start can arrive before a cut and
   * the block after it, so the cursor carries the start.
   */
  describe("timing a thinking block", () => {
    const T0 = Date.parse("2026-10-06T08:31:00.000Z");
    const tokens = line({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 50,
      estimated_tokens_delta: 50
    });
    const thinking = (ms: number) =>
      line({
        type: "assistant",
        timestamp: new Date(T0 + ms).toISOString(),
        message: {
          id: "msg_1",
          content: [{ type: "thinking", thinking: "private" }]
        }
      });
    /** A handle that sets the drain's clock to each event's time as it is read. */
    const timed = (script: [Event, number][]) => {
      let clock = T0;
      const stream = new ReadableStream<Event>(
        {
          pull(controller) {
            const next = script.shift();
            if (!next) return controller.close();
            clock = T0 + next[1];
            controller.enqueue(next[0]);
          }
        },
        { highWaterMark: 0 }
      );
      const handle = Object.assign(stream, {
        id: EXEC,
        backend: "container",
        result: async () => {
          throw new Error("not used by the drain");
        },
        kill: async () => {},
        [Symbol.dispose]: () => {}
      }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
      return { handle, now: () => clock };
    };

    it("times it from its first token line to its own line", async () => {
      const { handle, now } = timed([
        [stdout(1, tokens), 1_000],
        [stdout(2, thinking(4_000)), 4_000],
        [exit(3, 0), 4_001]
      ]);
      const outcome = await drainRun(handle, FRESH, { now });
      expect(outcome.progress.map((p) => p.text)).toEqual(["Thought for 3s"]);
      expect(outcome.cursor.thinkingFrom).toBeUndefined();
    });

    it("carries a pending start on its cursor, and times from it after a resume", async () => {
      const first = timed([
        [stdout(1, tokens), 1_000],
        [exit(2, 0), 1_001]
      ]);
      const cut = await drainRun(first.handle, FRESH, { now: first.now });
      expect(cut.cursor.thinkingFrom).toBe(T0 + 1_000);

      const second = timed([
        [stdout(3, thinking(5_000)), 5_000],
        [exit(4, 0), 5_001]
      ]);
      const resumed = await drainRun(second.handle, cut.cursor, {
        now: second.now
      });
      expect(resumed.progress.map((p) => p.text)).toEqual(["Thought for 4s"]);
    });
  });

  it("reports the run done on the exit event, with its result", async () => {
    const handle = fakeHandle([
      stdout(1, assistant("working")),
      stdout(2, RESULT_LINE),
      exit(3, 0)
    ]);

    const outcome = await drainRun(handle, FRESH);

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.costUsd).toBe(1.25);
    expect(outcome.cursor.seq).toBe(3);
    // The narration, then the session's end as a card.
    expect(outcome.progress.map((p) => p.key)).toEqual([
      "claude:0",
      "claude:1"
    ]);
  });

  /**
   * A session with nothing to say yet is still running: the drain waits on it
   * rather than reporting it finished, until it ends or is stopped.
   */
  it("reads until it is stopped while the session is still going", async () => {
    const handle = fakeHandle([stdout(1, assistant("thinking"))], true);
    const started = Date.now();

    const outcome = await drainRun(handle, FRESH, stopAfter(60));

    expect(outcome.done).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(outcome.progress).toHaveLength(1);
    expect(outcome.cursor.seq).toBe(1);
  });

  /**
   * A stopped drain can cut a line in half, and for a stream of one JSON
   * object per line that is a whole event. The carry is what makes the next
   * drain able to finish it.
   */
  it("carries a half-read line into the next drain", async () => {
    const whole = assistant("a complete thought");
    const cut = Math.floor(whole.length / 2);

    const first = await drainRun(
      fakeHandle([stdout(1, whole.slice(0, cut))], true),
      FRESH,
      stopAfter(40)
    );
    expect(first.progress).toHaveLength(0);
    expect(first.cursor.carry).toBe(whole.slice(0, cut));

    const second = await drainRun(
      fakeHandle([stdout(2, whole.slice(cut))], true),
      first.cursor,
      stopAfter(40)
    );
    expect(second.progress.map((p) => p.text)).toEqual(["a complete thought"]);
  });

  /**
   * Note keys are positional, so the count has to survive a resumed drain or
   * the second restarts at `claude:0` and the transcript drops every note as a
   * duplicate of one it already has.
   */
  it("continues the note numbering across drains", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, assistant("one") + assistant("two"))], true),
      FRESH,
      stopAfter(40)
    );
    expect(first.cursor.emitted).toBe(2);

    const second = await drainRun(
      fakeHandle([stdout(2, assistant("three")), exit(3, 0)]),
      first.cursor
    );
    expect(second.progress.map((p) => p.key)).toEqual(["claude:2"]);
  });

  /**
   * The stream ending with no `exit` means the container went away under the
   * run. Reporting it as still-running would make the caller wait on a dead
   * process.
   */
  it("treats a stream that ends without an exit event as a failure", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, assistant("half a job"))]),
      FRESH
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.result).toBeUndefined();
  });

  /**
   * What the process printed is not why it ended, and reported alone it reads
   * as the cause.
   */
  it("says a signal ended a session that reported nothing", async () => {
    const warning =
      "Ignoring 3 permissions.allow entries from .claude/settings.json";
    const outcome = await drainRun(
      fakeHandle([stderrOut(1, `${warning}\n`), exit(2, 143)]),
      FRESH
    );

    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(143);
    expect(outcome.stderr).toMatch(/^the process was stopped by SIGTERM/);
    expect(outcome.stderr).toContain(`which is not why it ended:\n${warning}`);
  });

  it("says the container went, ahead of what the process had printed", async () => {
    const warning =
      "Ignoring 3 permissions.allow entries from .claude/settings.json";
    const outcome = await drainRun(
      fakeHandle([stderrOut(1, `${warning}\n`)]),
      FRESH
    );

    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.stderr).toMatch(/^the container holding this session/);
    expect(outcome.stderr).toContain(`which is not why it ended:\n${warning}`);
  });

  /**
   * A caller may re-attach on a broken stream's error, so this drain's notes
   * must not still be landing behind the next drain's — the error waits for
   * them, as an outcome does.
   */
  it("files its queued notes before a broken stream's error leaves", async () => {
    const { handle, reads } = brokenHandle([
      stdout(1, assistant("half a job"))
    ]);
    let release!: () => void;
    const posted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filed: string[] = [];
    let settled = false;

    const drained = drainRun(handle, FRESH, {
      onProgress: async (note) => {
        await posted;
        filed.push(note.key);
      }
    }).finally(() => {
      settled = true;
    });

    // The stream has broken, and every microtask behind that has run.
    await vi.waitFor(() => expect(reads()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await expect(drained).rejects.toThrow(/disconnected prematurely/);
    expect(filed).toEqual(["claude:0"]);
  });

  it("resumes from a cursor without re-emitting what the last drain showed", async () => {
    const cursor: DrainCursor = {
      execId: EXEC,
      seq: 9,
      carry: "",
      emitted: 3
    };
    const outcome = await drainRun(
      fakeHandle([stdout(10, assistant("next")), exit(11, 0)]),
      cursor
    );

    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:3"]);
    expect(outcome.cursor.seq).toBe(11);
  });

  it("reports a non-zero exit without a result line", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, "some stderr-ish noise\n"), exit(2, 143)]),
      FRESH
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(143);
    expect(outcome.result).toBeUndefined();
  });

  /**
   * The failure this exists for: a CLI that rejects its own arguments prints one
   * line on stderr and exits before writing any JSON. Reported as an exit code
   * alone — which is what happened before this — the cause is unrecoverable from
   * the logs, and the operator sees only "exited with code 1".
   */
  it("keeps stderr when the process dies before reporting anything", async () => {
    const outcome = await drainRun(
      fakeHandle([stderrOut(1, "cannot be used with root/sudo\n"), exit(2, 1)]),
      FRESH
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.result).toBeUndefined();
    expect(outcome.stderr).toContain("root/sudo");
  });

  /**
   * A session that reported for itself has said everything worth saying. Its
   * stderr is the CLI's own chatter, and surfacing it beside a good report only
   * buries the report.
   */
  it("says nothing about stderr when the session reported a result", async () => {
    const outcome = await drainRun(
      fakeHandle([
        stderrOut(1, "a deprecation warning nobody needs\n"),
        stdout(2, RESULT_LINE),
        exit(3, 0)
      ]),
      FRESH
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.result).toBeDefined();
    expect(outcome.stderr).toBeUndefined();
  });

  /**
   * The death and the exit can land either side of a stopped drain, so the
   * tail rides on the cursor rather than living in one drain's locals.
   */
  it("carries stderr across a stopped drain", async () => {
    const first = await drainRun(
      fakeHandle([stderrOut(1, "first half ")], true),
      FRESH,
      stopAfter(40)
    );
    expect(first.done).toBe(false);
    expect(first.cursor.stderr).toBe("first half ");

    const outcome = await drainRun(
      fakeHandle([stderrOut(2, "second half"), exit(3, 1)]),
      first.cursor
    );

    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.stderr).toBe("first half second half");
  });

  /**
   * Bounded on every append, not once at the end: an unbounded tail is a
   * Durable Object holding whatever a runaway build decided to print.
   */
  it("bounds a runaway stderr while keeping both ends of it", async () => {
    const outcome = await drainRun(
      fakeHandle(
        [stderrOut(1, `HEAD${"x".repeat(50_000)}TAIL`), exit(2, 1)],
        false
      ),
      FRESH
    );

    if (!outcome.done) throw new Error("unreachable");
    const kept = outcome.stderr ?? "";
    expect(kept.length).toBeLessThanOrEqual(2_000);
    expect(kept.startsWith("HEAD")).toBe(true);
    expect(kept.endsWith("TAIL")).toBe(true);
  });
});

/**
 * A handle shaped like the one `@cloudflare/computer` actually returns.
 *
 * `withPostPull` wraps the runtime's event stream in a `ReadableStream` whose
 * `pull` runs the **container-to-workspace filesystem sync** when the source
 * reaches its end, and only then closes. That ordering is the whole reason the
 * drain must read past `exit`: a consumer that stops early never triggers the
 * pull, and the session's edits never reach the durable checkout.
 *
 * `cancel` deliberately does *not* run it — the real wrapper resolves its
 * outcome as `pending` on that path — which is what makes the two tests below
 * able to tell the behaviours apart.
 */
function handleWithPostPull(script: readonly Event[], open = false) {
  const state = { synced: false, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Event>({
    async pull(controller) {
      if (i < script.length) {
        controller.enqueue(script[i++]!);
        return;
      }
      // `open` models a session still thinking: the source has nothing more yet,
      // so `pull` never settles and the consumer's read stays pending until the
      // drain is stopped. Closing here instead would end the run.
      if (open) return await new Promise<void>(() => {});
      state.synced = true;
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    }
  });
  const handle = Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
  return { handle, state };
}

describe("the filesystem sync", () => {
  /**
   * The most consequential test in this file. Returning on the `exit` event
   * leaves the wrapped stream unread, so the post-exec pull never runs — the run
   * reports success and the edits are simply not in the workspace.
   */
  it("reads past exit to the end of the stream, so the workspace pull runs", async () => {
    const { handle, state } = handleWithPostPull([
      stdout(1, assistant("edited a file")),
      stdout(2, RESULT_LINE),
      exit(3, 0)
    ]);

    const outcome = await drainRun(handle, FRESH);

    expect(outcome.done).toBe(true);
    expect(state.synced).toBe(true);
  });

  /**
   * A drain stopped mid-session must *not* trigger the pull — there is
   * nothing to sync yet — but it must cancel, because merely releasing the
   * reader lock leaves the attachment and its pending read alive on the far
   * side, where the next drain finds it still subscribed.
   */
  it("cancels the attachment when it is stopped, without syncing", async () => {
    const { handle, state } = handleWithPostPull(
      [stdout(1, assistant("still working"))],
      true
    );

    const outcome = await drainRun(handle, FRESH, stopAfter(50));

    expect(outcome.done).toBe(false);
    // Cancelled, because merely releasing the reader lock leaves the attachment
    // and its pending read alive on the far side.
    expect(state.cancelled).toBe(true);
    // And not synced: there is nothing to pull back until the session ends.
    expect(state.synced).toBe(false);
  });

  /**
   * **Cancelled before the drain's notes are settled, not after.**
   *
   * Asserting cancellation once `drainRun` has resolved proves nothing about
   * the order: a drain that settled every queued note first and cancelled on
   * the way out passes that check identically, while holding the attachment
   * open across all of them. So the sink is pinned open here and the
   * cancellation asserted while it is still pending.
   */
  it("cancels before waiting on the drain's notes", async () => {
    const { handle, state } = handleWithPostPull(
      [stdout(1, assistant("still working"))],
      true
    );
    // Hand-rolled rather than `Promise.withResolvers`, which this package's lib
    // target does not carry.
    let release!: () => void;
    const posted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const drained = drainRun(handle, FRESH, {
      ...stopAfter(50),
      onProgress: () => posted
    });

    // The drain is stopped and cancels — with the sink still unresolved.
    await vi.waitFor(() => expect(state.cancelled).toBe(true));

    release();
    expect((await drained).done).toBe(false);
  });
});

describe("one exec id per run", () => {
  /**
   * Runs are concurrent, and a workspace is one container. A shared exec id
   * would let two sessions spawn over each other, each drain attach to
   * whichever won, and `stop` kill somebody else's run.
   */
  it("namespaces the id so two runs cannot collide", () => {
    expect(execIdFor("run-7")).not.toBe(execIdFor("run-8"));
    expect(execIdFor("run-7")).toContain("run-7");
  });

  it("carries the id in the cursor rather than re-deriving it", () => {
    expect(freshCursor(execIdFor("run-7")).execId).toBe(execIdFor("run-7"));
  });
});

describe("startRun", () => {
  const handleFor = () => fakeHandle([exit(1, 0)]);

  function runtimeThatIsBusy(): SessionRuntime & { attached: string[] } {
    const attached: string[] = [];
    return {
      attached,
      exec: async () => {
        throw Object.assign(new Error("execution is running"), {
          code: "EEXEC_BUSY"
        });
      },
      getExec: async (id: string) => {
        attached.push(id);
        return handleFor();
      },
      killExec: async () => {}
    };
  }

  /**
   * `start` spawns and then drains for minutes, so a turn cut anywhere after
   * the spawn is recovered with no cursor to resume from — and the runtime
   * refuses to reuse a live id. Without the fallback the recovery throws, every
   * later one throws identically, and a healthy session becomes unreachable.
   */
  it("attaches instead of failing when the id is already live", async () => {
    const runtime = runtimeThatIsBusy();
    const handle = await startRun(runtime, {
      prompt: "p",
      dir: "/workspace/repo",
      execId: EXEC,
      timeoutMs: 1000
    });

    expect(runtime.attached).toEqual([EXEC]);
    expect(handle.id).toBe(EXEC);
  });

  it("stops waiting on a busy id's subscriber once its turn is stopped", async () => {
    // Nobody is left to read the session this would attach to.
    let looks = 0;
    const replaced = new AbortController();
    replaced.abort();
    const runtime: SessionRuntime = {
      exec: async () => {
        throw Object.assign(new Error("execution is running"), {
          code: "EEXEC_BUSY"
        });
      },
      getExec: async () => {
        looks++;
        throw new Error("exec x already has a live subscriber");
      },
      killExec: async () => {}
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        startRun(runtime, {
          prompt: "p",
          dir: "/workspace/repo",
          execId: EXEC,
          timeoutMs: 1000,
          signal: replaced.signal
        })
      ).rejects.toThrow(/already has a live subscriber/);
      expect(looks).toBe(1);
    } finally {
      info.mockRestore();
    }
  });

  it("rethrows anything that is not a busy id", async () => {
    const runtime: SessionRuntime = {
      exec: async () => {
        throw Object.assign(new Error("no container"), {
          code: "ECONNREFUSED"
        });
      },
      getExec: async () => handleFor(),
      killExec: async () => {}
    };

    await expect(
      startRun(runtime, {
        prompt: "p",
        dir: "/workspace/repo",
        execId: EXEC,
        timeoutMs: 1000
      })
    ).rejects.toThrow(/no container/);
  });
});

/**
 * Waiting out the previous drain's attachment.
 *
 * A resumed drain can ask for the exec's stream while the last one's is still
 * being released on the far side — so the container answers "already has a
 * live subscriber" and the condition clears on its own. Left to recovery it
 * costs a retry each time, out of the budget a deploy, a severed stub and a
 * network drop also have to come from — which is what `attachRun` in
 * `./run.ts` exists to stop, and where that reasoning lives.
 *
 * The clock and the wait are injected, so these assert the bound rather than
 * sit through it.
 */
describe("attachRun", () => {
  const subscribed = () => new Error("exec x already has a live subscriber");

  /** A runtime that refuses `count` times and then hands the stream over. */
  function releasesAfter(count: number): SessionRuntime & { looks: number } {
    const state = { looks: 0 };
    return {
      get looks() {
        return state.looks;
      },
      exec: async () => {
        throw new Error("not used");
      },
      getExec: async () => {
        state.looks++;
        if (state.looks <= count) throw subscribed();
        return fakeHandle([exit(1, 0)]);
      },
      killExec: async () => {}
    } as SessionRuntime & { looks: number };
  }

  it("waits for the release rather than failing the turn", async () => {
    const runtime = releasesAfter(3);
    const handle = await attachRun(runtime, FRESH, { wait: async () => {} });

    expect(handle.id).toBe(EXEC);
    expect(runtime.looks).toBe(4);
  });

  /**
   * `EEXEC_LOST` is the container having been replaced, and `resume` turns it
   * into a report the model can act on. Retrying it would sit out the whole
   * wait learning nothing and then fail with the error it already had.
   */
  it("rethrows anything else on the first look", async () => {
    let looks = 0;
    const runtime: SessionRuntime = {
      exec: async () => {
        throw new Error("not used");
      },
      getExec: async () => {
        looks++;
        throw Object.assign(new Error("execution was lost"), {
          code: "EEXEC_LOST"
        });
      },
      killExec: async () => {}
    };

    await expect(
      attachRun(runtime, FRESH, { wait: async () => {} })
    ).rejects.toThrow(/execution was lost/);
    expect(looks).toBe(1);
  });

  /**
   * The bound is what keeps this an optimisation rather than a hang: a
   * subscriber that is never released has to fail the turn, which recovery
   * retries on a fresh isolate.
   */
  it("gives up once the budget is gone, and not a millisecond past it", async () => {
    const runtime = releasesAfter(Number.POSITIVE_INFINITY);
    // A clock the waits drive, so the bound is asserted exactly rather than
    // waited out in real time.
    let clock = 0;
    await expect(
      attachRun(runtime, FRESH, {
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        }
      })
    ).rejects.toThrow(/already has a live subscriber/);
    // **The equality is the assertion.** A schedule whose final doubling
    // straddles the bound overshoots it and takes one more look on the far
    // side, which every weaker check here — that it retried at all, that it
    // eventually threw — passes happily.
    expect(clock).toBe(30_000);
    // And it did wait repeatedly to get there, rather than rethrowing early.
    expect(runtime.looks).toBeGreaterThan(5);
  });
});

/**
 * A drain asked to stop: it returns the cursor at once and lets go of the
 * session's one subscriber. Stopping the session itself is the caller's.
 */
describe("drainRun, when stopped", () => {
  const settleReads = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops at once, with a cursor a resumed drain starts from", async () => {
    const { handle } = liveHandle([stdout(1, assistant("working"))]);
    const replaced = new AbortController();
    const draining = drainRun(handle, FRESH, {
      signal: replaced.signal
    });
    await settleReads();
    replaced.abort();

    const outcome = await draining;
    expect(outcome.done).toBe(false);
    expect(outcome.cursor.seq).toBe(1);
    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:0"]);
  });

  it("does not start reading when it was stopped before it began", async () => {
    const { handle } = liveHandle([stdout(1, assistant("working"))]);
    const replaced = new AbortController();
    replaced.abort();

    const outcome = await drainRun(handle, FRESH, {
      signal: replaced.signal
    });
    expect(outcome.done).toBe(false);
    expect(outcome.cursor.seq).toBe(0);
  });

  it("reads to the end once the process has exited", async () => {
    // The read to the end is what runs the filesystem sync, so a stop that
    // cut it short would report a session whose edits never land.
    let controller!: ReadableStreamDefaultController<Event>;
    const stream = new ReadableStream<Event>({
      start(c) {
        controller = c;
        c.enqueue(stdout(1, RESULT_LINE));
        c.enqueue(exit(2, 0));
      }
    });
    const handle = Object.assign(stream, {
      id: EXEC,
      backend: "container",
      result: async () => {
        throw new Error("not used by the drain");
      },
      kill: async () => {},
      [Symbol.dispose]: () => {}
    }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
    const replaced = new AbortController();
    let settled = false;
    const draining = drainRun(handle, FRESH, {
      signal: replaced.signal
    }).finally(() => {
      settled = true;
    });

    await settleReads();
    replaced.abort();
    await settleReads();
    expect(settled).toBe(false);

    controller.close();
    const outcome = await draining;
    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(0);
  });
});

describe("attachRun, when stopped", () => {
  it("stops waiting for the subscriber", async () => {
    // Nobody is left to read the session it would attach to.
    let looks = 0;
    const runtime: SessionRuntime = {
      exec: async () => {
        throw new Error("not used");
      },
      getExec: async () => {
        looks++;
        throw new Error("exec x already has a live subscriber");
      },
      killExec: async () => {}
    };
    const replaced = new AbortController();
    let waits = 0;

    await expect(
      attachRun(runtime, FRESH, {
        signal: replaced.signal,
        wait: async () => {
          waits++;
          if (waits === 2) replaced.abort();
        }
      })
    ).rejects.toThrow(/already has a live subscriber/);
    expect(looks).toBe(3);
  });
});

describe("the reserved credential key", () => {
  /**
   * `env` is merged last so a deployment can add what a repository needs, and
   * that merge is exactly how the placeholder could be replaced by a real
   * credential — silently, and in every container from then on.
   */
  it("refuses a host trying to set the OAuth token", () => {
    expect(() =>
      buildLaunch({
        prompt: "p",
        dir: "/workspace/repo",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-REAL" }
      })
    ).toThrow(/cannot be set through/);
  });

  it("keeps the placeholder even when other host env is merged", () => {
    const { env } = buildLaunch({
      prompt: "p",
      dir: "/workspace/repo",
      env: { CI: "1" }
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
    expect(env.CI).toBe("1");
  });
});

describe("the forge placeholder", () => {
  const launch = (env?: Record<string, string>) =>
    buildLaunch({
      prompt: "p",
      dir: "/workspace/repo",
      forge: true,
      ...(env ? { env } : {})
    });

  it("presents the placeholder to gh and to git", () => {
    const { env } = launch();
    expect(env.GH_TOKEN).toBe(FORGE_PLACEHOLDER);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$GH_TOKEN");
  });

  it("is absent without forge, so a host may set GH_TOKEN itself", () => {
    const { env } = buildLaunch({
      prompt: "p",
      dir: "/workspace/repo",
      env: { GH_TOKEN: "anything" }
    });
    expect(env.GH_TOKEN).toBe("anything");
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("refuses a host setting a key it owns beside forge", () => {
    expect(() => launch({ GH_TOKEN: "ghp_REAL" })).toThrow(
      /GH_TOKEN cannot be set through `env`/
    );
    expect(() => launch({ GIT_CONFIG_COUNT: "2" })).toThrow(
      /GIT_CONFIG_COUNT cannot be set through `env`/
    );
  });
});

describe("the result across a stopped drain", () => {
  /**
   * The `result` line and the `exit` event are two events, and a drain can be
   * cut between them. Losing the result means a successful session reports a
   * terminal outcome with nothing in it — one that reads as having died
   * without a word.
   */
  it("carries a result seen in one drain into the next", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, RESULT_LINE)], true),
      FRESH,
      stopAfter(40)
    );

    expect(first.done).toBe(false);
    expect(first.cursor.result?.costUsd).toBe(1.25);

    const second = await drainRun(fakeHandle([exit(2, 0)]), first.cursor);

    expect(second.done).toBe(true);
    if (!second.done) throw new Error("unreachable");
    expect(second.result?.costUsd).toBe(1.25);
  });
});

describe("drainRun, reporting as it goes", () => {
  it("hands over each note while the drain is still running", async () => {
    /**
     * **Observed before the drain settles, which is the whole assertion.**
     *
     * Checking the sink's calls after `await drainRun(...)` proves nothing: a
     * drain that collected every note and flushed them in `finish()` would pass
     * that test and fail at the only thing this sink is for. So the notes are
     * awaited while the drain's promise is still pending, and the drain is
     * asserted to be pending at that moment.
     */
    const seen: string[] = [];
    let settled = false;
    // Hand-rolled rather than `Promise.withResolvers`, which this package's lib
    // target does not carry.
    let sawBoth!: () => void;
    const bothSeen = new Promise<void>((resolve) => {
      sawBoth = resolve;
    });

    // Still thinking, and stays that way until this test says otherwise — the
    // state the sink exists for.
    const session = liveHandle([
      stdout(1, assistant("reading the tree")),
      stdout(2, assistant("running the suite"))
    ]);

    const drain = drainRun(session.handle, FRESH, {
      onProgress: (event) => {
        seen.push(event.text);
        if (seen.length === 2) sawBoth();
      }
    });
    void drain.then(() => {
      settled = true;
    });

    await bothSeen;
    expect(seen).toEqual(["reading the tree", "running the suite"]);
    // The session has not exited and nothing stopped the drain, so it cannot
    // have returned — these notes were delivered mid-flight.
    await Promise.resolve();
    expect(settled).toBe(false);

    session.end(3, 0);
    const outcome = await drain;
    expect(outcome.done).toBe(true);
    // Returned as well, so a caller that passes no sink is unaffected — which is
    // also why a caller that does pass one must drop what it is handed back.
    expect(outcome.progress.map((p) => p.text)).toEqual(seen);
  });

  it("numbers notes across a resumed drain exactly as one drain would", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, assistant("one"))], true),
      FRESH,
      stopAfter(50)
    );
    const second = await drainRun(
      fakeHandle([stdout(2, assistant("two")), exit(3, 0)]),
      first.cursor
    );

    // Positional keys are what make a replayed stretch dedupe rather than
    // repost, so the count has to survive the stop the notes were split across.
    expect(first.progress.map((p) => p.key)).toEqual(["claude:0"]);
    expect(second.progress.map((p) => p.key)).toEqual(["claude:1"]);
  });

  it("re-emits identical keys when a retry replays the same stream", async () => {
    // A drain that died before its cursor was stored resumes from whatever was
    // last stored. The same lines are parsed twice, and the second pass has to
    // produce keys the transcript already has or the whole tail is filed again.
    const script = [stdout(1, assistant("one")), stdout(2, assistant("two"))];
    const attempt = () => drainRun(fakeHandle(script), FRESH);

    const died = await attempt();
    const retried = await attempt();
    expect(retried.progress).toEqual(died.progress);
  });

  it("settles the sink before returning an outcome that names its notes", async () => {
    /**
     * A caller stores the returned cursor, and the cursor claims those notes
     * were filed. If the drain returned first, an isolate unwinding could drop
     * a note the cursor had already counted — and a resumed drain would skip
     * it, because its key is behind the stored position.
     */
    let delivered = 0;
    await drainRun(
      fakeHandle([stdout(1, assistant("one")), exit(2, 0)]),
      FRESH,
      {
        onProgress: async () => {
          await new Promise((r) => setTimeout(r, 5));
          delivered++;
        }
      }
    );
    expect(delivered).toBe(1);
  });

  it("offers no checkpoint until the interval has passed, then one behind the notes", async () => {
    const checkpoints: DrainCursor[] = [];
    let clock = 0;
    await drainRun(
      fakeHandle([
        stdout(1, assistant("one")),
        stdout(2, assistant("two")),
        exit(3, 0)
      ]),
      FRESH,
      {
        now: () => clock,
        onProgress: () => {
          // Each stdout event advances the clock past the floor, so the second
          // one is eligible and the first is not.
          clock += 40_000;
        },
        onCheckpoint: (cursor) => {
          checkpoints.push(cursor);
        }
      }
    );

    expect(checkpoints).toHaveLength(1);
    // A checkpoint names a position whose notes are already on the sink's queue —
    // that is the only reason it is safe to resume from mid-stream.
    expect(checkpoints[0]!.emitted).toBe(2);
    expect(checkpoints[0]!.seq).toBe(2);
  });

  /**
   * The id is the handle to everything a later run might continue, and the runs
   * that most need continuing are the ones that end badly — so the question each
   * of these asks is whether the handle survives the way that run ended.
   */
  describe("the session's handle", () => {
    it("offers the id the moment it appears, without waiting out the interval", async () => {
      const checkpoints: DrainCursor[] = [];
      // Frozen: nothing here has waited `CHECKPOINT_MIN_MS`, so a checkpoint
      // offered at all is one the id let through.
      const clock = () => 0;
      const outcome = await drainRun(
        fakeHandle([
          stdout(1, initLine("sess-9") + assistant("reading the tree")),
          exit(2, 0)
        ]),
        FRESH,
        {
          now: clock,
          onProgress: () => {},
          onCheckpoint: (cursor) => {
            checkpoints.push(cursor);
          }
        }
      );

      expect(checkpoints.map((c) => c.sessionId)).toEqual(["sess-9"]);
      expect(outcome.cursor.sessionId).toBe("sess-9");
    });

    /**
     * The case the cursor's copy of the id exists for: a session stopped by its
     * time limit, a cancel or a container rollout reports no result at all, and
     * the conversation it got half-way through would otherwise be unreachable.
     */
    it("keeps the id on a session that died before reporting anything", async () => {
      const outcome = await drainRun(
        fakeHandle([stdout(1, initLine("sess-9")), exit(2, 143)]),
        FRESH
      );

      if (!outcome.done) throw new Error("unreachable");
      expect(outcome.result).toBeUndefined();
      expect(outcome.cursor.sessionId).toBe("sess-9");
    });

    /**
     * A resumed drain re-reads whatever arrived after the stored position, the
     * `init` line included. The id a host has already recorded is the one the
     * cursor keeps.
     */
    it("holds the first id against a replayed init line", async () => {
      const first = await drainRun(
        fakeHandle([stdout(1, initLine("sess-9"))], true),
        FRESH,
        stopAfter(50)
      );
      expect(first.cursor.sessionId).toBe("sess-9");

      const second = await drainRun(
        fakeHandle([stdout(2, initLine("sess-other")), exit(3, 0)]),
        first.cursor
      );
      expect(second.cursor.sessionId).toBe("sess-9");
    });
  });

  it("reports a bucket reading only to the drain that saw it", async () => {
    const rateLine = line({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1789587600 }
    });
    const first = await drainRun(
      fakeHandle([stdout(1, rateLine)], true),
      FRESH,
      stopAfter(50)
    );
    expect(first.rateLimit?.resetsAt).toBe(1789587600);

    /**
     * **Not carried forward, unlike the result line**, and the asymmetry is the
     * point. A caller acts on this against whichever credential is leading when
     * it reads it, so a reading repeated on every resumed drain would let one
     * old observation retire a credential that was not in use when it was
     * taken. A drain that learned nothing says nothing.
     */
    const second = await drainRun(
      fakeHandle([stdout(2, assistant("on we go")), exit(3, 0)]),
      first.cursor
    );
    expect(second.rateLimit).toBeUndefined();
  });

  it("stores no cursor past a note the sink rejected", async () => {
    /**
     * A rejected note is not in the parent's transcript. A cursor stored past
     * it would have a resumed drain skip it for good; with none, a drain cut
     * later resumes from before it and files it again.
     */
    const checkpoints: DrainCursor[] = [];
    let clock = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let outcome: DrainOutcome;
    try {
      outcome = await drainRun(
        fakeHandle([
          stdout(1, assistant("one")),
          stdout(2, assistant("two")),
          stdout(3, assistant("three")),
          exit(4, 0)
        ]),
        FRESH,
        {
          now: () => clock,
          onProgress: async (note) => {
            clock += 40_000;
            if (note.text === "one") throw new Error("storage refused it");
          },
          onCheckpoint: (cursor) => {
            checkpoints.push(cursor);
          }
        }
      );
    } finally {
      warn.mockRestore();
    }
    expect(checkpoints).toEqual([]);
    // The outcome's cursor is stored too, so it stops where the drain began.
    expect(outcome.cursor).toEqual(FRESH);
  });

  it("returns the last checkpoint behind a rejected note", async () => {
    const checkpoints: DrainCursor[] = [];
    let clock = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let outcome: DrainOutcome;
    try {
      outcome = await drainRun(
        fakeHandle([
          stdout(1, assistant("one")),
          stdout(2, assistant("two")),
          stdout(3, assistant("three")),
          exit(4, 0)
        ]),
        FRESH,
        {
          now: () => clock,
          onProgress: async (note) => {
            clock += 40_000;
            if (note.text === "three") throw new Error("storage refused it");
          },
          onCheckpoint: (cursor) => {
            checkpoints.push(cursor);
          }
        }
      );
    } finally {
      warn.mockRestore();
    }
    expect(checkpoints.map((c) => c.seq)).toEqual([2]);
    expect(outcome.cursor).toEqual(checkpoints[0]);
    expect(outcome.done && outcome.exitCode).toBe(0);
  });

  it("refuses to checkpoint for a caller that files nothing", async () => {
    /**
     * The unsafe combination, made unreachable rather than only documented.
     *
     * A checkpoint is safe because the notes behind it are already filed.
     * Offered to a caller with no `onProgress`, it advances a cursor past notes
     * nobody ever saw, and a drain dying after it loses them for good.
     */
    const checkpoints: DrainCursor[] = [];
    let clock = 0;
    await drainRun(
      fakeHandle([
        stdout(1, assistant("one")),
        stdout(2, assistant("two")),
        exit(3, 0)
      ]),
      FRESH,
      {
        now: () => {
          clock += 40_000;
          return clock;
        },
        onCheckpoint: (cursor) => {
          checkpoints.push(cursor);
        }
      }
    );
    expect(checkpoints).toEqual([]);
  });
});
