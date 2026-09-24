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

export default {
  fetch: () => new Response("da-plugins test host", { status: 200 })
} satisfies ExportedHandler<Cloudflare.Env>;
