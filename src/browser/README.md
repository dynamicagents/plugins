# `@dynamicagents/plugins/browser`

Drive a real browser, via Cloudflare Browser Run.

```ts
import { browser } from "@dynamicagents/plugins/browser";

browser({ binding: env.BROWSER, loader: env.LOADER });
```

One tool, `browser`: the model writes JavaScript that drives a persistent
browser over CDP, and that code runs in a Dynamic Worker with no network of its
own. The browser outlives each call, so tabs, cookies and logins carry over, and
the model never starts, closes or resets it. The tool's own description carries
the `browser.*` API the model writes against.

## Config

| Field       | Default |                                                                                                                          |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `binding`   | —       | The `BROWSER` binding. **Paid plan.**                                                                                    |
| `loader`    | —       | The `LOADER` binding: the Dynamic Worker each call's code runs in.                                                       |
| `timeoutMs` | `60000` | How long one call may take.                                                                                              |
| `provider`  | —       | Browser Run launch options: `keepAliveMs`, `guardrails`, `recording`, `internalHosts`. Host-supplied, never the model's. |

**There is no result ceiling to set here, deliberately.** `browserTool` bounds
its own output and does it _structurally_: `execute` cuts the result and the
error to valid JSON of the original shape, largest values cut first, with
markers where content went, and `toModelOutput` then redacts base64 payloads,
renders a screenshot as a note, and bounds the logs the same way. A flat ceiling
layered on top would collapse that JSON into a string, which is worse than the
bound it would be enforcing, so this plugin adds none.

**One browser per installing object.** `browserTool` opens every run as a
locking session, so overlapping runs wait for each other instead of driving one
tab at once — but the SDK keys those locks by the `Browser` object itself. This
plugin therefore shares one `Browser` per installing Durable Object, built over
that object's own storage, so two turns in one object really do serialise and a
sub-agent in its own facet still gets a browser of its own.

## wrangler.jsonc

```jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

`wrangler dev` needs `"remote": true` on the browser binding to reach it.
`worker_loaders` is not inherited by a named environment, so each one needs an
entry of its own.
