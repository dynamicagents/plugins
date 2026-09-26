import { DurableObject } from "cloudflare:workers";
import { installScheduler } from "../src/computer/host/alarm/index.js";
import {
  DEFAULT_INSTALL_PLAN,
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "../src/computer/index.js";

// Not one of our classes, and not optional: `CloudflareContainerBackend` builds
// the container's egress loopback out of `ctx.exports.WorkspaceProxy`, so a host
// that omits this export compiles cleanly and fails at the first command. It is
// here because this file is also the worked example of what a host owes.
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
 * egress policy and the git identity are never used for anything — they are here
 * because omitting a required field would say more about this file than about
 * the class under test.
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
 * Two plain Durable Objects for the alarm specs, and the pair is the test.
 *
 * A lifecycle installs its runtime handlers only where the host does not
 * already have one, silently — so "the host defines its own `alarm()`" and "the
 * host does not" are two different installations of the same code, and only one
 * of them can be checked by reading it. {@link PlainScheduled} is the first,
 * {@link DelegatingScheduled} the second.
 */
export class PlainScheduled extends DurableObject<Cloudflare.Env> {
  /** In-memory, so a spec can see *that* a callback ran, not only its effect. */
  readonly marks: string[] = [];

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    }
  });
}

/** The shape the workspace object has: its own `alarm()`, delegating. */
export class DelegatingScheduled extends DurableObject<Cloudflare.Env> {
  readonly marks: string[] = [];
  /** Proves the host's own handler still runs after the lifecycle takes over. */
  ownAlarms = 0;

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    },
    hostOwns: ["alarm"]
  });

  override async alarm(): Promise<void> {
    this.ownAlarms += 1;
    await this.wake.alarm();
  }
}

export default {
  fetch: () => new Response("da-plugins test host", { status: 200 })
} satisfies ExportedHandler<Cloudflare.Env>;
