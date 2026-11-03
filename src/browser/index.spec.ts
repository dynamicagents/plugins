import { describe, it, expect, vi } from "vitest";
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
 * than inside a request, that one `Browser` is shared per installing object so
 * the SDK's per-instance lock actually serialises overlapping runs, and that
 * nothing here gets between the SDK and the result it renders.
 */

/**
 * Only `Browser` is wrapped, and only to count how many this plugin builds.
 * Everything downstream is the real class, so no SDK behaviour is simulated.
 */
const built: string[] = [];
vi.mock("agents/browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("agents/browser")>();
  return {
    ...actual,
    Browser: class extends actual.Browser {
      constructor(options: ConstructorParameters<typeof actual.Browser>[0]) {
        super(options);
        built.push(this.name);
      }
    }
  };
});

/** Enough of each binding to build a tool against; nothing here ever calls one. */
const fakeConfig: BrowserConfig = {
  binding: {} as BrowserBinding,
  loader: {} as WorkerLoader
};

const tools = (config: BrowserConfig = fakeConfig, ctx = testPluginContext()) =>
  browser(config).tools!(ctx);

/** The one tool, as the model is offered it. */
const theTool = (config: BrowserConfig = fakeConfig) => tools(config).browser;

/** A completed run, as the SDK's own `execute` hands it to `toModelOutput`. */
const completed = (result: unknown, logs?: string[]) =>
  ({
    status: "completed",
    executionId: "execution-1",
    result,
    ...(logs === undefined ? {} : { logs })
  }) as BrowserToolOutput;

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

  it("shares one browser per installing object, which is what makes the lock bite", () => {
    // `browserTool` opens every run as a locking session, but the SDK keeps its
    // lock queues keyed by the `Browser` object itself. `getTools()` runs per
    // turn, so a fresh `Browser` per call would hold a lock nobody else waits
    // for and let two overlapping turns drive one tab.
    const plugin = browser(fakeConfig);
    const ctx = testPluginContext();

    built.length = 0;
    plugin.tools!(ctx);
    plugin.tools!(ctx);

    expect(built).toEqual(["browser"]);
  });

  it("keeps a different object's browser separate", () => {
    // Weak and keyed on the installing object's storage, so a sub-agent in its
    // own facet gets its own browser rather than reaching into its parent's.
    const plugin = browser(fakeConfig);

    built.length = 0;
    plugin.tools!(testPluginContext({ storage: {} as DurableObjectStorage }));
    plugin.tools!(testPluginContext({ storage: {} as DurableObjectStorage }));

    expect(built).toEqual(["browser", "browser"]);
  });

  it("leaves the SDK's structured truncation alone", () => {
    // The ceiling is the SDK's and it cuts *structurally*, leaving valid JSON
    // of the original shape with markers where content went. This plugin used
    // to wrap `toModelOutput` with a flat middle-out cut of its own, which
    // collapsed that JSON into a string. Nothing here may do that again.
    //
    // Asserted on `logs`, because that is what `toModelOutput` itself bounds:
    // the result and the error are already cut by the time it sees them, inside
    // the SDK's `execute`, which this spec cannot reach without a real browser.
    const rendered = theTool().toModelOutput!({
      output: completed("a short page", [
        "lorem ipsum dolor sit amet. ".repeat(2_000)
      ])
    } as never) as unknown as {
      type: string;
      value: { result: string; logs: string[] };
    };

    expect(rendered.type).toBe("json");
    // Still JSON, still an array of strings, still carrying the untouched
    // result beside it: a flat cut over the whole rendering would lose all of
    // that.
    expect(rendered.value.result).toBe("a short page");
    expect(Array.isArray(rendered.value.logs)).toBe(true);
    expect(rendered.value.logs.join("")).toContain("--- TRUNCATED ---");
    expect(JSON.stringify(rendered.value).length).toBeLessThan(56_000);
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
