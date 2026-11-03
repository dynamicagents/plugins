import { describe, it, expect } from "vitest";
import {
  assemblePlugins,
  PLUGIN_CONTRACT_VERSION,
  PluginSetupError
} from "@dynamicagents/core";
import { browser } from "./index.js";
import type { BrowserConfig } from "./index.js";
import type { BrowserBinding } from "agents/browser";
import type { BrowserToolOutput } from "agents/browser/ai-sdk";
import { testPluginContext } from "../../test/helpers.js";

/**
 * The tool itself is the Agents SDK's, and testing it here would be testing
 * someone else's package. What is this plugin's own is the *wiring*: that
 * neither binding is model input, that a missing one fails at startup rather
 * than inside a request, and the character ceiling this plugin puts over the
 * SDK's own.
 */

/** Enough of each binding to build a tool against; nothing here ever calls one. */
const fakeConfig: BrowserConfig = {
  binding: {} as BrowserBinding,
  loader: {} as WorkerLoader
};

const tools = (config: BrowserConfig = fakeConfig) =>
  browser(config).tools!(testPluginContext());

/** The one tool, as the model is offered it. */
const theTool = (config: BrowserConfig = fakeConfig) => tools(config).browser;

/** A completed run carrying `result`, as the SDK hands it to `toModelOutput`. */
const completed = (result: unknown, notice?: string) =>
  ({
    status: "completed",
    executionId: "execution-1",
    result,
    ...(notice === undefined ? {} : { notice })
  }) as BrowserToolOutput;

/** What the model is shown for `output`, as a string whatever its shape. */
const shown = (config: BrowserConfig, output: BrowserToolOutput): string => {
  const rendered = theTool(config).toModelOutput!({
    output
  } as never) as unknown as
    { type: "text"; value: string } | { type: "json"; value: unknown };
  return rendered.type === "text"
    ? rendered.value
    : JSON.stringify(rendered.value);
};

describe("browser()", () => {
  it("offers one tool, which is the whole browser", () => {
    // Four declarative tools became one general one when Quick Actions were
    // deprecated: the model writes the code now, so there is no subset to pick
    // and no `actions` option left to pick it with.
    expect(Object.keys(tools())).toEqual(["browser"]);
  });

  it("takes neither binding from the model — only from config", () => {
    // The whole reason config-at-instantiation exists. The input schema must
    // describe the code to run and nothing else; one naming the binding, the
    // loader or an account would be one the model could fill in.
    const schema = theTool().inputSchema as unknown as {
      "~standard": { jsonSchema: { input: (options: unknown) => unknown } };
    };
    const json = schema["~standard"].jsonSchema.input({}) as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };

    expect(Object.keys(json.properties)).toEqual(["code"]);
    expect(json.additionalProperties).toBe(false);
  });

  it("holds a result to the host's ceiling", () => {
    // The SDK truncates first, at about 24,000 characters, so this asserts the
    // tighter host ceiling bites below that. It is the only thing this plugin
    // adds to the rendering and the only part a host can set.
    const value = shown(
      { ...fakeConfig, maxChars: 500 },
      completed("x".repeat(50_000))
    );

    expect(value.length).toBeLessThanOrEqual(500);
  });

  it("keeps the browser's notice out of the truncated middle", () => {
    // The notice is how the model learns its browser restarted or that its tab
    // was closed by someone else. Losing it to a middle-out cut leaves the
    // model believing the page it navigated to is still there.
    const notice = "The browser restarted, so the page you opened is gone.";
    const value = shown(
      { ...fakeConfig, maxChars: 500 },
      completed("x".repeat(50_000), notice)
    );

    expect(value).toContain(notice);
    expect(value.length).toBeLessThanOrEqual(500);
  });

  it("leaves a result under the ceiling alone", () => {
    // Truncating what fits would cost the structured shape the SDK preserved,
    // for nothing. Under the ceiling this plugin must be invisible.
    const value = shown({ ...fakeConfig, maxChars: 20_000 }, completed("tiny"));

    expect(value).toContain("tiny");
    expect(value).not.toContain("omitted from the middle");
  });

  it("tells the model about its tool in a block the model cannot rewrite", async () => {
    // A block with no provider is wired as writable, and `set_context` could
    // then overwrite the plugin's own description of itself.
    const [block] = browser(fakeConfig).context!;
    expect(block.provider).toBeDefined();
    expect(block.provider && "set" in block.provider).toBe(false);
    expect(await block.provider!.get()).toContain("`browser` tool");
  });

  it("fails at startup when the host never declared a binding", () => {
    // The point of `requires`. Without it the first tool call fails instead —
    // inside a request a user is waiting on, several layers from the cause.
    // Both bindings, because the loader is as load-bearing as the browser now.
    expect(() => assemblePlugins([browser(fakeConfig)], {})).toThrow(
      PluginSetupError
    );
    expect(() => assemblePlugins([browser(fakeConfig)], {})).toThrow(
      /BROWSER.*browser/s
    );
    expect(() =>
      assemblePlugins([browser(fakeConfig)], { BROWSER: {} })
    ).toThrow(/LOADER.*browser/s);
  });

  it("registers against the contract version it compiled against", () => {
    // Never a literal — the point is that it moves with the core the plugin was
    // built against, so a version train that leaves one repo behind says so.
    expect(browser(fakeConfig).contractVersion).toBe(PLUGIN_CONTRACT_VERSION);
  });
});
