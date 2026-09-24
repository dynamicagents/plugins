import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { createVcr, recordFromEnv } from "@dynamicagents/core/testing/node";

/**
 * Specs run **inside workerd**, not Node.
 *
 * Most of what lives here is pure and would run anywhere, but the workspace host
 * is a Durable Object and has to be driven in a real one. So the pool boots the
 * real runtime with the Durable Object declared in `wrangler.jsonc`, and
 * `test/worker.ts` is the host that owns it.
 */

/**
 * Every outbound `fetch` a spec makes flows through this recorder. A request
 * with no active cassette is blocked and names itself, instead of reaching the
 * network or failing as an unnamed `internal error; reference = …`.
 *
 * A recorded spec announces its cassette over an in-band control channel — the
 * spec runs in workerd and has no filesystem, so it cannot reach the recorder any
 * other way — and keys it per test. A credential it records with reaches it only
 * through a `miniflare.bindings` entry: workerd never sees Node's `process.env`.
 *
 * `recordFromEnv()` is `RECORD=1`, compared rather than coerced — every
 * non-empty string is truthy, so `RECORD=0` and `RECORD=false`, the two things
 * someone reaches for to turn recording *off*, would otherwise turn it on and
 * overwrite committed cassettes with live traffic.
 *
 * `excludeHeaders` is what keeps a credential out of a committed cassette, and
 * why playback needs no key configured at all.
 */
const vcr = createVcr({
  snapshotsDir: path.resolve(import.meta.dirname, "./test/snapshots"),
  record: recordFromEnv(),
  excludeHeaders: ["x-api-key", "cookie", "set-cookie"]
});

export default defineConfig({
  resolve: {
    /**
     * Force one copy of every shared peer.
     *
     * `@dynamicagents/core` is installed as `file:../core` for the inner loop,
     * which npm satisfies with a symlink — and Vite resolves through
     * realpath, so core's imports land in *its* `node_modules` while this
     * package's land in ours. Two copies of `agents` in one Worker breaks
     * `instanceof` and makes `Session`/`SessionMessage` two unrelated types,
     * which is precisely the failure a published install cannot have and a
     * linked checkout silently can.
     *
     * Harmless once core is installed from the registry, where these hoist anyway.
     */
    dedupe: ["agents", "ai", "zod", "workers-ai-provider"]
  },
  plugins: [
    cloudflareTest({
      // Bindings come from the one wrangler config, so the test host and the
      // snippets in each plugin's README cannot drift apart.
      wrangler: { configPath: "./wrangler.jsonc" },
      // Required, not merely the documented default: Workers AI has no local
      // execution mode, so leaving this unset makes the pool eagerly establish a
      // remote connection per test file — seconds of startup plus a reproducible
      // teardown hang.
      remoteBindings: false,
      miniflare: {
        // The hook Miniflare 4 and 5 both have. `fetchMock` was removed in pool
        // 0.20, and an unknown key here is ignored rather than rejected — which
        // is exactly how the previous wiring failed silently.
        outboundService: vcr.outboundService
      }
    })
  ],
  test: {
    // Node realm. Flushes cassettes and stops the recorder after the run;
    // without it a `RECORD=1` run hangs on open sockets.
    globalSetup: ["@dynamicagents/core/testing/vcr-global-setup"],
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"]
  }
});
