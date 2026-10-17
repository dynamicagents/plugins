# `@dynamicagents/plugins/computer`

An agent's tools over a container. The container itself — the Durable Object,
its git and its install — is [`/sandbox`](../sandbox/), whose checkout is the
container's own disk.

```ts
import { computer, computerWorkspace } from "@dynamicagents/plugins/computer";

class Coder extends StepAgent<Env> {
  override workspace = computerWorkspace(
    { binding: this.env.CODING_SANDBOX, sandboxName: () => this.name },
    () => this.pluginContext().runtime()
  );
  override getPlugins() {
    return [computer({ shell: "bash" })];
  }
}
```

Tools: `bash`, `grep`, `edit` — under Think's own names, so they replace Think's
built-ins. Think's `read`, `write`, `delete`, `find` and `list` stay Think's, and
reach the container's tree through the agent's workspace.

The tools reach the sandbox over RPC, never through its object, so an agent
holding them carries no container backend.

## The agent's workspace is the container's

Think's `read`, `write`, `edit` and `delete` work on whatever the agent's
`this.workspace` is. An agent that installed this plugin but kept Think's own
workspace would run `bash` in the container and `write` in its own SQLite, and
nothing would say so. So the agent sets `workspace = computerWorkspace(config, …)`,
and the plugin **refuses to start** on any other — a `PluginSetupError` naming what
to set. Its tools then reach the container through that workspace rather than
through their own config, so `bash` and Think's `write` always resolve the same one.

Every call resolves the sandbox the running turn names, so a sub-agent's reaches the
checkout its parent prepared, and every call reaches the container: a file read
wakes a stopped one. The workspace holds this plugin's rules: `.git` and
`node_modules` are refused for reads and writes alike, walks prune the skipped
directories, and a read is never truncated — Think's `edit` writes back what it
read. It offers no byte writes, so Think's evicted media and projected skills never
land in a checkout.

`edit` is this plugin's rather than Think's because Think's is two calls — a read,
then a write — and a lock inside the workspace cannot span them. The AI SDK runs one
step's tool calls concurrently, so two edits to one file would lose one. This `edit`
holds the file's lock across both, and a `write` through the workspace takes the
same lock.

## `node_modules` and `.git` are left out

`node_modules` is installed output, not source: the file tools refuse its paths and
route to `bash`. `.git` is refused as policy: reading it tells the model less than
[`/repo-github`](../repo-github/) does, and writing it corrupts the checkout. Walks
skip both — `grep` and `find` are `ripgrep` in the container, as the agent, with the
two pruned — so an excluded directory is never descended into at all. Hidden and
ignored files are read.

## Searching

`grep` is this plugin's: one `ripgrep` in the container, its matches bounded at the
source, and the `offset` that continues a cut result — where Think's own `grep`
reads every file under the root through the workspace, one call per file. `find`
and `list` are Think's. Searching a checkout's root needs no narrowing of its own:
the walk prunes `.git` and `node_modules` before it reaches them, so a `path` or an
`include` only narrows what you want to _see_.

## Commands

A command runs as the agent under `timeout` at its limit, and a cancel marks it
before signalling it, so one still starting the container never runs. While an
install is in flight, a command that reads `node_modules` waits for it, up to
`installGateMs`; anything else runs at once.

## The container is the trust boundary

Two things run in it that nobody reviewed: the commands the model writes, and the
repository it was asked to clone. `npm ci` executes that repository's lifecycle
scripts, so "we only ran the install" is still running a stranger's code. Treat
anything inside the container as reachable by both.

**No secret belongs in `ComputerToolsConfig.env`.** It is merged into every command
these tools run, and `bash`'s command is model-authored — `bash("printenv")` prints
the lot, and so does a `postinstall`. Use it for a registry host or a `CI` flag, not
a key. When an agent needs to _act_ with a credential, keep the credential on the
Worker and give the agent one tool that makes the call:
[`/repo-github`](../repo-github/)'s `repo_open_pr` is the worked example, and its
token never enters the container at all.

## Requirements

[`/sandbox`](../sandbox/)'s, with `ripgrep`, `timeout` and `pkill` in the image.
