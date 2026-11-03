import { definePlugin } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import {
  Browser,
  DurableBrowserSessionStore,
  browserRun
} from "agents/browser";
import type { BrowserBinding, BrowserRunOptions } from "agents/browser";
import { browserTool } from "agents/browser/ai-sdk";

/**
 * `@dynamicagents/plugins/browser` — drive a real browser, via Cloudflare
 * Browser Run.
 *
 * One tool, `browser`: the model writes JavaScript that drives a persistent
 * browser over CDP, and that code runs in a Dynamic Worker with no network of
 * its own. The browser outlives each call, so tabs, cookies and logins carry
 * over between them, and the model never starts, closes or resets it.
 *
 * The binding and the loader are closed over at instantiation, so neither is
 * ever model input.
 */

/**
 * The browser's name in its own store. Two `Browser` objects on one Durable
 * Object need different names, so this says which one is the plugin's rather
 * than taking the SDK's default and colliding with a host that also built one.
 */
const BROWSER_NAME = "browser";

/**
 * What the model is told about the domain. Deliberately *not* the `browser.*`
 * function reference: `browserTool` puts that in the tool's own description and
 * keeps it in step with the SDK, and a copy here would be a second home for
 * someone else's text. What is left is what this plugin knows and the SDK
 * cannot: when reaching for a browser is the right move at all.
 */
const CONTEXT = [
  "You can drive a real browser by writing JavaScript, with the `browser` tool. The tool's own description carries the API; what matters in choosing it:",
  "- The browser is **persistent**. A later call lands on the same page, logged in, with the same cookies. Navigate in one call and read in the next rather than rebuilding state each time.",
  "- Because it is persistent, read the page before acting on it. A call that submits a form or clicks through a checkout may be a repeat of one that already succeeded, and the page in front of you is the evidence of which.",
  "- Prefer one call that does several steps over several calls that each do one: every call pays a round trip to the browser, and the page is still there either way.",
  "- Return the part of the page you need rather than its whole text or markup. The tool's rules say where the ceiling is.",
  "- A plain HTTP fetch is cheaper than a browser. Reach for this when a page needs rendering, a session, or interaction."
].join("\n");

export interface BrowserConfig {
  /**
   * The `BROWSER` binding. Browser Rendering is a **paid-plan** feature, and
   * `wrangler dev` needs `remote: true` to reach it.
   */
  binding: BrowserBinding;
  /**
   * The `LOADER` binding, declared as `"worker_loaders": [{ "binding":
   * "LOADER" }]`. Each call gets a fresh Dynamic Worker to run the model's
   * code in, with no network access of its own.
   */
  loader: WorkerLoader;
  /** How long one call may take, in milliseconds. The SDK defaults to 60,000. */
  timeoutMs?: number;
  /**
   * Browser Run launch options: how long an idle browser lives, hostname
   * guardrails, session recording, internal hostnames. Fixed when the browser
   * starts rather than per call, and host-supplied, so the model never sees or
   * chooses any of it.
   */
  provider?: BrowserRunOptions;
}

export function browser(config: BrowserConfig): AgentPlugin {
  const { binding, loader, timeoutMs, provider } = config;

  /**
   * One `Browser` per installing object, and the lock is why.
   *
   * `browserTool` opens every run as a locking session, so runs in one scope
   * wait for each other rather than driving one tab at once. But the SDK keeps
   * its lock queues in a `WeakMap` keyed by the **`Browser` object itself**, so
   * two instances over the same stored session hold two unrelated locks and
   * serialise nothing. `getTools()` runs per turn, so a fresh `Browser` each
   * time would leave overlapping turns in one object free to navigate each
   * other's page.
   *
   * Keyed on the installing object's storage, which is the same granularity the
   * SDK's locks have ("per isolate, which is per Durable Object"), and weak so
   * an evicted object's browser handle goes with it. A `WeakMap` rather than one
   * slot because nothing stops a host from hoisting this plugin to module scope
   * and sharing it between objects in one isolate.
   */
  const browsers = new WeakMap<DurableObjectStorage, Browser>();
  const browserFor = (storage: DurableObjectStorage): Browser => {
    const known = browsers.get(storage);
    if (known !== undefined) return known;

    const made = new Browser({
      name: BROWSER_NAME,
      provider: browserRun(binding, provider),
      // **The store is what keeps this out of the host's Lifecycle.** A
      // `Browser` with no store defaults to one over the host object's storage
      // and requires `Lifecycle.use()` to install it, which a plugin has no way
      // to ask for: the contract offers tools, actions, context and `requires`
      // and nothing else. Passing the store explicitly is the SDK's own answer,
      // and it is what lets this capability stay whole inside the plugin.
      store: new DurableBrowserSessionStore(storage)
    });
    browsers.set(storage, made);
    return made;
  };

  return definePlugin({
    name: "browser",

    // **No `scope`.** A scope separates callers sharing one browser, and there
    // is only ever one here: the record lives in the installing object's own
    // storage, a parent object is keyed by its caller, and a sub-agent runs in
    // its own facet with storage of its own. Naming a scope would imply an
    // isolation the store already provides, and the default one still locks.
    //
    // **Nothing truncates here**, and the tool is handed over as the SDK built
    // it. `browserTool` bounds its own output in two places: `execute` cuts the
    // result and the error *structurally*, leaving valid JSON of the original
    // shape with the largest values cut first and markers where content went,
    // and `toModelOutput` then redacts base64 payloads, renders a screenshot as
    // a note, and bounds the logs the same way. Wrapping either to add a flat
    // ceiling of our own would collapse that JSON into a string, which is
    // strictly worse than the bound it would be enforcing.
    tools: (ctx) => ({
      browser: browserTool({
        browser: browserFor(ctx.storage),
        loader,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
    }),

    context: [{ provider: { get: async () => CONTEXT } }],

    // A plugin cannot add its own wrangler binding, so declaring them turns a
    // missing one into a startup error naming this plugin, rather than a failed
    // tool call inside a request someone is waiting on.
    requires: { bindings: ["BROWSER", "LOADER"] }
  });
}
