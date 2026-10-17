# `@dynamicagents/plugins/claude-code`

Sub-agents whose model is the **Claude Code CLI**, running in a
[`/sandbox`](../sandbox/) container whose disk is the checkout.

## Why this exists

A Claude **subscription** credential does not work for raw Messages API calls on
a frontier model. Every Opus call returns `429` in ~10 ms at zero tokens, and
Sonnet follows; Haiku 4.5 is the sole exception, and it rejects the
`output_config.effort` field a reasoning agent is built around. Holding two
credentials on separate accounts does not clear it — both refuse the same request.

The same credential, sent by the Claude Code client, succeeds: Opus 5, Sonnet 5
and Haiku 4.5 all answer, at `service_tier: standard`. **The harness is the
unlock, not the credential.** So the way to reach those models on a subscription
is to run the sanctioned client, which is what this plugin makes delegable.

## The shape: a writer, and the session is its model

Unusual for this package, and it is the whole design. Claude Code brings its own
tools, its own loop and its own context management, so there is nothing for an
agent loop to drive. So this package exports no plugin: it exports a writer's
`SubAgentSpec` — `CLAUDE_CODE_AGENT` (`claude_code`) — and
`claudeCodeModel`, a language model whose one call runs a session. A host
binds the spec to a `SubAgent` whose `getModel()` returns one, and Think's
recovery does the rest: a turn cut by an eviction or a deploy is continued, and
the model picks the session up where it was.

