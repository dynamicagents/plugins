import { env } from "cloudflare:workers";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import type { TestWorkspaceDO } from "../worker.js";

/**
 * A real Durable Object to drive `WorkspaceObjectBase` in.
 *
 * The class ships from this package, so a fake host would test the fake: what
 * its specs pin is the wake map, the deadlines and the install record, all of
 * which are `ctx.storage` and `ctx.storage.sql` behaviour that exists nowhere
 * but inside workerd.
 *
 * **No container is bound to it, and that is the point.** The pool cannot start
 * one, so `runtime.exec` fails exactly the way it fails when a container is
 * unreachable — which is the shape of the production failures these specs exist
 * for. The paths that need a live container are not testable here and are not
 * pretended to be.
 */

// Cast, because this package deliberately generates no ambient `Env` — see
// `scripts/verify-runtime-types.mjs`. The binding is declared in
// `wrangler.jsonc` and named here, in the one place a spec reaches for it.
const ns = (
  env as unknown as {
    TEST_WORKSPACE: DurableObjectNamespace<TestWorkspaceDO>;
  }
).TEST_WORKSPACE;

/** A fresh workspace per test — DO storage never leaks between them. */
export const { freshStub: freshWorkspace } = makeDoHelpers<TestWorkspaceDO>(ns);

/** The namespace itself, for a spec that must re-open a stub it invalidated. */
export const workspaceNamespace = ns;
