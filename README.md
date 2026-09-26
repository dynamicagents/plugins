# @dynamicagents/plugins

**Optional, composable capabilities for a Dynamic Agent.**

One subpath per plugin, one factory per subpath, config passed at instantiation. Your bundle
grows only with what you import.

```bash
npm install @dynamicagents/plugins
```

> Part of a three-package split:
> [`@dynamicagents/core`](https://github.com/dynamicagents/core) (the mandatory foundation) ·
> **`@dynamicagents/plugins`** (this) ·
> [`starter`](https://github.com/dynamicagents/starter) (a working agent that composes them).

---

## The one file you edit

An agent installs plugins by listing them in `getPlugins()`, on an `A2AAgent` from
`@dynamicagents/core/agent` or a `SubAgent` from `@dynamicagents/core/subagent`:

```ts
// src/agents/coder/agent.ts
import { A2AAgent } from "@dynamicagents/core/agent";
import { browser } from "@dynamicagents/plugins/browser";
import { computer, computerWorkspace } from "@dynamicagents/plugins/computer";
import { repo } from "@dynamicagents/plugins/repo";

export class Coder extends A2AAgent<Env> {
  // `computer` runs commands in a container, so the agent's own workspace —
  // what Think's `read` and `write` work on — has to be that container's.
  override workspace = computerWorkspace(workspaceConfig(this.env), () =>
    this.pluginContext().runtime()
  );

  override getPlugins() {
    return [
      browser({ binding: this.env.BROWSER }),
      computer(workspaceConfig(this.env)),
      repo(repoConfig(this.env))
    ];
  }
}
```

Delete a line and that module leaves your bundle entirely. Nothing in core imports a plugin,
and there is **no root barrel** — `@dynamicagents/plugins` on its own does not resolve — so the
guarantee is structural rather than a tree-shaker's opinion. `npm run verify:exports` asserts
it on the built graph before every publish.

`getPlugins()` is a method, not a module-level array: on Workers `env` does not exist at
module scope. Core checks the list when the agent starts — every declared binding present,
every tool name offered once — so a wiring fault fails the start with a sentence naming the
plugin, not the first turn.

A plugin's tools are the same wherever it is installed, so what a sub-agent must not have is
left out of its own `getPlugins()`, and `restrictTools` from `@dynamicagents/core` narrows a
plugin to the tools an install names.

---

## The plugins

| Subpath                            | What it adds                                                                                                        | Needs                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`/browser`](src/browser/)         | Read web pages via Browser Rendering Quick Actions                                                                  | `BROWSER` (paid plan)                              |
| [`/claude-code`](src/claude-code/) | Sub-agents whose model is a Claude Code session in the workspace container                                          | one or more `claude setup-token` credentials       |
| [`/computer`](src/computer/)       | A Linux container whose filesystem outlives it — shell, package manager, network, and the Durable Object it runs in | `@cloudflare/computer`, `@platformatic/vfs` (paid) |
| [`/repo`](src/repo/)               | Clone, commit, push a branch, open a pull request — over any container                                              | `GITHUB_TOKEN`                                     |
| [`/scratch`](src/scratch/)         | A throwaway git repository with no remote, for work that needs a container but no checkout                          | —                                                  |

Each directory has its own README with the config shape and a paste-ready `wrangler.jsonc`
snippet — a plugin cannot add its own binding, which is why it declares what it needs.

---

## Writing one

```ts
import { definePlugin, type AgentPlugin } from "@dynamicagents/core";
import { tool } from "ai";

export function scraper(config: { apiKey: () => string }): AgentPlugin {
  return definePlugin({
    name: "scraper",
    tools: (ctx) => ({ fetch_page: tool({/* … */}) }),
    context: [
      { provider: { get: async () => "You can fetch and summarize a page." } }
    ],
    requires: { secrets: ["SCRAPER_API_KEY"] }
  });
}
```

The rules the whole design rests on:

- **Never name a consumer's `Env`.** It is an ambient interface `wrangler types` generates
  into _their_ app. Take bindings and secrets as config, which is also the only thing that
  works on Workers, where `env` has no module scope.
- **`definePlugin` sets `contractVersion`** from the core you compiled against. Never write
  that number as a literal — the point is that it moves, so a version train that leaves one
  repo behind fails at startup with a sentence instead of a structural-type error.
- **Give a context block a get-only provider.** A block with no provider is wired as a
  writable one, which the model can overwrite with `set_context`.
- **Read `ctx.runtime()` inside `execute`, never while building tools.** It is what a
  sub-agent's spec prepared for the running dispatch, and it belongs to the turn.

A write that must not happen twice — a comment, a reply — is a Think `action()` in
`actions(ctx)`, with an idempotency key, so a recovered turn replays it rather than
repeating it. [`/repo`](src/repo/) has two.

A plugin that owns a domain some work is delegated into exports a `SubAgentSpec` as data,
and the agent binds it to a `SubAgent` class — see [`/claude-code`](src/claude-code/).

## Testing

Specs run inside real workerd via `@cloudflare/vitest-plugin`, with the harness from
`@dynamicagents/core/testing`.

```bash
npm test          # the whole suite, no credentials and no network
npm run check     # prettier + eslint + tsc + build, then verify:exports over it
```

### Working against an unpublished core

A plain `npm install` resolves `@dynamicagents/core` from whatever this branch's
`package.json` declares — `AGENTS.md` says which — and does it right over a local build
you are testing against.

```bash
npm run link:local   # npm pack + tarball install from ../core
```

Run it after changing core, **and after any `npm install` here**, which silently
undoes it. Skipping it is quiet and misleading: `tsc` reports errors in _this_
repo's source for a contract change sitting uninstalled one directory away.

`npm pack` + tarball, deliberately — not `npm link`, which symlinks the checkout and
gives it its own copy of every peer. Two copies of `agents` in one bundle breaks the
`Session` types and every `instanceof`, at runtime rather than at the type level.
Nothing is written to `package.json`, so CI never builds against a local checkout.

## License

Apache-2.0
