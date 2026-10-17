import { WorkerEntrypoint } from "cloudflare:workers";
import {
  echoAdapter,
  type ContainerAdapter
} from "agents/harness/container/daemon";
import type { EgressRoute } from "agents/harness/container";
import {
  DEFAULT_INSTALL_PLAN,
  SandboxObjectBase,
  readRunHeader,
  sandboxEgress,
  type RunHeader,
  type SandboxEgressRule,
  type SandboxObjectConfig
} from "../src/sandbox/index.js";
// Its own module, not the barrel: that brings core and Think into this Worker.
import { githubSandboxEgress } from "../src/repo-github/sandbox-egress.js";
import { withControlSession } from "../src/sandbox/daemon/composite.js";
import { containerFor, fakeOf } from "./sandbox/fake-container.js";

/**
 * The Worker under test.
 *
 * `@dynamicagents/plugins` is a library, not a Worker, and this file carries no
 * plugin *composition* — the app that composes plugins is `starter`. The
 * sandboxes are here because `/sandbox` ships a Durable Object base class, so
 * the only way to exercise it is to bind a subclass, over a fake container.
 */

/** Each operation's run header, as the daemon took it off its prompt. */
const headers = new Map<string, RunHeader | null>();

/** `adapter` as the image's daemon serves a CLI: the run header off the prompt first. */
function headerless(adapter: ContainerAdapter): ContainerAdapter {
  return {
    ...adapter,
    async open(context) {
      const session = await adapter.open(context);
      return {
        ...session,
        run(turn) {
          const text =
            typeof turn.input === "string"
              ? turn.input
              : turn.input
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join("");
          const { header, prompt } = readRunHeader(text);
          headers.set(turn.operationId, header ?? null);
          return session.run({ ...turn, input: prompt });
        }
      };
    }
  };
}

/** Released by {@link TestSandboxDO.freeExec}. */
let held: (() => void) | undefined;

/**
 * A sandbox over a fake container: the real harness, the real daemon core with
 * the echo adapter behind the control session, and `exec` answered by a script
 * a spec sets. What only a real container can show is in the harness spike.
 */
export class TestSandboxDO extends SandboxObjectBase {
  protected override containerFor(ctx: DurableObjectState): Container {
    return containerFor(
      ctx.id,
      withControlSession(headerless(echoAdapter))
    ).asContainer();
  }

  protected sandboxConfig(): SandboxObjectConfig {
    return {
      label: "test-sandbox",
      adapter: echoAdapter.id,
      instance: "lite",
      env: { HOST_ENV: "host" },
      egress: {
        // This package declares no ambient `Env`, so `ctx.exports` is untyped here.
        entrypoint: (
          this.ctx.exports as unknown as {
            TestSandboxEgress: SandboxObjectConfig["egress"]["entrypoint"];
          }
        ).TestSandboxEgress,
        self: this.self(),
        rules: this.rules()
      },
      installPlan: { ...DEFAULT_INSTALL_PLAN, overrides: {} }
    };
  }

  protected self(): string {
    return "TEST_SANDBOX";
  }

  protected rules(): SandboxEgressRule[] {
    return [];
  }

  /** The name this sandbox was reached by, for a rule's handler that calls back into it. */
  whoami(): string | null {
    return this.ctx.id.name ?? null;
  }

  /** A request from the container to `url`, through the intercept registered for its host. */
  async throughEgress(url: string): Promise<string> {
    const fake = fakeOf(this.ctx.id);
    const host = new URL(url).hostname;
    const binding = fake.intercepts.get(host) ?? fake.httpsIntercepts.get(host);
    if (!binding) throw new Error(`nothing intercepts ${host}`);
    return (await binding.fetch(url)).text();
  }

