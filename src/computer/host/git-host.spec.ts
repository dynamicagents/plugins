import { describe, expect, it, vi } from "vitest";
import type { AuthCallback, GitClient } from "@cloudflare/computer/git";
import { describeGitError, WorkspaceGitHost } from "./git-host.js";

/**
 * The credential boundary, driven directly.
 *
 * `onAuth` is the whole of what keeps a forge token from reaching a host nobody
 * allowed. It is built per operation and handed to isomorphic-git, so the only
 * way to exercise it is to capture it from a fake client and call it with the
 * URLs git would — including the one it reaches by redirect, which is the case
 * the check is bound rather than pre-checked for.
 *
 * What it must answer is narrow: the credential, or an empty object. An empty
 * object is not a failure — it is an unauthenticated request, which is what a
 * public repository needs and what a disallowed host gets.
 */

/**
 * isomorphic-git hands `onAuth` the URL *and* whatever auth it already has; the
 * callback here ignores the second argument, but the type requires it, so every
 * call below passes an empty one.
 */
const NO_PRIOR_AUTH = {};

const TOKEN = "forge-token";
const ALLOWED = ["github.com"];

/** A client that captures the `onAuth` it is given and reports success. */
function captureAuth(): { git: GitClient; onAuth: () => AuthCallback } {
  let captured: AuthCallback | undefined;
  const git = {
    fetch: vi.fn(async (req: { onAuth?: AuthCallback }) => {
      captured = req.onAuth;
      return { defaultBranch: "refs/heads/main" };
    })
  } as unknown as GitClient;
  return {
    git,
    onAuth: () => {
      if (!captured) throw new Error("no onAuth was handed to the client");
      return captured;
    }
  };
}

/**
 * No default for `token`: a default parameter still fires when `undefined` is
 * passed explicitly, so the absent-credential case would silently have been
 * testing the present one. Every test here says which it means.
 */
function hostWith(git: GitClient, token: string | undefined) {
  return new WorkspaceGitHost({
    git: () => git,
    token: () => token,
    tag: () => "spec"
  });
}

describe("who the forge credential is handed to", () => {
  it("authenticates to a host on the allowlist", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    expect(
      onAuth()("https://github.com/acme/widget.git", NO_PRIOR_AUTH)
    ).toEqual({
      username: "x-access-token",
      password: TOKEN
    });
  });

  it("gives nothing to a host nobody allowed", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    expect(
      onAuth()("https://evil.example/acme/widget.git", NO_PRIOR_AUTH)
    ).toEqual({});
  });

  it("gives nothing over plain http, however allowed the host", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    // The allowlist is about *which* host; the scheme is about whether the
    // credential is readable in flight. A token is never worth downgrading.
    expect(
      onAuth()("http://github.com/acme/widget.git", NO_PRIOR_AUTH)
    ).toEqual({});
  });

  it("gives nothing for a url it cannot parse", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    expect(onAuth()("not-a-url", NO_PRIOR_AUTH)).toEqual({});
  });

  it("re-checks the host a redirect landed on", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, TOKEN).fetch({
      // Started somewhere allowed…
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    // …and git followed a redirect off it. This is why the check is bound to the
    // callback rather than made once before the call: the decision is taken
    // against the URL the credential would actually be sent to.
    expect(
      onAuth()("https://redirected.example/acme/widget.git", NO_PRIOR_AUTH)
    ).toEqual({});
  });

  it("hands over an absent token as an unauthenticated request", async () => {
    const { git, onAuth } = captureAuth();
    await hostWith(git, undefined).fetch({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      allowedHosts: ALLOWED
    });
    expect(
      onAuth()("https://github.com/acme/widget.git", NO_PRIOR_AUTH)
    ).toEqual({
      username: "x-access-token",
      password: undefined
    });
  });
});

describe("what a caller is told when git answers", () => {
  it("reports a rejected push even though nothing threw", async () => {
    const git = {
      push: vi.fn(async () => ({
        ok: false,
        refs: { "refs/heads/main": { ok: false, error: "non-fast-forward" } }
      }))
    } as unknown as GitClient;
    const result = await hostWith(git, TOKEN).push({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      branch: "main",
      allowedHosts: ALLOWED
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringContaining("non-fast-forward")
    });
  });

  it("never reports a rejected push with a blank reason", async () => {
    // `refs` carrying no failing entry joins to `""`, which is a string — so a
    // nullish fallback would hand the caller an empty message for a push that
    // did not happen.
    const git = {
      push: vi.fn(async () => ({ ok: false, refs: {} }))
    } as unknown as GitClient;
    const result = await hostWith(git, TOKEN).push({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      branch: "main",
      allowedHosts: ALLOWED
    });
    expect(result).toEqual({
      ok: false,
      message: "the remote rejected the push"
    });
  });

  it("carries a git error's code as data, since a throw loses its prototype", async () => {
    const err = Object.assign(new Error("could not resolve host"), {
      code: "HttpError"
    });
    const git = {
      push: vi.fn(async () => {
        throw err;
      })
    } as unknown as GitClient;
    const result = await hostWith(git, TOKEN).push({
      url: "https://github.com/acme/widget.git",
      dir: "/workspace/widget",
      branch: "main",
      allowedHosts: ALLOWED
    });
    expect(result).toEqual({
      ok: false,
      code: "HttpError",
      message: "could not resolve host"
    });
  });

  /**
   * `@cloudflare/computer/git` reports several unrelated failures as "not a git
   * repository" — a missing ref among them — and keeps what actually failed on
   * `cause`, which a Durable Object boundary drops. A checkout that plainly is
   * a repository cannot be diagnosed from the wrapper's sentence alone.
   */
  it("carries what actually failed, not only the wrapper's reading of it", async () => {
    const cause = Object.assign(new Error("Could not find HEAD."), {
      name: "NotFoundError"
    });
    const err = Object.assign(
      new Error("not a git repository: /workspace/super", { cause }),
      { code: "ENOTAREPO" }
    );
    const git = {
      fetch: vi.fn(async () => {
        throw err;
      })
    } as unknown as GitClient;
    const result = await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/super.git",
      dir: "/workspace/super",
      allowedHosts: ALLOWED
    });
    expect(result).toEqual({
      ok: false,
      code: "ENOTAREPO",
      message:
        "not a git repository: /workspace/super ← NotFoundError: Could not find HEAD."
    });
  });
});

/**
 * A fetch takes every branch, but isomorphic-git still resolves one ref against
 * the remote's list — the current branch's upstream, unless told otherwise. A
 * checkout left on a branch whose remote branch was deleted when its pull
 * request merged then failed every fetch, refresh included.
 */
describe("what a fetch resolves against the remote", () => {
  it("asks for the remote's HEAD, never the current branch's upstream", async () => {
    const fetch = vi.fn(async () => ({ defaultBranch: "refs/heads/main" }));
    const git = { fetch } as unknown as GitClient;

    const result = await hostWith(git, TOKEN).fetch({
      url: "https://github.com/acme/super.git",
      dir: "/workspace/super",
      allowedHosts: ALLOWED
    });

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRef: "HEAD", singleBranch: false })
    );
  });
});

describe("describeGitError", () => {
  it("is the message alone when there is no cause", () => {
    expect(describeGitError(new Error("push rejected"))).toBe("push rejected");
  });

  it("stops at a cause that repeats, and at a non-error", () => {
    const inner = new Error("x");
    expect(describeGitError(new Error("x", { cause: inner }))).toBe("x");
    expect(describeGitError("plain string")).toBe("plain string");
  });
});
