# `@dynamicagents/plugins/claude-code`

Sub-agents whose model is the **Claude Code CLI**, running inside the agent's
workspace container against the durable checkout.

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

## The shape: two sub-agents, and the session is their model

Unusual for this package, and it is the whole design. Claude Code brings its own
tools, its own loop and its own context management, so there is nothing for an
agent loop to drive. So this package exports no plugin: it exports two
`SubAgentSpec`s — `CLAUDE_CODE_AGENT` (`claude_code`, which writes) and
`CLAUDE_CODE_READER_AGENT` (`claude_code_read`, which works in a throwaway copy) —
and `claudeCodeModel`, a language model whose one call runs a session. A host binds
each spec to a `SubAgent` whose `getModel()` returns one, and Think's recovery does
the rest: a turn cut by an eviction or a deploy is continued, and the model resumes
the session from where it was.

Both run **detached**: the parent's call returns at once, and the report arrives
as a later turn. A session runs for up to its `timeoutMs`, past a parent's turn.

**One sub-agent run is one `claude -p` session.** Not one turn, and not one tool
call — the unit has to be substantial, because of what an invocation costs before
it does anything (see [Costs](#costs)).

Two nested notions of "subagent" that must never be conflated:

|                               | Dynamic Agents sub-agent run                   | Claude Code subagent          |
| ----------------------------- | ---------------------------------------------- | ----------------------------- |
| Durable                       | yes                                            | no                            |
| Visible to the parent agent   | yes                                            | **no**                        |
| Cancellable by Dynamic Agents | yes                                            | **no**                        |
| Bounded by                    | `timeoutMs`, enforced by the container runtime | `CLAUDE_CODE_MAX_*`, advisory |

## The credential never enters the container

The container is an arbitrary-code-execution environment by design: `npm ci` runs
whatever `postinstall` a cloned repository ships, and the agent runs that
repository's own build and test commands. So nothing secret goes in it.

The session launches with `CREDENTIAL_PLACEHOLDER`. `computerd` intercepts every
outbound request and hands it to `claudeCodeEgress` on the **Worker** side, which:

1. **swaps** the placeholder for a real credential, for `api.anthropic.com` only;
2. **strips** every credential header from anything else;
3. optionally **restricts the container to named hosts** — exact hostname match,
   no wildcards, and **off by default** (see below);
4. **rotates** to the next credential when Anthropic says the current one's
   bucket is spent (see below).

A `postinstall` that dumps its environment learns the placeholder and nothing
else. It runs as root, so `/proc/1/environ` is still readable — the placeholder is
what protects the credential, not the process boundary.

### Egress is unrestricted by default

`restrictToHosts` is three-way, and each value means literally what it says:

| Value                    | Effect                         |
| ------------------------ | ------------------------------ |
| omitted                  | unrestricted — **the default** |
| `["registry.npmjs.org"]` | that host, plus Anthropic      |
| `[]`                     | Anthropic only                 |

An empty array is deliberately _not_ the same as omitting the field: a host
computing the list from config that happens to produce `[]` means "nothing
extra", and reading that as "everything" would hand the widest policy to an
expression that returned nothing.

Open is the default because a curated list is permanently wrong for a coding
agent — `esbuild`, `swc` and `sharp` fetch prebuilt binaries from release CDNs,
Playwright downloads browsers from a third host, corepack fetches package
managers, and reading documentation is part of the job. It also matches
[`/computer`](../computer/), whose egress has always been unrestricted.

**What that gives up is a bound on exfiltration**, and it is worth being plain
about: the container holds the checkout and, unrestricted, can send it anywhere.
It does not weaken the credential — the swap is keyed on the destination and
credential headers are stripped from everything else, whatever the policy says.
So the containment here is _"the container holds no credential"_, and nothing
more. Set `restrictToHosts` if you want the other property; do not assume it.

One rule applies regardless of policy: hosts naming the gateway's **own** side
of the boundary — `computer.internal` and loopback — are always refused. Under
`mode: "direct"` the container's traffic leaves from the container's network
position; under `http-gateway` **the Worker makes the request**, so an
unrestricted policy hands the container the Worker's reach, and bouncing a
request back into the loopback the intercept rides on is never legitimate.

Nothing sets `ANTHROPIC_BASE_URL`. The intercept is transparent, so the client
talks to the real hostname — which means nothing in the container is _told_ to
use a proxy, and nothing in the container can be told not to.

### The 5-hour and weekly limits: rotate, do not predict

A Claude subscription has a rolling 5-hour bucket and a weekly one. Neither is
readable, and an earlier version of this package tried to stay under them by
_estimating_ spend — a dollar counter, a cap, and a gate that refused to start
work when the counter got high. That was the wrong instrument twice over: the
estimate is a guess about a bucket nobody can see, and it only moved when a run
_ended_ (usage is learned from the terminal `result` event), so it was never a
cap on spend at all — only a gate on starting.

The gateway sees Anthropic's actual response, which is the one place the bucket
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
- **A `401`/`403` retires an entry for good**, rather than until a reset — a
  revoked credential does not heal on a timer. The response is rewritten to a
  `429` on the way out, because a client does not retry a `401` and would
  otherwise fail the run on a credential the gateway has already stopped using.
- **When every entry is spent**, the real wait goes through: a `429` naming the
  earliest reset, so the run ends cleanly having said when to come back. When
  every entry is _rejected_ it is a `500` instead, because that one needs an
  operator and a `429` would hide it behind a retry loop.

State lives wherever the host's {@link CredentialStore} puts it. Keeping it in
the workspace Durable Object's own storage is the intended shape: each workspace
learns a rotation independently, which costs one wasted `429` per workspace per
rotation and saves a Durable Object class, a binding and a migration.

> **The detection rules are inferences, not observations.** No genuine
> subscription-exhaustion `429` has been captured through this path — the
> ones seen during development were the _raw-API_ refusal, which is a different
> response — so `readRefusal` reads `retry-after`, then
> `anthropic-ratelimit-unified-reset`, then falls back to a long default. The
> gateway logs every `401`/`403`/`429` whole, headers and body, precisely so the
> first real one can replace the inference with a fact.

## What the host must provide

```jsonc
// wrangler.jsonc
{
  "containers": [
    {
      "class_name": "ClaudeCoderWorkspaceDO",
      "image": "./Dockerfile",
      // A Docker build arg. One Dockerfile serves both the plain workspace and
      // this one; only the entry naming a version gets the CLI.
      "image_vars": { "CLAUDE_CODE_VERSION": "2.1.238" },
      "instance_type": "standard-2",
      "max_instances": 5
    }
  ],
  // The container is bound to a Durable Object, and the class has to exist as
  // well as be named. Both of these are required: without the binding the
  // backend has nothing to dial, and without the migration the class is never
  // created — which surfaces at runtime, not at deploy time.
  "durable_objects": {
    "bindings": [
      {
        "class_name": "ClaudeCoderWorkspaceDO",
        "name": "CLAUDE_CODER_WORKSPACE"
      }
    ]
  },
  // `new_sqlite_classes`, not `new_classes`: the workspace filesystem *is* the
  // object's SQLite. And a **new tag** — a class appended to a tag you have
  // already deployed is silently never created.
  "migrations": [
    { "tag": "v5", "new_sqlite_classes": ["ClaudeCoderWorkspaceDO"] }
  ],
  // The pool, in priority order — **exactly the credentials you have**.
  //
  // `secrets.required` drives type generation and `wrangler dev`'s
  // missing-secret warnings, so a name listed here and left unset is typed as a
  // definite string that is undefined at runtime, and warns on every local run.
  // For a single-credential deployment, drop `_2` from this list *and* from the
  // `credentials` array below — they are one change, not two.
  "secrets": {
    "required": ["CLAUDE_CODE_OAUTH_TOKEN_1", "CLAUDE_CODE_OAUTH_TOKEN_2"]
  }
}
```

The class must also be exported from the Worker entry point, along with
`WorkspaceProxy` from `@cloudflare/computer` — the container dials back through
it, and dropping that export breaks the container with no compile error.

Pin the CLI version deliberately: the wire shape this package's gateway and
parser are both written against is version-coupled, so re-run the smoke test on
every bump.

The workspace Durable Object installs the gateway as its egress policy:

```ts
readonly #session = claudeCodeSession({
  // Order is priority, and this example is a rotating deployment: two entries.
  // One is a complete deployment too — it simply gives up when its bucket empties
  // instead of rotating. `.filter(Boolean)` is defence against a secret that is
  // declared and unset, not a substitute for declaring the right ones.
  credentials: () =>
    [
      this.env.CLAUDE_CODE_OAUTH_TOKEN_1,
      this.env.CLAUDE_CODE_OAUTH_TOKEN_2
    ].filter(Boolean),
  // Who the session's own commits, amends and rebases are attributed to. The
  // same pair the workspace's `git.author` takes: a session commits in
  // repositories nothing configured, and a checkout's config is a value frozen
  // when that checkout was created.
  author: { name: env.GITHUB_NAME, email: env.GITHUB_EMAIL },
  // Omit for unrestricted, which is the default.
  restrictToHosts: ["registry.npmjs.org"]
});

/** The pool's `{ index → resetAt }` map, in this object's own storage. */
readonly #credentials: CredentialStore = {
  read: async () => (await this.ctx.storage.get(CREDS_KEY)) ?? [],
  write: (states) => this.ctx.storage.put(CREDS_KEY, states)
};

readonly backend = new CloudflareContainerBackend({
  container: () => this,
  workspace: { binding: "CLAUDE_CODER_WORKSPACE", id: this.ctx.id.toString() },
  egress: {
    mode: "http-gateway",
    gateway: this.#session.egress(this.#credentials)
  }
});
```

`egress` takes the store as an **argument** rather than reading it off the
config, and that is deliberate: the same config object is also held by the
agents that run sessions, which have no storage of their own for it. Making it a
field would force them to invent one.

> **`mode: "http-gateway"` intercepts _all_ egress**, so a restriction you do
> configure is load-bearing for `npm ci` too. A restricted gateway that forgets
> the registry does not degrade the agent — it stops the container installing
> anything. This is the main reason the default is open.

### Your image must trust the interception CA

This is the step that is easy to miss and expensive to diagnose, because
nothing in this package can do it for you.

`http-gateway` is implemented with `container.interceptAllOutboundHttp(…)` and
`container.interceptOutboundHttps("*", …)`. Both take a `Fetcher`, so what is
intercepted is the container's **HTTP and HTTPS** traffic, for every host — and
the HTTPS half is _terminated and re-originated_ by Cloudflare's runtime rather
than tunnelled. It presents a certificate signed by an ephemeral CA it mounts at
`/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The file exists only while
the container runs, so it cannot be baked into the image — it has to be
installed from the entrypoint, before anything starts:

```dockerfile
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt' \
      'if [ -r "$CA" ]; then' \
      '  install -m 644 "$CA" /usr/local/share/ca-certificates/cf-containers-ca.crt' \
      '  update-ca-certificates > /dev/null' \
      'fi' \
      'exec /usr/local/bin/computerd "$@"' \
    > /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh

# Node ignores the system store, and a command inherits nothing from the
# daemon's own environment — see below.
ENV COMPUTER_VAR_NODE_OPTIONS=--use-openssl-ca

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

> **`update-ca-certificates` on its own is not enough.** Node carries its own
> bundled root store and ignores the system one, and the two clients that matter
> here are both Node: `npm ci` and Claude Code itself. The `ENV` line above is
> what actually unblocks them; the trust-store update covers everything else a
> session shells out to — `curl`, `git` over https, `pip`.
>
> **It must carry the `COMPUTER_VAR_` prefix.** A command spawned by the
> workspace inherits `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `TERM` and the
> `LC_*` family from the daemon, and nothing else — that is what keeps the
> daemon's own secret out of a repository's `postinstall`. Anything else a
> command needs is passed per exec, or named `COMPUTER_VAR_<NAME>` in the image
> and delivered as `<NAME>`. An `ENV NODE_OPTIONS=…` or an `export` in the
> entrypoint reaches the daemon and stops there, which fails as a TLS error in
> every session with nothing pointing at the environment.
>
> The same applies to every other variable an image sets for the commands it
> runs — `CI`, `HUSKY`, `NO_COLOR` — none of which reach a command unprefixed.

No `|| true` on that line, deliberately. It is a required step, not a
nicety — swallowing its failure leaves `curl`, `git` and `pip` unable to
use intercepted HTTPS while the container comes up looking healthy, which
resurfaces later as exactly the class of unattributable TLS error this whole
section exists to prevent. `set -e` fails the entrypoint instead, and stderr is
left alone so the reason is in the container's logs.

Skip the CA entirely and the container has no working HTTPS client at all,
which surfaces as two unrelated-looking failures with no mention of egress in
either:

| Client      | What you see                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm ci`    | `npm error code SELF_SIGNED_CERT_IN_CHAIN`                                                                              |
| `claude -p` | `API Error: Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates` |

Keep it conditional on the file being readable, as above, so one image can also
serve a `mode: "direct"` agent and `wrangler dev`, where nothing is intercepted
and the path does not exist.

> **Non-HTTP TLS is a different question, not a solved one.** Interception is
> HTTP-shaped, so a raw TLS connection — a database, SMTP — is not re-signed
> with this CA and this section does not make it work. Under `http-gateway` the
> container starts with `enableInternet: false`, so such a connection has
> nowhere to go at all. Plan for that rather than expecting a certificate error.

And a sub-agent runs a session as its model:

```ts
export class ClaudeCoderSession extends SubAgent<Env> {
  // `prepare` claims a workspace of this run's own and returns where its
  // checkout is; `settle` releases it on every terminal. Both are the host's:
  // which object a run gets, and how it acquires a checkout, are facts about a
  // deployment, and cloning belongs to `/repo`.
  static override spec = { ...CLAUDE_CODE_AGENT, prepare, settle };

  override getModel() {
    const { workspaceName, dir } = this.pluginContext().runtime() as {
      workspaceName: string;
      dir: string;
    };
    const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
      this.env.CLAUDE_CODER_WORKSPACE.idFromName(workspaceName)
    );
    return claudeCodeModel({
      config: CLAUDE_CODE_SESSION,
      workspace: () => openWorkspace(stub) as Promise<SessionWorkspace>,
      storage: this.ctx.storage,
      runId: this.name,
      kind: "write",
      dir,
      note: (key, text) => this.note(key, text),
      // Once per run, before the session starts. A throw fails the run with its
      // message — how a host refuses a run its credentials cannot pay for.
      brief: async (task) => this.#brief(task, stub),
      // One more turn for a session that left work uncommitted, or none.
      followUp: async (session) => this.#uncommittedPrompt(session),
      // What the parent receives. Run once, and kept.
      report: async ({ session, followUp }) => this.#report(session, followUp)
    });
  }
}
```

The model keeps every step it has taken in the sub-agent's own storage — the
brief, the drain's cursor, the session's end, whether a follow-up was asked for
and how it ended, and the report. A continued turn calls it again and finds them,
so it re-attaches rather than starting a second session, asks nothing twice, and
reports once.

**The report is the only text the model streams.** A run's result is what its
assistant messages say, so narration streamed as text would become the result.
What the session says as it works goes to the parent as **notes**, through
`note`, each keyed on its exec and its position: the parent's transcript dedupes
on the key, so a note filed again after a restart is dropped, and two runs in one
task never collide. Nothing else is streamed at all — Think's stall watchdog is
off, so a silent stream is not cut.

**The follow-up is a second exec.** `claude -p --resume` under an exec id of its
own, so its cursor and its notes are its own. The transcript is on the container's
disk, so it runs in the workspace the session did. `stop` ends it with the session.

**The cursor is stored behind the notes.** It rides the same chain as the notes it
counts, so a stored position never names a note that was not filed; a drain that
dies resumes from it and files only what came after. Without it, a drain that died
would replay the whole stream — one production run lost six and a half minutes of
a session that way.

**`runId` namespaces the exec id, and it is not optional.** Runs are concurrent —
reading runs share their parent's container — so two sessions sharing an id would
spawn over each other, each drain would attach to whichever won, and `stop` would
kill the wrong one.

**A cancelled turn stops the session.** The model's abort signal stops the drain,
kills both execs and deletes a reading run's copy.

**`runtime()` is where the workspace comes from.** The spec's `prepare` runs on the
parent, where the caller is known, and returns the workspace name and the
checkout; the sub-agent reads both back from `runtime()`. It is deliberately not
the sub-agent's input, because the parent's model writes that, and a model-authored
workspace name would let it name somebody else's.

`getWorkspace` rebuilds a real `WorkspaceRuntimeExecHandle` on the client side
from the stub's byte stream, so the drain works across a Durable Object boundary
and the container→workspace filesystem sync still fires when the stream reaches
`done`.

**Fires, not succeeds — and the host owns what happens then.** That pull can fail
while the session itself finished: a transport that dropped, a container replaced
underneath it. The runtime reports that on the execution result, which the drain
does not see, and nothing retries it on its own. A host that cares about a
session's edits reaching the checkout — anything that then commits or pushes from
the workspace side — should drive `workspace.pull()` to completion before it
reads, and certainly before it stops the container. A session that wrote an
install's dependency tree makes that pull a large one.

## The permission mode, and why it bypasses

`-p` is headless. There is no terminal, so nothing can answer a permission
prompt — and Claude Code's headless path does not wait for one, it **auto-denies**.

That makes the CLI's default mode unusable here, in a way that does not look like
a failure. `default` gates Write, Edit and every Bash command, so a session left
on it reads the repository perfectly, cannot change one byte of it, and reports
prose that reads like considered reluctance rather than a blocked tool. It exits
0, and the run is reported as completed.

Both of those are still true, and they are why the mode is set explicitly rather
than left to a reader of the report to notice. What has changed is that the
denial is no longer silent: each refused call now arrives as a
`permission denied for <Tool>: …` progress note and the count lands in the
session's footer, so a run that did nothing says so somewhere. Before that, the
only trace was a `permission_denials` field nothing read — which is how a
deployment spent a release refusing every write while reporting success.

So `permissionMode` defaults to `bypassPermissions`, and the narrower modes are
not alternatives:

| mode                | what a session can do                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `default`           | read only — everything else is auto-denied                                                             |
| `acceptEdits`       | edit files; `npm ci`, `git` and the test suite still denied                                            |
| `dontAsk`           | "deny if not pre-approved" — the default's behaviour, named                                            |
| `plan`              | reads and produces a plan, changing nothing — and there is no interactive session here to approve it   |
| `auto`              | a model classifier rules on each call, spending the same subscription bucket the session is drawing on |
| `bypassPermissions` | the whole job                                                                                          |

What makes bypassing acceptable is not the flag being careful. It is that the
container has nothing left to protect: it holds no credential — the real one is
swapped in by the egress gateway on the Worker side — and it already runs a
cloned repository's `postinstall` and its test suite, which is arbitrary code
execution by design. Gating the agent's own edits while those doors stand open
costs the agent its job and buys nothing. Containment is the credential swap.

**A reading session runs under the same mode.** What keeps it from touching
anything is where it runs, not what it may do: a copy of the parent's checkout on
container disk, outside the workspace mount, deleted when the session ends — see
`copy.ts`. Every mode that refuses an edit also refuses the commands a question
usually needs answered.

> **The container runs as root, and that changes how the flag has to be passed.**
> The CLI refuses to bypass its permission checks under uid 0 unless `IS_SANDBOX=1`
> is set — it exits 1 _before_ its first JSON line, with the only explanation on
> stderr. `buildLaunch` writes both in one branch so they cannot drift, and applies
> the variable after a host's `env` so a host cannot unset it. If you run an image
> that does not exec as root, that variable is the line to delete.

A deployment that wants a different posture sets `permissionMode` and gets it —
including `default`, if what it wants is a session that can only read. Whatever
it picks, the denials are reported rather than inferred, which is what makes
picking something other than the default a decision rather than a surprise.

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

- **No `--bare`, no `--settings` override, no `CLAUDE_CONFIG_DIR`.** A cloned
  repository's `CLAUDE.md`, skills and hooks are exactly the material that makes
  the agent good at that repository. The container already runs the repo's
  `postinstall` and its test suite, so suppressing `.claude/` closes one door
  while the others stand open by design — it costs the agent its context and buys
  nothing. Containment is the credential swap.
- **No claude.ai login flow, ever.** Credentials are BYO-paste from
  `claude setup-token`. Anthropic does not allow third-party developers to offer
  claude.ai login or subscription rate limits for their products.
- **No metering in the gateway.** Spend estimates were tried and removed; the
  bucket says when it is empty, and rotation acts on that. See above.
- **No `--max-turns`.** A ceiling on the outer session's turns bounds nothing
  the package can see: Claude Code's own subagent tree is invisible to the agent
  running the session and multiplies whatever the flag says. What it does instead
  is stop a long session mid-edit at a number picked without reference to the
  task, leaving a half-finished checkout that costs more to read than the turns
  saved. `timeoutMs` is the ceiling, and the container runtime enforces it.

> A deployment-wide subscription token means one person's plan backs everyone
> using that deployment. That is fine for a single-operator fork and it is the
> shape Anthropic's terms target for multi-tenant. Per-human scoping is not
> expressible today.
