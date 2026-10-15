import { WorkerEntrypoint } from "cloudflare:workers";
import { echoAdapter } from "agents/harness/container/daemon";
import type { EgressRoute } from "agents/harness/container";
import {
  DEFAULT_INSTALL_PLAN,
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "../src/workspace/index.js";
import {
  SandboxObjectBase,
  githubRoute,
  sandboxEgress,
  type SandboxObjectConfig
} from "../src/sandbox/index.js";
import { withControlSession } from "../src/sandbox/daemon/composite.js";
import { containerFor, fakeOf } from "./sandbox/fake-container.js";

// Not one of our classes, and not optional: `ContainerBackend` builds the
// container's egress loopback out of `ctx.exports.WorkspaceProxy`, so a host that
// omits this export compiles cleanly and fails at the first command. It is here
// because this file is also the worked example of what a host owes.
export { WorkspaceProxy } from "@cloudflare/computer";

/**
 * The Worker under test.
 *
 * `@dynamicagents/plugins` is a library, not a Worker, and this file carries no
 * plugin *composition* — the app that composes plugins is `starter`.
 *
 * {@link TestWorkspaceDO} is here because the workspace host is a Durable Object
 * base class this package *ships*, so the only way to exercise it is to bind a
 * subclass. It runs **without a container** — the pool cannot start one — which
 * is the point rather than a limitation, as that is exactly the shape of the
 * production failures its specs pin.
 *
 * The narrowest config that satisfies the seam: no container will start, so the
 * egress policy, the instance size and the git identity are never used for
 * anything — they are here because omitting a required field would say more
 * about this file than about the class under test.
 */
export class TestWorkspaceDO extends WorkspaceObjectBase {
  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "TEST_WORKSPACE",
      label: "test-workspace",
      // The package default, not a fixture. A spec that needs a different plan
      // is testing `resolveInstallCommand`, which has its own specs next door.
      installPlan: { ...DEFAULT_INSTALL_PLAN, overrides: {} },
      egress: { mode: "direct" },
      instance: "standard-1",
      git: {
        // A binding this test Worker does not declare, which reads `undefined`
        // — the unauthenticated case, and the only one reachable with no
        // container to run git against.
        tokenBinding: "GITHUB_TOKEN",
        author: { name: "test", email: "test@example.invalid" }
      }
    };
  }
}

/**
 * A sandbox over a fake container: the real harness, the real daemon core with
 * the echo adapter behind the control session, and `exec` answered by a script
 * a spec sets. What only a real container can show is in the harness spike.
 */
export class TestSandboxDO extends SandboxObjectBase {
  protected override containerFor(ctx: DurableObjectState): Container {
    return containerFor(ctx.id, withControlSession(echoAdapter)).asContainer();
  }

  protected sandboxConfig(): SandboxObjectConfig {
    return {
      label: "test-sandbox",
      adapter: echoAdapter.id,
      instance: "lite",
      egress: {
        // This package declares no ambient `Env`, so `ctx.exports` is untyped here.
        binding: (
          this.ctx.exports as unknown as {
            TestSandboxEgress: SandboxObjectConfig["egress"]["binding"];
          }
        ).TestSandboxEgress,
        routes: [],
        https: this.https()
      },
      installPlan: { ...DEFAULT_INSTALL_PLAN, overrides: {} }
    };
  }

  protected https(): EgressRoute[] {
    return [];
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
      httpsHosts: [...fake.httpsIntercepts.keys()],
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

  crash(): Promise<void> {
    return fakeOf(this.ctx.id).crash();
  }

  stored(key: string): Promise<unknown> {
    return this.ctx.storage.get(key);
  }
}

/** The same, with GitHub's API intercepted over HTTPS. */
export class TestSandboxHttpsDO extends TestSandboxDO {
  protected override https(): EgressRoute[] {
    return [
      githubRoute({
        host: "api.github.com",
        upstream: "https://api.github.com",
        tokenBinding: "GITHUB_TOKEN"
      })
    ];
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
      this.env as Record<string, unknown>
    );
  }
}

export default {
  fetch: () => new Response("da-plugins test host", { status: 200 })
} satisfies ExportedHandler<Cloudflare.Env>;
