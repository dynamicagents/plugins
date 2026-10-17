# AGENTS.md — working in `@dynamicagents/plugins`

`README.md` covers what a plugin is, which file you edit, how to write one and
how to test it. This file holds the conventions that are not about any one
plugin.

---

## Comments

This repo comments heavily, and that is deliberate: a lot of what is here was
expensive to learn and invisible in the code. The cost is that comments rot, so
they are held to the same bar as the code.

A comment states a **constraint, a measurement, or a coupling** — something that
changes a decision. Not what changed, not when, not what a previous version said;
`git log` owns that. In particular:

- **No changelog.** "This used to…", "removed in 0.8.2", "the design plan called
  for…", "this is not a reversal of…" are all history. Write the rule that
  survives it. A measurement is worth keeping; the date it was taken is not.
- **No package versions or dates** in prose. They are stale on the next bump and
  nothing checks them.
- **One home per fact.** Put the explanation in the file somebody edits when they
  change that behaviour, and a pointer everywhere else — comments here have
  `{@link file://../path/to.ts Name}` for exactly this. Four copies of the same
  paragraph in four files do not stay in step: they diverge, and then the reader
  cannot tell which one is current. This applies across the publish train too: a
  rule core enforces is explained in core, and pointed at from here.
- **No counts.** "the nine plugins", "the four families below", plugin counts,
  spec counts. Every one of these was wrong within a release. Name the thing, not
  how many there are.
- **Cross-file references name a real path**, and a path in a comment is
  checkable — so check it before you write it. Nothing in `check` verifies these
  for you here. A path into another repo of the train is not checkable from a
  consumer's checkout: name the module in prose instead of writing a path that
  resolves only in a full workspace.

If a comment is longer than the code it explains, ask what decision it is
protecting. Usually one paragraph of that is doing the work.

---

## Publishing

**Development lands on `main`, and a release is a PR that bumps the version.** npm is
the released line, not a branch: a merge without a bump ships nothing, so changes
batch on `main` until someone decides to release them, and a bump is a deliberate act
rather than something that rides every merge.

A version bump reaching `main` is what ships it: on the first green Test run for
a commit carrying that version, `.github/workflows/release.yml` publishes it to
npm over OIDC and only then cuts the tag. The bump is the decision to ship. The workflow comments hold
the rest.

Core ships first. A version here whose peer range admits a core that is not yet
on the registry is one nobody can install.

**The core references say different things, and both are load-bearing.** The
`peerDependency` stays a semver range, because that is the only one a published
consumer installs against — a git ref there would name a moving branch in somebody
else's `node_modules`. The `devDependency` is what this repo builds and tests
against, and it is the published core, so what ships was tested against a core a
consumer can install.

A change here that needs core work not yet published may point the devDependency at
core's `main` by git ref for as long as it needs to, which is how a core change is
exercised here before it is released. That ref installs only because core's `prepare`
builds and because `allowScripts` in `package.json` lists core, which is what lets npm
run that `prepare` — drop either and every core subpath resolves to a missing file.
The release PR puts the devDependency back on a range and drops the `allowScripts`
entry, and Release refuses to publish while any dependency still names a git ref. The
workspace AGENTS.md has the why.

`verify:peer-ranges` still holds that range honest: it reads the **installed** copy,
and a git-installed core reports its real version. What it cannot see is that core's
unreleased `main` still carries the last released version number, so while a git ref
is in place the installed core is that version plus whatever has landed since. That
is the cost of batching releases, and it is why the range is checked against the tree
rather than against the manifest.

---

## The GitHub MCP route

`/repo-github` reads GitHub through its **hosted MCP server**, from the Worker, with the
deployment's token as `Authorization: Bearer`. The transport is not here:
`@dynamicagents/core/mcp` holds it, over the official `@modelcontextprotocol/client`,
and core is where the protocol decisions are explained. `src/repo-github/mcp.ts` is the
policy that is GitHub's, and two things in it are policy rather than configuration:

- **`GITHUB_MCP_TOOLS` is an allowlist**, sent as `X-MCP-Tools`. Adding a name to it
  is a code change somebody reads, which is the point — a host that could widen it
  could hand the token to a tool nobody reviewed.
- **`GITHUB_MCP_URL` is the read-only endpoint.** Both caps, not either: the list is
  the narrow bound and the path is the one that still holds if the list is edited
  carelessly.

Both are named for the provider rather than for the protocol, because the protocol's
own surface is core's and a bare `MCP_TOOLS` here would not say whose policy it is.

`pull_request_review_write` is the absence worth knowing about. It is the only tool
that resolves a review thread, and the same name submits a review with `APPROVE`, so
taking thread resolution would mean taking self-approval. Nothing needs it — a
revising Claude Code session answers and resolves its own threads with `gh` inside
its container. `repo_pr_thread_reply` keeps this package's own GraphQL mutations for
the hosts that do want the tool.

**github.com only.** There is no `apiBase`: Enterprise Server has no hosted MCP
server to point at, and half this plugin on one host and half on another is worse
than not supporting it. `allowedHosts` still bounds _cloning_, which is generic git.