  /** What the fake saw, for a spec to assert on. */
  fake() {
    const fake = fakeOf(this.ctx.id);
    return {
      running: fake.running,
      starts: fake.starts,
      lastStart: fake.lastStart,
      snapshots: fake.snapshots,
      execs: fake.execs.map((call) => call.cmd),
      execEnvs: fake.execs.map((call) => call.env ?? null),
      execCwds: fake.execs.map((call) => call.cwd ?? null),
      httpHosts: [...fake.intercepts.keys()],
      httpsHosts: [...fake.httpsIntercepts.keys()],
      startEnv: { ...fake.lastEnv },
      inactivityTimeoutMs: fake.inactivityTimeoutMs
    };
  }

  /** Answer `exec` calls whose joined command includes `match` with `stdout`. */
  answer(match: string, stdout: string, exitCode = 0): void {
    const previous = fakeOf(this.ctx.id).script;
    fakeOf(this.ctx.id).script = (call) =>
      call.cmd.join(" ").includes(match)
        ? { stdout, exitCode }
        : previous(call);
  }

  /** Hold `exec` calls whose joined command includes `match` until {@link freeExec}. */
  holdExec(match: string): void {
    const fake = fakeOf(this.ctx.id);
    const previous = fake.script;
    const until = new Promise<void>((resolve) => (held = resolve));
    fake.script = (call) =>
      call.cmd.join(" ").includes(match) ? { until } : previous(call);
  }

  freeExec(): void {
    held?.();
  }

  /** The run header the daemon took off `operationId`'s prompt. */
  headerOf(operationId: string): RunHeader | null {
    return headers.get(operationId) ?? null;
  }

  crash(): Promise<void> {
    return fakeOf(this.ctx.id).crash();
  }

  stored(key: string): Promise<unknown> {
    return this.ctx.storage.get(key);
  }
}

/**
 * A rule as a plugin declares one: a host over HTTPS, a placeholder for its
 * processes, and a handler that answers with where the request was aimed and
 * which sandbox it came from — reached back through `call.sandbox()`.
 */
const PROBE_RULE: SandboxEgressRule = {
  name: "probe",
  https: { "api.example.com": "https://api.example.com/v1" },
  env: { PROBE_TOKEN: "placeholder" },
  async handle(call) {
    const sandbox = call.sandbox() as unknown as {
      whoami(): Promise<string | null>;
    };
    return Response.json({
      target: call.target.toString(),
      sandbox: await sandbox.whoami()
    });
  }
};

/** GitHub's rule, as a sandbox running `sandboxRepoGit` carries it. */
const GITHUB_RULE = githubSandboxEgress({
  tokenBinding: "GITHUB_TOKEN",
  push: { repos: ["dynamicagents/plugins"], branches: ["coding/*"] }
});

/** The rules the test entrypoint serves: every rule a test sandbox may carry. */
const TEST_RULES: readonly SandboxEgressRule[] = [PROBE_RULE, GITHUB_RULE];

/** The same, carrying {@link PROBE_RULE}. */
export class TestSandboxHttpsDO extends TestSandboxDO {
  protected override self(): string {
    return "TEST_SANDBOX_HTTPS";
  }

  protected override rules(): SandboxEgressRule[] {
    return [PROBE_RULE];
  }
}

/** The same, carrying {@link GITHUB_RULE}. */
export class TestSandboxGitDO extends TestSandboxDO {
  protected override self(): string {
    return "TEST_SANDBOX_GIT";
  }

  protected override rules(): SandboxEgressRule[] {
    return [GITHUB_RULE];
  }
}

/** The entrypoint a sandbox's routes are handed to. */
export class TestSandboxEgress extends WorkerEntrypoint<
  Cloudflare.Env,
  { routes: readonly EgressRoute[] }
> {
  override fetch(request: Request): Promise<Response> {
    return sandboxEgress(
      request,
      this.ctx.props.routes,
      this.env as Record<string, unknown>,
      TEST_RULES
    );
  }
}

export default {
  fetch: () => new Response("da-plugins test host", { status: 200 })
} satisfies ExportedHandler<Cloudflare.Env>;
