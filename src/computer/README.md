# `@dynamicagents/plugins/computer`

An agent's tools over a container workspace. The workspace itself — the Durable
Object, its container, its git and its install — is
[`/workspace`](../workspace/).

```ts
import { computer, computerWorkspace } from "@dynamicagents/plugins/computer";

const config = {
  binding: env.WORKSPACE,
  workspaceName: () => `${callerKey()}|${owner}/${repo}`,
  shell: "bash"
};

class Coder extends A2AAgent<Env> {
  override workspace = computerWorkspace(config, () =>
    this.pluginContext().runtime()
  );
  override getPlugins() {
    return [computer(config)];
  }
}
```

Tools: `bash`, `grep`, `edit` — under Think's own names, so they replace Think's
built-ins. Think's `read`, `write`, `delete`, `find` and `list` stay Think's, and
reach the container's tree through the agent's workspace.

The tools reach the object only through `/workspace`'s client modules, never the
object itself, so an agent holding them carries no container backend and no
isomorphic-git.

## The agent's workspace is the container's

Think's `read`, `write`, `edit` and `delete` work on whatever the agent's
`this.workspace` is. An agent that installed this plugin but kept Think's own
workspace would run `bash` in the container and `write` in its own SQLite, and
nothing would say so. So the agent sets `workspace = computerWorkspace(config, …)`,
and the plugin **refuses to start** on any other — a `PluginSetupError` naming what
to set. Its tools then reach the container through that workspace rather than
through their own config, so `bash` and Think's `write` always resolve the same one.

`computerWorkspace` reads the workspace object's filesystem directly, without
starting a container. Every call resolves the workspace the running turn names, so a
sub-agent's reaches the checkout its parent prepared. It holds this plugin's rules:
`.git` and `node_modules` are refused for reads and writes alike, a write is refused
while the workspace cannot keep it, walks prune the skipped directories, and a read
is never truncated — Think's `edit` writes back what it read. It offers no byte
writes, so Think's evicted media and projected skills never land in a checkout.

`edit` is this plugin's rather than Think's because Think's is two calls — a read,
then a write — and a lock inside the workspace cannot span them. The AI SDK runs one
step's tool calls concurrently, so two edits to one file would lose one. This `edit`
holds the file's lock across both, and a `write` through the workspace takes the
same lock.

## `node_modules` is not in the workspace

It is a bind mount of the container's disk — see [`/workspace`](../workspace/).
The file tools read the workspace, so they refuse `node_modules` paths and route to
`bash`. Walks skip it with `.git`: the workspace's `glob`, which Think's `find` walks
with, passes both to the store as exclusions, so the store never walks them, and
`grep`, whose store search takes no exclusion, filters its results.

## `.git` is off limits

Present in the workspace, refused by the file tools anyway, and skipped by walks.
Reading it tells the model less than [`/repo`](../repo/) does, and writing it
corrupts the checkout. Repository work goes through the repo tools.

## Searching

`grep`, `find` and `list` read the durable workspace rather than the container, so
they keep answering while it restarts or while an install runs — which is exactly
when an agent would otherwise be blocked. `grep` is this plugin's: it searches inside
the workspace object in one call, bounds its matches at the source and reports the
`offset` that continues a cut result, where Think's own `grep` reads every file under
the root through the workspace, one call per file. `find` and `list` are Think's.

The store's search takes no exclusion, so `grep` from a checkout's root reads `.git`
too before filtering it out. Give it a `path` below the root, or an `include`.

## The container is the trust boundary

Two things run in it that nobody reviewed: the commands the model writes, and the
repository it was asked to clone. `npm ci` executes that repository's lifecycle
scripts, so "we only ran the install" is still running a stranger's code. Treat
anything inside the container as reachable by both.

Consequences worth stating outright:

- **No secret belongs in `ComputerConfig.env`.** It is merged into every command
  these tools run, and `bash`'s command is model-authored — `bash("printenv")` prints the lot,
  and so does a `postinstall`. Use it for a registry host or a `CI` flag, not a key.
  When an agent needs to _act_ with a credential, keep the credential on the Worker
  and give the agent one tool that makes the call:
  [`/repo`](../repo/)'s `repo_open_pr` is the worked example, and its token never
  enters the container at all.
- **`grep`'s `regex` compiles a model-authored pattern** and runs it over every
  file under `path`, inside the Durable Object. A catastrophic-backtracking pattern
  therefore spends that object's CPU budget rather than the container's. The
  runtime's own limits bound it, and it costs the agent its own turn, but it is the
  one value a model supplies here that reaches a compiler.

## Requirements

[`/workspace`](../workspace/)'s: a workspace object, the Workers **Paid** plan, and
`@cloudflare/computer`.