```bash
npm run probe:github-mcp              # check the server against what mcp.ts assumes
npm run probe:github-mcp -- --record  # and rewrite test/fixtures/github-mcp.json
```

It needs `GITHUB_TOKEN` and a pull request in `GITHUB_MCP_PROBE_PR`
(`OWNER/REPO#NUMBER`); it sends the token only to the endpoint `mcp.ts` names and
never prints it. **It mutates nothing, including when a restriction turns out not to
hold**: the legs that test the allowlist and the read-only path name a read and an
issue number the repository cannot have, so a failure is reported rather than
exercised. Point it at a real pull request without hesitating.

The specs run against the fixture offline, so the fixture is what makes a render
trustworthy — and until somebody has run the probe with `--record`, that file is
**derived from the server's published output types rather than observed**, which its
own header says. Re-record rather than editing it by hand: `--record` replaces every
value in it with that pull request's, which is why a spec asserting a _value_ states
it as an override and only the shape tests read from the file.

---

## Updating Claude Code

The `claude-code` plugin's sandbox egress (`src/claude-code/egress.ts`) and
stream parser (`src/claude-code/events.ts`) are written against one CLI version's traffic:
its auth header, its `anthropic-beta` list, the endpoints it calls, the fields of its
`stream-json` lines. A newer CLI can move any of it, and a deployment would find out
only in a running container. So the version is pinned. `VERIFIED_CLAUDE_CODE_VERSION`
(`src/claude-code/verified.ts`) is the one this package was last checked against, and
a deployment's image pins the same one. It moves only after the probe passes on the
new version, and the workspace's weekly dependency round runs it.

```bash
npm run probe:claude-code                  # the registry's latest; stops if already verified
npm run probe:claude-code -- <version>     # a version, or any dist-tag
npm run probe:claude-code -- --record      # and make it the verified version
npm run probe:claude-code -- --live        # the real API, on CLAUDE_CODE_OAUTH_TOKEN
npm run probe:claude-code -- --keep        # keep the temporary directory
```

**What it runs.** It stands in for the sandbox. The CLI is installed into a
temporary directory, never over the machine's own `claude`, launched with the
command, stdin and environment the daemon's `claudeCodeDaemonCli` gives a turn, and
read by that adapter's own parser. Its traffic goes to the placeholder host the
daemon points it at, over plain HTTP, through a local proxy standing in for the
harness's interception. Every request then goes through the real `sandboxEgress` and
`claudeCodeEgress`, leasing from a `credentialHost` pool, and on to a fake
Anthropic, or with `--live` to the real API. A session is run once and resumed; a
planning run — a named schema under `plan`, as a run header asks — is then forked
under the default mode, the way a plan is carried out, so every flag the daemon
passes is exercised — then asked to resume a conversation that does not exist,
which is the one run that must make no model call. Its client's own startup
requests are expected; `/v1/messages` is what it must not reach.

**It fails when:**

- the CLI does not exit 0 on a run meant to succeed;
- a `stream-json` line does not parse;
- a result's reply, structured answer or token counts do not read back. The fake
  reports a distinct count for each field, because the parser reads a renamed field
  as zero rather than failing;
- the resumed session is not the same session, or the forked one is not a new one;
- the planning run does not start in `plan`, or its structured answer does not come
  back through it;
- a resume of an unknown session does not report itself on a `result` line with
  `errors`, or spends a model call doing it;
- a request reaches Anthropic without the real credential, or with the placeholder or
  an `x-api-key` still on it.

**What changed is reported, not failed.** The run is compared with the verified
version's capture: each endpoint's header values, with `anthropic-beta` split into its
flags, endpoints added or gone, and each kind of line's fields. The report also lists
what the fake answered with a 404 and any host outside Anthropic the proxy refused.
That is what a reviewer reads before taking the bump, so it goes in the PR.

**The capture** is `test/fixtures/claude-code-probe-capture.json`: the verified
version's requests and its runs' lines, and what the fake answered them with. Header
values that vary by machine or run are recorded as `*`, and temporary paths are taken
out of the lines. `egress.spec.ts` and `events.spec.ts` read it, so `npm test`
checks the egress and the parser against what the verified version actually sends and
prints. The probe writes it and prettier skips it; do not edit it by hand. It is not a
VCR cassette: a cassette holds what a Worker's `fetch` gets back, and this holds what a
CLI we do not write sends and prints.

**`--record`** writes the capture and `verified.ts` together, and a spec fails when
their versions differ. It takes only a passing, offline run: a live run's traffic
depends on the account it ran on.

**A bump is:**

1. `npm run probe:claude-code` passes;
2. the same run with `--record`, then `npm test` against the new capture;
3. both files committed in the round's PR, with the report of what changed;
4. once that is on `main`, starter moves its image pin, and starter's `npm run check`
   fails until the two agree.

If the probe fails, the pin stays where it is and the round says which check failed.

**What it cannot see** is the container itself: the agent user, the platform's
interception of the placeholder host, and rotating to another credential after a
real `429`. A deployment's smoke test covers those after it ships.

It needs `npm` on the PATH, and no credential unless `--live`. It imports the package
from `dist/`, so the npm script builds first.
