import { definePlugin, truncateOutput } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import {
  Browser,
  DurableBrowserSessionStore,
  browserRun
} from "agents/browser";
import type { BrowserBinding, BrowserRunOptions } from "agents/browser";
import { browserTool } from "agents/browser/ai-sdk";
import type { BrowserTool } from "agents/browser/ai-sdk";

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

/** How many characters of a result the model is allowed to see. */
const DEFAULT_MAX_CHARS = 20_000;

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
  "- Prefer one call that does several steps over several calls that each do one: every call pays a round trip to the browser, and the page is still there either way.",
  "- Results are truncated to protect your context window, so return the part of the page you need rather than its whole text or markup.",
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
  /**
   * Character ceiling per result, defaulting to 20,000.
   *
   * **This is a second, tighter ceiling, not the only one.** `browserTool`
   * already bounds what it hands the model, at about 24,000 characters, and it
   * does it *structurally*: the model gets valid JSON of the original shape
   * with the largest values cut first and markers where content went. This
   * ceiling only bites below that, and when it does the shape is lost, because
   * the SDK's structural truncation is internal and a flat cut is all that is
   * left. So lower it for a small model that cannot afford 24,000 characters,
   * and otherwise leave it alone.
   */
  maxChars?: number;
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

/**
 * The host's character ceiling, over the SDK's own.
 *
 * `toModelOutput` is where the SDK renders a result for the model, and where it
 * truncates. Wrapping it rather than `execute` keeps the untruncated result
 * available to anything else reading the tool's output, which is what `execute`
 * is for.
 *
 * The notice is kept whole and outside the cut. It is the sentence saying the
 * browser restarted or that its tab was closed by someone else, so a model that
 * loses it to a middle-out truncation goes on believing the page it navigated
 * to is still there.
 */
function bounded(tool: BrowserTool, maxChars: number): BrowserTool {
  return {
    ...tool,
    toModelOutput: ({ output }) => {
      const rendered = tool.toModelOutput({ output });
      const text =
        rendered.type === "text"
          ? rendered.value
          : JSON.stringify(rendered.value);
      if (text === undefined || text.length <= maxChars) return rendered;

      const notice = output.notice === undefined ? "" : `\n\n${output.notice}`;
      return {
        type: "text",
        value:
          truncateOutput(text, Math.max(0, maxChars - notice.length)) + notice
      };
    }
  };
}

export function browser(config: BrowserConfig): AgentPlugin {
  const {
    binding,
    loader,
    maxChars = DEFAULT_MAX_CHARS,
    timeoutMs,
    provider
  } = config;

  return definePlugin({
    name: "browser",

    // Built per call, as the Quick Action tools were: a tool object is not
    // obviously safe to share across two concurrent executions, and the
    // `Browser` is a handle over its store rather than a connection, so
    // building one per turn costs nothing and reattaches to the same browser.
    //
    // **The store is what keeps this out of the host's Lifecycle.** A `Browser`
    // with no store defaults to one over the host object's storage and requires
    // `Lifecycle.use()` to install it, which a plugin has no way to ask for:
    // the contract offers tools, actions, context and `requires` and nothing
    // else. Passing the store explicitly is the SDK's own answer to that, and
    // it is why this capability stays whole inside the plugin.
    //
    // **No `scope`.** A scope separates callers sharing one browser, and there
    // is only ever one here: the record lives in the installing object's own
    // storage, a parent object is keyed by its caller, and a sub-agent runs in
    // its own facet with storage of its own. Naming a scope would imply an
    // isolation the store already provides. What a scope would not fix either
    // way is two parallel tool calls in one turn driving the same tab; that
    // wants a session lock, which `browserTool` does not expose.
    tools: (ctx) => ({
      browser: bounded(
        browserTool({
          browser: new Browser({
            name: BROWSER_NAME,
            provider: browserRun(binding, provider),
            store: new DurableBrowserSessionStore(ctx.storage)
          }),
          loader,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        }),
        maxChars
      )
    }),

    context: [{ provider: { get: async () => CONTEXT } }],

    // A plugin cannot add its own wrangler binding, so declaring them turns a
    // missing one into a startup error naming this plugin, rather than a failed
    // tool call inside a request someone is waiting on.
    requires: { bindings: ["BROWSER", "LOADER"] }
  });
}
