import { describe, expect, it } from "vitest";
import { agentEnv, asAgent, shellQuote } from "./agent-exec.js";

describe("asAgent", () => {
  it("drops every capability and changes identity in one step, then sets exactly the agent's environment", () => {
    expect(asAgent(["git", "status"], { CI: "1" })).toEqual([
      "/usr/bin/setpriv",
      "--reuid=10001",
      "--regid=10001",
      "--init-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--",
      "/usr/bin/env",
      "-i",
      "HOME=/home/agent",
      "USER=agent",
      "LOGNAME=agent",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "CI=1",
      "git",
      "status"
    ]);
  });

  it("puts a caller's environment on the agent's side of the drop, never root's", () => {
    const argv = asAgent(["true"], { LD_PRELOAD: "/workspace/evil.so" });
    expect(argv.indexOf("LD_PRELOAD=/workspace/evil.so")).toBeGreaterThan(
      argv.indexOf("--")
    );
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
