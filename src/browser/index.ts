import { definePlugin } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import { createQuickActionTools } from "agents/browser/ai";
import type { QuickActionToolName } from "agents/browser/ai";
import type {
  QuickActionBinding,
  QuickActionCommonOptions
} from "agents/browser";

/**
 * `@dynamicagents/plugins/browser` — read the web, via Cloudflare Browser Rendering
 * Quick Actions.
 *
 * Four tools (`browser_markdown`, `browser_extract`, `browser_links`,
 * `browser_scrape`), the same for whichever agent installs the plugin: a parent
 * reads a page to answer a question directly, and a research sub-agent reads a
 * dozen of them.
 *
 * The binding is closed over at instantiation, so it is never model input.
 */

/** How many characters of a page result the model is allowed to see. */
const DEFAULT_MAX_CHARS = 20_000;

const CONTEXT = [
  "You can read web pages directly:",
  "- `browser_markdown` fetches a page and returns it as Markdown. This is the default — use it first.",
  "- `browser_extract` pulls structured fields out of a page when you know what you are looking for.",
  "- `browser_links` lists a page's links, for following a trail.",
  "- `browser_scrape` returns the text of specific CSS selectors.",
  "Results are truncated to protect your context window, so prefer a specific page over a search-results page, and extract rather than reading in full when you already know the fields you need."
].join("\n");

export interface BrowserConfig {
  /**
   * The `BROWSER` binding. Browser Rendering is a **paid-plan** feature, and
   * `wrangler dev` needs `remote: true` to reach it.
   */
  binding: QuickActionBinding;
  /**
   * Character ceiling per result. Defaults to 20,000 — well under the SDK's own
   * 50,000, because a page that fills a small chat model's context window costs
   * it the conversation it was reading the page for.
   */
  maxChars?: number;
  /**
   * Which tools to expose. Defaults to the SDK's text-returning set; `content`
   * (raw HTML) stays opt-in because it is large and rarely what a model wants.
   */
  actions?: QuickActionToolName[];
  /**
   * Browser Rendering options merged into every request — cookies, auth headers,
   * viewport. Host-supplied and never exposed to the model, which only ever
   * chooses the page and the action-specific fields.
   */
  options?: QuickActionCommonOptions;
}

export function browser(config: BrowserConfig): AgentPlugin {
  const { binding, maxChars = DEFAULT_MAX_CHARS, actions, options } = config;

  return definePlugin({
    name: "browser",

    // Built per call: the SDK returns a fresh ToolSet each time, and a tool
    // object is not obviously safe to share across two concurrent executions.
    tools: () =>
      createQuickActionTools({
        browser: binding,
        maxChars,
        ...(actions ? { actions } : {}),
        ...(options ? { options } : {})
      }),

    context: [{ provider: { get: async () => CONTEXT } }],

    // A plugin cannot add its own wrangler binding, so declaring it turns a
    // missing one into a startup error naming this plugin, rather than a failed
    // tool call inside a request someone is waiting on.
    requires: { bindings: ["BROWSER"] }
  });
}
