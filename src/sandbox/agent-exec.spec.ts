import { describe, expect, it } from "vitest";
import { agentEnv, asAgent, shellQuote } from "./agent-exec.js";

describe("asAgent", () => {
  it("drops every capability and changes identity in one step", () => {
    expect(asAgent(["git", "status"])).toEqual([
      "setpriv",
      "--reuid=10001",
      "--regid=10001",
      "--init-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--",
      "git",
      "status"
    ]);
  });

  it("refuses an empty command", () => {
    expect(() => asAgent([])).toThrow(/empty/);
  });

  it("gives the agent its own home", () => {
    expect(agentEnv({ CI: "1" })).toMatchObject({
      HOME: "/home/agent",
      USER: "agent",
      CI: "1"
    });
  });

  it("quotes for sh with nothing expanded", () => {
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  });
});
