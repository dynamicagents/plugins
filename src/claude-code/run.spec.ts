import { describe, expect, it, vi } from "vitest";
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
  READ_ONLY_LAUNCH,
  type DrainCursor,
  type SessionRuntime
} from "./run.js";
import { DEFAULT_PERMISSION_MODE } from "./config.js";

const EXEC = execIdFor(7);
const FRESH = freshCursor(EXEC);

/**
 * Launching and draining, and the two failures that are invisible until
 * production.
 *
 * A drain that returns as soon as it has nothing to read burns
 * `MAX_CHUNKS_PER_BRANCH` in seconds and the subtask dies having done nothing
 * wrong. A cursor that does not carry loses whichever line the window happened
 * to cut in half — which for a stream of one-JSON-object-per-line is a whole
 * event, silently.
 */

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
 * immediately or waits out its whole window — neither of which lets a test look
 * at a drain *while it is running*. This one can be ended on demand, which is
 * what makes the mid-flight assertions below deterministic rather than a race
 * against a short window.
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

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
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

  /**
   * A reading session's copy is its working directory, which is no boundary for
   * a root process whose brief may name the original by absolute path.
   */
  it("runs a read-only launch in a namespace of its own, then becomes claude", () => {
    const { command, env } = launch({ readOnly: "/workspace" });

    expect(command).toBe(
      `unshare --mount --propagation private -- sh -c '${READ_ONLY_LAUNCH}' sh ${launch().command}`
    );
    expect(env.CLAUDE_READ_ONLY).toBe("/workspace");
    // `exec`, so the stop signal a session is sent lands on claude itself.
    expect(READ_ONLY_LAUNCH).toContain('exec "$@"');
    // It travels inside single quotes.
    expect(READ_ONLY_LAUNCH).not.toContain("'");
  });

  /**
   * An exec's cwd is resolved against the workspace's own filesystem, so one on
   * container disk is refused before anything spawns. The shell moves there
   * instead, and `exec`s so a stop signal still lands on claude.
   */
  it("moves into a workdir the exec could not have started in", () => {
    const { command, env } = launch({ workdir: "/var/tmp/claude-read/x/tree" });

    expect(command).toBe(`cd "$CLAUDE_WORKDIR" && exec ${launch().command}`);
    expect(env.CLAUDE_WORKDIR).toBe("/var/tmp/claude-read/x/tree");
  });

  it("moves into the workdir inside the read-only namespace too", () => {
    const { command, env } = launch({
      readOnly: "/workspace",
      workdir: "/var/tmp/claude-read/x/tree"
    });

    expect(command.startsWith("unshare ")).toBe(true);
    expect(READ_ONLY_LAUNCH).toContain('cd "${CLAUDE_WORKDIR:-.}" || exit 96');
    expect(env.CLAUDE_WORKDIR).toBe("/var/tmp/claude-read/x/tree");
  });

  it("leaves an ordinary launch alone", () => {
    const { command, env } = launch();
    expect(command.startsWith("claude -p ")).toBe(true);
    expect(env.CLAUDE_READ_ONLY).toBeUndefined();
    expect(env.CLAUDE_WORKDIR).toBeUndefined();
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
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
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
  const window = { windowMs: 5_000 };

  it("reports the run done on the exit event, with its result", async () => {
    const handle = fakeHandle([
      stdout(1, assistant("working")),
      stdout(2, RESULT_LINE),
      exit(3, 0)
    ]);

    const outcome = await drainRun(handle, FRESH, window);

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.costUsd).toBe(1.25);
    expect(outcome.cursor.seq).toBe(3);
    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:0"]);
  });

  /**
   * A drain that ends early must not leave the window armed: a pending timer
   * holds the facet's `executeChunk` open until the window runs out, so a
   * session that finished in seconds still cost the whole window.
   */
  it("leaves no timer behind when the session ends inside the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const handle = fakeHandle([
        stdout(1, assistant("working")),
        stdout(2, RESULT_LINE),
        exit(3, 0)
      ]);

      const outcome = await drainRun(handle, FRESH, { windowMs: 20 * 60_000 });

      expect(outcome.done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The pacing rule. A session legitimately runs longer than one chunk, and a
   * drain that returned the moment it had nothing to read would exhaust the
   * branch's forty chunks in seconds without the run ever failing.
   */
  it("blocks until the window expires while the session is still going", async () => {
    const handle = fakeHandle([stdout(1, assistant("thinking"))], true);
    const started = Date.now();

    const outcome = await drainRun(handle, FRESH, { windowMs: 60 });

    expect(outcome.done).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(outcome.progress).toHaveLength(1);
    expect(outcome.cursor.seq).toBe(1);
  });

  /**
   * The window routinely cuts a line in half, and for a stream of one JSON
   * object per line that is a whole event. The carry is what makes the next
   * chunk able to finish it.
   */
  it("carries a half-read line into the next window", async () => {
    const whole = assistant("a complete thought");
    const cut = Math.floor(whole.length / 2);

    const first = await drainRun(
      fakeHandle([stdout(1, whole.slice(0, cut))], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.progress).toHaveLength(0);
    expect(first.cursor.carry).toBe(whole.slice(0, cut));

    const second = await drainRun(
      fakeHandle([stdout(2, whole.slice(cut))], true),
      first.cursor,
      { windowMs: 40 }
    );
    expect(second.progress.map((p) => p.text)).toEqual(["a complete thought"]);
  });

  /**
   * Progress keys are positional, so the count has to survive the chunk boundary
   * or the second chunk restarts at `claude:0` and the gatekeeper drops every note
   * as a duplicate of one it already showed.
   */
  it("continues the progress numbering across chunks", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, assistant("one") + assistant("two"))], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.cursor.emitted).toBe(2);

    const second = await drainRun(
      fakeHandle([stdout(2, assistant("three")), exit(3, 0)]),
      first.cursor,
      window
    );
    expect(second.progress.map((p) => p.key)).toEqual(["claude:2"]);
  });

  /**
   * The stream ending with no `exit` means the container went away under the
   * run. Reporting it as still-running would make the caller wait out its entire
   * chunk budget on a dead process.
   */
  it("treats a stream that ends without an exit event as a failure", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, assistant("half a job"))]),
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.result).toBeUndefined();
  });

  it("resumes from a cursor without re-emitting what the last chunk showed", async () => {
    const cursor: DrainCursor = {
      execId: EXEC,
      seq: 9,
      carry: "",
      emitted: 3
    };
    const outcome = await drainRun(
      fakeHandle([stdout(10, assistant("next")), exit(11, 0)]),
      cursor,
      window
    );

    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:3"]);
    expect(outcome.cursor.seq).toBe(11);
  });

  it("reports a non-zero exit without a result line", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, "some stderr-ish noise\n"), exit(2, 143)]),
      FRESH,
      window
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
      FRESH,
      window
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
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.result).toBeDefined();
    expect(outcome.stderr).toBeUndefined();
  });

  /**
   * The death and the exit can land in different windows, so the tail rides on
   * the cursor rather than living in one drain's locals.
   */
  it("carries stderr across a window boundary", async () => {
    const first = await drainRun(
      fakeHandle([stderrOut(1, "first half ")], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.done).toBe(false);
    expect(first.cursor.stderr).toBe("first half ");

    const outcome = await drainRun(
      fakeHandle([stderrOut(2, "second half"), exit(3, 1)]),
      first.cursor,
      window
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
      FRESH,
      window
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
      // window expires. Closing here instead would end the run.
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

    const outcome = await drainRun(handle, FRESH, { windowMs: 5_000 });

    expect(outcome.done).toBe(true);
    expect(state.synced).toBe(true);
  });

  /**
   * A window that ends mid-session must *not* trigger the pull — there is
   * nothing to sync yet — but it must cancel, because merely releasing the
   * reader lock leaves the attachment and its pending read alive on the far
   * side, one per chunk.
   */
  it("cancels the attachment when the window expires, without syncing", async () => {
    const { handle, state } = handleWithPostPull(
      [stdout(1, assistant("still working"))],
      true
    );

    const outcome = await drainRun(handle, FRESH, { windowMs: 50 });

    expect(outcome.done).toBe(false);
    // Cancelled, because merely releasing the reader lock leaves the attachment
    // and its pending read alive on the far side — one stranded per chunk.
    expect(state.cancelled).toBe(true);
    // And not synced: there is nothing to pull back until the session ends.
    expect(state.synced).toBe(false);
  });

  /**
   * **Cancelled before the window's progress posts are settled, not after.**
   *
   * Asserting cancellation once `drainRun` has resolved proves nothing about
   * the order: a drain that settled every queued post first and cancelled on
   * the way out passes that check identically. Each post is a signed round trip
   * to the gatekeeper, so that order held the attachment open across all of
   * them and handed the next chunk a subscriber still live for no reason but
   * sequencing. So the sink is pinned open here and the cancellation asserted
   * while it is still pending.
   */
  it("cancels before waiting on the window's progress posts", async () => {
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
      windowMs: 50,
      onProgress: () => posted
    });

    // The window expires, the drain cancels — with the sink still unresolved.
    await vi.waitFor(() => expect(state.cancelled).toBe(true));

    release();
    expect((await drained).done).toBe(false);
  });
});

