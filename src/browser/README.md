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
| `maxChars`  | `20000` | A second ceiling under the SDK's own ~24,000. Lower it for a small model; read below before raising it.                  |
| `timeoutMs` | `60000` | How long one call may take.                                                                                              |
| `provider`  | —       | Browser Run launch options: `keepAliveMs`, `guardrails`, `recording`, `internalHosts`. Host-supplied, never the model's. |

**`maxChars` is not the only ceiling.** `browserTool` already bounds what it
hands the model, at about 24,000 characters, and it does so _structurally_: the
model gets valid JSON of the original shape, largest values cut first, with
markers where content went. This field only bites below that, and when it does
the shape is lost, because the SDK's structural truncation is internal and a
flat middle-out cut is all that is left. The browser's `notice` is kept whole
and outside the cut either way.

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
