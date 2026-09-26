import { describe, it, expect } from "vitest";
import {
  assemblePlugins,
  PLUGIN_CONTRACT_VERSION,
  PluginSetupError
} from "@dynamicagents/core";
import { browser } from "./index.js";
import type { QuickActionBinding } from "agents/browser";
import { testPluginContext } from "../../test/helpers.js";

/**
 * The tools themselves are the Agents SDK's, and testing them here would be
 * testing someone else's package. What is this plugin's own is the *wiring*:
 * that the binding is closed over rather than model input, and that a missing
 * binding fails at startup instead of inside a request.
 */

/** Enough of the binding to build tools against; nothing here ever calls it. */
const fakeBinding = {} as QuickActionBinding;

const tools = (plugin: ReturnType<typeof browser>) =>
  plugin.tools!(testPluginContext());

describe("browser()", () => {
  it("exposes the text-returning set and keeps raw HTML opt-in", () => {
    // `content` is large and rarely what a model wants, so it is not in the
    // default set — a page of raw HTML can cost a small model its whole context.
    const names = Object.keys(tools(browser({ binding: fakeBinding })));

    expect(names.sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
  });

  it("narrows to the actions the host asked for", () => {
    const plugin = browser({ binding: fakeBinding, actions: ["markdown"] });
    expect(Object.keys(tools(plugin))).toEqual(["browser_markdown"]);
  });

  it("takes no binding from the model — only from config", () => {
    // The whole reason config-at-instantiation exists. Every tool's input schema
    // must describe a page and nothing else; a schema naming a binding, an
    // account, or a header would be one the model could fill in.
    for (const [name, tool] of Object.entries(
      tools(browser({ binding: fakeBinding }))
    )) {
      const keys = Object.keys(
        (tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {}
      );
      expect(keys, `${name} input`).not.toContain("browser");
      expect(keys, `${name} input`).not.toContain("binding");
    }
  });

  it("tells the model about its tools in a block the model cannot rewrite", async () => {
    // A block with no provider is wired as writable, and `set_context` could
    // then overwrite the plugin's own description of itself.
    const [block] = browser({ binding: fakeBinding }).context!;
    expect(block.provider).toBeDefined();
    expect(block.provider && "set" in block.provider).toBe(false);
    expect(await block.provider!.get()).toContain("browser_markdown");
  });

  it("fails at startup when the host never declared BROWSER", () => {
    // The point of `requires`. Without it the first tool call fails instead —
    // inside a request a user is waiting on, several layers from the cause.
    expect(() =>
      assemblePlugins([browser({ binding: fakeBinding })], {})
    ).toThrow(PluginSetupError);
    expect(() =>
      assemblePlugins([browser({ binding: fakeBinding })], {})
    ).toThrow(/BROWSER.*browser/s);
  });

  it("registers against the contract version it compiled against", () => {
    // Never a literal — the point is that it moves with the core the plugin was
    // built against, so a version train that leaves one repo behind says so.
    expect(browser({ binding: fakeBinding }).contractVersion).toBe(
      PLUGIN_CONTRACT_VERSION
    );
  });
});