describe("one exec id per subtask", () => {
  /**
   * Subtasks are a flat concurrent fan-out, and a workspace is one container. A
   * shared exec id would let two sessions spawn over each other, each drain
   * attach to whichever won, and `stop` kill somebody else's run.
   */
  it("namespaces the id so two subtasks cannot collide", () => {
    expect(execIdFor(7)).not.toBe(execIdFor(8));
    expect(execIdFor(7)).toContain("7");
  });

  it("carries the id in the cursor rather than re-deriving it", () => {
    expect(freshCursor(execIdFor(7)).execId).toBe(execIdFor(7));
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
   * `start` spawns and then drains for minutes, so a chunk that fails anywhere
   * after the spawn is retried with no cursor to resume from — and the runtime
   * refuses to reuse a live id. Without the fallback the retry throws, every
   * later retry throws identically, and a healthy session becomes unreachable.
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
 * Waiting out the previous window's attachment.
 *
 * A chunk boundary asks for the exec's stream within milliseconds of the last
 * window returning it, and the release on the far side is asynchronous — so the
 * container answers "already has a live subscriber" and the condition clears on
 * its own. Left to the Workflow it costs a retry each time, out of the budget a
 * deploy, a severed stub and a network drop also have to come from — which is
 * what `attachRun` in `./run.ts` exists to stop, and where that reasoning lives.
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

  it("waits for the release rather than failing the chunk", async () => {
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
   * subscriber that is never released has to reach the Workflow, which retries
   * the step on a fresh isolate.
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
 * A chunk replaced by a retry of itself, asked to let go of the session.
 *
 * Only this chunk ends: the session goes on running, and the retry resumes from
 * the cursor returned here. Holding on instead is what kept a retry off the
 * session's one subscriber until the step ran out of attempts.
 */
describe("drainRun, asked for its window back", () => {
  const long = { windowMs: 20 * 60_000 };
  const settleReads = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("yields at once, with a cursor the retry resumes from", async () => {
    const { handle } = liveHandle([stdout(1, assistant("working"))]);
    const replaced = new AbortController();
    const draining = drainRun(handle, FRESH, {
      ...long,
      signal: replaced.signal
    });
    await settleReads();
    replaced.abort();

    const outcome = await draining;
    expect(outcome.done).toBe(false);
    expect(outcome.cursor.seq).toBe(1);
    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:0"]);
  });

  it("does not start a window it was already asked to give back", async () => {
    const { handle } = liveHandle([stdout(1, assistant("working"))]);
    const replaced = new AbortController();
    replaced.abort();

    const outcome = await drainRun(handle, FRESH, {
      ...long,
      signal: replaced.signal
    });
    expect(outcome.done).toBe(false);
    expect(outcome.cursor.seq).toBe(0);
  });

  it("reads to the end once the process has exited", async () => {
    // The read to the end is what runs the filesystem sync, so a yield that
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
      ...long,
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

describe("attachRun, for a chunk that has been replaced", () => {
  it("stops waiting for the subscriber", async () => {
    // The retry that replaced it is what the subscriber is being freed for.
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

describe("the result across a chunk boundary", () => {
  /**
   * The `result` line and the `exit` event are two events, and a window can end
   * between them. Losing the result means a successful session reports a
   * terminal outcome with nothing in it — and `persistResult` turns an empty
   * report into a failure.
   */
  it("carries a result seen in one window into the next", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, RESULT_LINE)], true),
      FRESH,
      { windowMs: 40 }
    );

    expect(first.done).toBe(false);
    expect(first.cursor.result?.costUsd).toBe(1.25);

    const second = await drainRun(fakeHandle([exit(2, 0)]), first.cursor, {
      windowMs: 5_000
    });

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
      // Long, so nothing can end the window while the assertion below runs.
      windowMs: 60_000,
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
    // The session has not exited and the window has not expired, so the drain
    // cannot have returned — these notes were delivered mid-flight.
    await Promise.resolve();
    expect(settled).toBe(false);

    session.end(3, 0);
    const outcome = await drain;
    expect(outcome.done).toBe(true);
    // Returned as well, so a caller that passes no sink is unaffected — which is
    // also why a caller that does pass one must drop what it is handed back.
    expect(outcome.progress.map((p) => p.text)).toEqual(seen);
  });

  it("numbers notes across a window boundary exactly as one drain would", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, assistant("one"))]),
      FRESH,
      { windowMs: 50 }
    );
    const second = await drainRun(
      fakeHandle([stdout(2, assistant("two")), exit(3, 0)]),
      first.cursor,
      { windowMs: 50 }
    );

    // Positional keys are what make a replayed chunk dedupe rather than repost,
    // so the count has to survive the boundary the notes were split across.
    expect(first.progress.map((p) => p.key)).toEqual(["claude:0"]);
    expect(second.progress.map((p) => p.key)).toEqual(["claude:1"]);
  });

  it("re-emits identical keys when a retry replays the same stream", async () => {
    // A chunk that died before committing its cursor is retried from whatever
    // was last written. The same lines are parsed twice, and the second pass has
    // to produce keys the gatekeeper already knows or the whole tail is reposted.
    const script = [stdout(1, assistant("one")), stdout(2, assistant("two"))];
    const attempt = () => drainRun(fakeHandle(script), FRESH, { windowMs: 50 });

    const died = await attempt();
    const retried = await attempt();
    expect(retried.progress).toEqual(died.progress);
  });

  it("settles the sink before returning an outcome that names its notes", async () => {
    /**
     * A caller commits the returned cursor, and the cursor claims those notes
     * were emitted. If the drain returned first, an isolate unwinding its RPC
     * could drop a post the cursor had already counted — and the retry would
     * skip it, because its key is behind the committed position.
     */
    let delivered = 0;
    await drainRun(
      fakeHandle([stdout(1, assistant("one")), exit(2, 0)]),
      FRESH,
      {
        windowMs: 50,
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
        windowMs: 5 * 60_000,
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
    // that is the only reason it is safe to resume from mid-window.
    expect(checkpoints[0]!.emitted).toBe(2);
    expect(checkpoints[0]!.seq).toBe(2);
  });

  it("reports a bucket reading only to the window that saw it", async () => {
    const rateLine = line({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1789587600 }
    });
    const first = await drainRun(fakeHandle([stdout(1, rateLine)]), FRESH, {
      windowMs: 50
    });
    expect(first.rateLimit?.resetsAt).toBe(1789587600);

    /**
     * **Not carried forward, unlike the result line**, and the asymmetry is the
     * point. A caller acts on this against whichever credential is leading when
     * it reads it, so a reading repeated on every later chunk would let one
     * window's observation retire a credential that was not in use when it was
     * taken. A window that learned nothing says nothing.
     */
    const second = await drainRun(
      fakeHandle([stdout(2, assistant("on we go")), exit(3, 0)]),
      first.cursor,
      { windowMs: 50 }
    );
    expect(second.rateLimit).toBeUndefined();
  });

  it("refuses to checkpoint for a caller that posts nothing", async () => {
    /**
     * The unsafe combination, made unreachable rather than only documented.
     *
     * A checkpoint is safe because the notes behind it are already posted.
     * Offered to a caller with no `onProgress`, it advances a cursor past notes
     * nobody ever saw, and a chunk dying after it loses them for good.
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
        windowMs: 5 * 60_000,
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
