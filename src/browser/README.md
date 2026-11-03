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

**There is no result ceiling to set here, deliberately.** The Agents SDK already
bounds what the tool hands the model, and it cuts structurally rather than
flatly, so a ceiling of this plugin's own would make the output worse rather
than smaller. `index.ts` says where the SDK does it and why nothing wraps it.

**One browser per installing object**, built over that object's own storage, so
two turns in one object serialise against each other and a sub-agent in its own
facet gets a browser of its own. The comment on `browserFor` in `index.ts` is
the home of why that sharing is load-bearing rather than an optimisation.

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