**A planner is a writer under `plan`.** The same spec under another name,
description and input, in a worktree of its own, whose model sets
`permissionMode: "plan"` and a named `schema`: it reads, edits nothing, and
answers as data. Carrying the plan out is a later run that resumes it — see
[A session has a handle](#a-session-has-a-handle-and-a-later-run-may-continue-it).

It runs **detached**: the parent's call returns at once, and the report arrives
as a later turn. A session runs for up to its `timeoutMs`, past a parent's turn.

**One sub-agent run is one `claude -p` session.** Not one turn, and not one tool
call — the unit has to be substantial, because of what an invocation costs before
it does anything (see [Costs](#costs)).

Two nested notions of "subagent" that must never be conflated:

|                               | Dynamic Agents sub-agent run           | Claude Code subagent          |
| ----------------------------- | -------------------------------------- | ----------------------------- |
| Durable                       | yes                                    | no                            |
| Visible to the parent agent   | yes                                    | **no**                        |
| Cancellable by Dynamic Agents | yes                                    | **no**                        |
| Bounded by                    | `timeoutMs`, enforced by the sub-agent | `CLAUDE_CODE_MAX_*`, advisory |

## The credential never enters the container

The container is an arbitrary-code-execution environment by design: `npm ci` runs
whatever `postinstall` a cloned repository ships, and the agent runs that
repository's own build and test commands. So nothing secret goes in it.

The session launches with `CREDENTIAL_PLACEHOLDER`, and the daemon points the CLI
at `ANTHROPIC_PLACEHOLDER_HOST` over plain HTTP. The sandbox intercepts that host
into its egress entrypoint on the **Worker** side, where `claudeCodeEgress`
sets the pool's lead as the Bearer, on its way to `api.anthropic.com`, and rotates
to the next credential when Anthropic says the current one's bucket is spent (see
below). Nothing in the container terminates TLS for Anthropic.

A `postinstall` that dumps its environment learns the placeholder and nothing
else. GitHub, as the deployment's account for a session that pushes its branch
and opens its pull request, is [`/repo-github`](../repo-github/)'s egress rule —
the same swap, for GitHub's hosts.

**Every other host is reached directly, unrestricted.** A curated list is
permanently wrong for a coding agent — `esbuild`, `swc` and `sharp` fetch prebuilt
binaries from release CDNs, Playwright downloads browsers from a third host,
corepack fetches package managers, and reading documentation is part of the job.
What that gives up is a bound on exfiltration: the container holds the checkout
and can send it anywhere. So the containment here is _"the container holds no
credential"_, and nothing more.

### The 5-hour and weekly limits: rotate, do not predict

A Claude subscription has a rolling 5-hour bucket and a weekly one. Neither is
readable, and an estimate of spend is the wrong instrument twice over: it is a
guess about a bucket nobody can see, and it only moves when a run _ends_ (usage is
learned from the terminal `result` event), so it is never a cap on spend at all —
only a gate on starting.

The egress sees Anthropic's actual response, which is the one place the bucket
announces itself, exactly, the moment it is empty. So the credential is a
**pool**:

```
429 (reset 4h out)  →  mark entry 0 spent until its reset
                    →  the lead becomes entry 1
                    →  return the 429 with `retry-after: 1`
                    →  Claude Code's own retry lands on entry 1
```

The `retry-after` rewrite is what turns the client's existing retry into the
rotation, and it is why nothing here buffers a request body. Left at the
upstream's value — four hours — the client would sleep inside the container
holding a turn open, which is a stall rather than a rotation.

Three behaviours are worth knowing before you rely on it:

- **A short `retry-after` is not exhaustion.** Under a minute is read as an
  ordinary slow-down and forwarded untouched. Rotating on a speed bump would
  retire a working credential for whatever window the header named, and with a
  small pool two of those would empty it.
- **A `401` retires an entry until the next session**, rather than until a
  reset — a revoked credential does not heal on a timer. A `403` retires
  nothing; `readRefusal` says why. The `401` is rewritten to a `429` on the way
  out, because a client does not retry a `401` and would otherwise fail the run
  on a credential the egress has already stopped using.
- **When every entry is spent**, a `429` names the earliest reset, so the run
  ends cleanly having said when to come back. When every entry is _rejected_ it
  is a `500` instead, because that one needs an operator and a `429` would hide
  it behind a retry loop.

**A mark lasts one session.** Call the pool's `admit()` before a session starts.
It forgets every mark, so that session's first model call asks Anthropic again. A
plan upgrade, extra usage switched on, or an early reset makes a stored `resetAt`
wrong, and trusting it would refuse work Anthropic would serve, for hours. Asking
again costs one free `429` per credential that is still spent. The rest is in
`credentials.ts`.

The pool lives in the sandbox object, through `credentialHost`: each sandbox
learns a rotation independently, which costs one wasted `429` per sandbox per
rotation and saves a Durable Object class, a binding and an RPC on the rotation
path. The egress logs every `401`/`403`/`429` whole, headers and body, so a
refusal of any other shape arrives named.

## What the host must provide

A sandbox class that holds the pool and answers the egress's lease:

```ts
import {
  credentialHost,
  type CredentialLease
} from "@dynamicagents/plugins/claude-code";
import { SandboxObjectBase } from "@dynamicagents/plugins/sandbox";

export class CoderSandbox
  extends SandboxObjectBase<Env>
  implements CredentialLease
{
  readonly #pool = credentialHost({
    storage: this.ctx.storage,
    credentials: () => [this.env.CLAUDE_CODE_OAUTH_TOKEN_1].filter(Boolean)
  });
  lead() {
    return this.#pool.lead();
  }
  spend(id: string, resetAt: number) {
    return this.#pool.spend(id, resetAt);
  }
  reject(id: string) {
    return this.#pool.reject(id);
  }
  admit() {
    return this.#pool.admit();
  }
  // sandboxConfig(): its egress rules include `claudeCodeEgress()`.
}
```

An egress entrypoint serving those rules — `sandboxEgress` in
[`/sandbox`](../sandbox/) — and an image whose daemon runs this package's CLI, from
`@dynamicagents/plugins/claude-code/daemon`, with the CLI installed at
`VERIFIED_CLAUDE_CODE_VERSION`:

```ts
// The image's daemon entry, bundled by the deployment.
serveSandboxDaemon({
  cli: claudeCodeDaemonCli({
    id: "claude-code",
    schemas: { plan: PLAN_SCHEMA }
  })
});
```

And the sub-agent's model:

```ts
class Writer extends SubAgent<Env> {
  static spec = { ...CLAUDE_CODE_AGENT, prepare, settle };

  override getModel() {
    // `prepare` claims a sandbox for this run and returns where its checkout is.
    const { sandboxName, dir } = this.pluginContext().runtime() as {
      sandboxName: string;
      dir: string;
    };
    return claudeCodeModel({
      // A new stub per call: a call that failed may have been its stub's last.
      sandbox: () => this.env.CODER_SANDBOX.getByName(sandboxName),
      storage: this.ctx.storage,
      runId: this.name,
      dir,
      note: this.note.bind(this),
      // The session's handle, for a later run to continue it.
      onSession: (record) => this.#recordSession(record),
      // The task, as the session's prompt. A throw refuses the run.
      brief: async (task) => this.#brief(task),
      // One more turn for a session that left work uncommitted, or none.
      followUp: async (session) => this.#uncommittedPrompt(session),
      // What the parent receives. Run once, and kept.
      report: async ({ session, followUp }) => this.#report(session, followUp)
    });
  }
}
```

## How a run survives

The model keeps every step it has taken in the sub-agent's own storage — the
brief, each attempt, the session's end, whether a follow-up was asked for and how
it ended, and the report. A continued turn calls it again and finds them, so it
polls the operation it already submitted rather than starting a second session,
asks nothing twice, and reports once.

**Nothing streams.** The session runs as a harness operation the sandbox keeps,
and the model polls it: a reset of either object costs one poll.

**A lost container resumes the session.** The operation settles as
`container_lost`, and the model submits the next attempt to the same harness
session, whose CLI conversation the harness kept: the session is told what
happened (`CONTAINER_LOST_PROMPT`), not briefed again. A turn that kills its
container every time is resubmitted a bounded number of times.

**The report is the only text the model streams.** A run's result is what its
assistant messages say, so narration streamed as text would become the result.
What the session says as it works goes to the parent as **notes**, through
`note`, each filed at the time the daemon read its line. Prose is a plain note;
every tool call, its result and the session's start and end are a note with a
**card** — the tool, what it acted on, its input and output folded beneath
(`./cards.ts`). A thinking block is a card too, saying only how long it streamed —
"Thought for 5s", timed from its first `thinking_tokens` line so a retry or a slow
first token is not counted — and never what it said.

**A `schema` makes the answer data**, for a session whose answer a host acts on
field by field rather than passing along: `report` reads it as the result's
`structured`. It names a schema the daemon was built with, because a prompt is
stored and a schema there would be too.

**The follow-up is a second operation on the same session**, under the session's
own mode. **A cancelled turn stops the session**: the model's abort signal ends
the run in the sandbox.

**`runtime()` is where the sandbox comes from.** The spec's `prepare` runs on the
parent, where the caller is known, and returns the sandbox name and the checkout;
the sub-agent reads both back from `runtime()`. It is deliberately not the
sub-agent's input, because the parent's model writes that, and a model-authored
sandbox name would let it name somebody else's.

## A session has a handle, and a later run may continue it

Every session's `init` line names it, within seconds of starting. That id is the
handle to the whole conversation, and it reaches a host two ways:

- on `SessionEnd.sessionId` — which is the half that matters, because the
  sessions worth continuing are often the ones that never reach a `result` line.
  A time limit or a cancel ends a session with no result at all;
- through **`onSession`**, called with the id the moment it appears and again with
  the session's end. The first call is what makes a session that is about to be
  killed resumable; the second says how the conversation it left stands.

`onSession` is best-effort, like `note` — a throw is logged and the run goes on.
A host keys its record on the id and keeps an `end` once it has one; a recovered
turn can report the same id again without one.

**A run continues a conversation with `resume`**, naming another run in the same
sandbox — which conversations exist there, and which a caller may continue, are
the host's questions, not the model's. The run's prompt is then the next user
turn: the session already holds the conversation, so a brief that restates it
pays for it twice. `fork` continues it under a **new** id and leaves the original
whole, which is what a change of mode wants — a planning session, run under
`plan`, continued under the mode that writes, with the plan's own conversation
still resumable for an edit.

A conversation lives in the sandbox that ran it: the harness keeps each session's
`.claude/projects` under its home and mirrors it to the object, so it outlives the
container. What that does not buy is reach across sandboxes — a run continues one
only from the same sandbox, and anywhere else the CLI reports it has no such
conversation, while the branch and its commits are untouched.

Measured against the pinned CLI, and all of it load-bearing here:

- `--resume <id> --permission-mode <other>` is accepted, and the `init` line
  reports the **new** mode. A resume can therefore change mode, which is the whole
  of "going from a plan to doing the work" at the CLI level.
- `--resume <unknown-id>` is **not a failed session**: the CLI prints
  `No conversation found with session ID: …` and emits a `result` line —
  `error_during_execution`, `is_error: true`, the sentence in `errors`, no reply —
  then exits 1 in milliseconds. Its client still makes its own startup requests,
  but nothing is inferred and nothing is billed. Report it as "not resumable" and
  delegate again without `resume`.
- **`--session-id` is deliberately not used.** A relaunch with one exits 1 with
  `Session ID … is already in use` on stderr and nothing on stdout — the class of
  death that reports nothing. The `init` line's id gives the same handle and adds
  no failure.

## Updating Claude Code

The egress and the stream parser are written against one CLI version's traffic,
and a newer CLI can change it. So the version is pinned:
`VERIFIED_CLAUDE_CODE_VERSION` (`./verified.ts`) is the one this package was last
checked against. A deployment's image pins the same version, and should check that
the two agree.

A newer version is verified by running this repo's `npm run probe:claude-code`,
which launches it as the daemon does, without a container. This repo's AGENTS.md
("Updating Claude Code") has the procedure. Under the placeholder base URL the CLI
makes no settings or policy reads and sends fewer betas than against
`api.anthropic.com` — the probe's capture records what it does send. The probe
can't see the container itself, so a deployment's own smoke test covers that after
it ships.

## The permission mode, and why it bypasses

`-p` is headless. There is no terminal, so nothing can answer a permission
prompt — and Claude Code's headless path does not wait for one, it **auto-denies**.

That makes the CLI's default mode unusable here, in a way that does not look like
a failure. `default` gates Write, Edit and every Bash command, so a session left
on it reads the repository perfectly, cannot change one byte of it, and reports
prose that reads like considered reluctance rather than a blocked tool. It exits
0, and the run is reported as completed. Each refused call arrives as a
`permission denied for <Tool>: …` progress note and the count lands in the
session's footer, so a run that did nothing says so somewhere.

So the mode defaults to `bypassPermissions`, and the narrower modes are not
alternatives:

| mode                | what a session can do                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `default`           | read only — everything else is auto-denied                                                             |
| `acceptEdits`       | edit files; `npm ci`, `git` and the test suite still denied                                            |
| `dontAsk`           | "deny if not pre-approved" — the default's behaviour, named                                            |
| `manual`            | documented by the CLI and unexercised here — whatever it would prompt for, headless denies             |
| `plan`              | reads and produces a plan, changing nothing — a planning run's mode, answering through a `schema`      |
| `auto`              | a model classifier rules on each call, spending the same subscription bucket the session is drawing on |
| `bypassPermissions` | the whole job                                                                                          |

What makes bypassing acceptable is not the flag being careful. It is that the
container has nothing left to protect: it holds no credential — the real one is
swapped in by the egress on the Worker side — and it already runs a cloned
repository's `postinstall` and its test suite, which is arbitrary code execution
by design. Gating the agent's own edits while those doors stand open costs the
agent its job and buys nothing. Containment is the credential swap.

**A planning run is the one place another mode belongs**, and it is set per run —
`permissionMode: "plan"` on the model — over the daemon's. Under `plan` a session
reads, edits nothing, and is denied what would change the tree, the test suite
included; there is nobody to approve its plan, so it answers through a `schema`
instead. Carrying the plan out is a later run that resumes it with `fork` under
the daemon's mode.

## Costs

What drives the sizing here is not a spend cap — this package deliberately does
not have one — but `timeoutMs`, how many sessions run at once, `effort`, and how
large a brief is worth writing.

**The harness prefix is ~18.7-27k cached tokens per invocation.** A ten-call
burst billed **twenty** raw input tokens against 187,130 cache reads. On anything
short the prefix is the bill — which is why a run must be a substantial unit of
work, and why warm containers and temporally clustered runs matter.

**A 5-hour session is worth roughly $10 of Opus-equivalent.** Usage draws the
interactive session bucket, so agent work competes with whoever is using Claude
Code at their desk — expect about one substantial session per window, per
credential in the pool. Rotation does not create allowance; it moves to the next
bucket when one runs out, and then stops cleanly.

**`effort` multiplies all of that.** The level is per turn, so it compounds over
a session rather than being paid once, and the client's own cost table is where
the multiple is legible: against `high`, which is what the frontier models
default to, Opus 5 prices `xhigh` at 1.6x and `max` at 1.7x. Set against a bucket
nobody can read, that is a choice about how many sessions a credential holds.
Depth is usually the right thing to buy here — a coding run that finishes is
worth more than two that half-finish — but it is bought, not free.

## What this deliberately does not do

- **No `--bare` and no `--settings` override.** A cloned repository's `CLAUDE.md`,
  skills and hooks are exactly the material that makes the agent good at that
  repository. The container already runs the repo's `postinstall` and its test
  suite, so suppressing `.claude/` closes one door while the others stand open by
  design — it costs the agent its context and buys nothing. Containment is the
  credential swap. A deployment's `env` cannot set `CLAUDE_CONFIG_DIR`: the
  harness mirrors only each session's `.claude/projects`, so a moved one is a
  conversation a lost container cannot resume.
- **No claude.ai login flow, ever.** Credentials are BYO-paste from
  `claude setup-token`. Anthropic does not allow third-party developers to offer
  claude.ai login or subscription rate limits for their products.
- **No metering in the egress.** The bucket says when it is empty, and rotation
  acts on that. See above.
- **No `--max-turns`.** A ceiling on the outer session's turns bounds nothing
  the package can see: Claude Code's own subagent tree is invisible to the agent
  running the session and multiplies whatever the flag says. What it does instead
  is stop a long session mid-edit at a number picked without reference to the
  task, leaving a half-finished checkout that costs more to read than the turns
  saved. `timeoutMs` is the ceiling.

> A deployment-wide subscription token means one person's plan backs everyone
> using that deployment. That is fine for a single-operator fork and it is the
> shape Anthropic's terms target for multi-tenant. Per-human scoping is not
> expressible today.
