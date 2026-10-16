import type { EgressRoute } from "agents/harness/container";
import {
  branchAllowed,
  githubAuthorization,
  githubError,
  gitTarget,
  presentsPlaceholder,
  receivePackRefs,
  type GitPushPolicy
} from "./github.js";

/**
 * The container's way out, on the Worker side.
 *
 * The harness intercepts each route's `host` in the container and hands the
 * request to one entrypoint, which a consumer defines and exports so it exists
 * on `ctx.exports`. That entrypoint calls {@link sandboxEgress} with its props'
 * routes, the Worker's `env`, and a handler per kind of route it serves — the
 * Anthropic credential pool lives in `/claude-code`, so it arrives here as a
 * handler rather than an import.
 *
 * A route is the harness's own `EgressRoute`, and its `upstream` stays a real
 * https URL, which the harness requires. What only this module reads travels
 * in `x-da-*` headers on the route, which are removed before anything is
 * forwarded: {@link ROUTE_KIND}, {@link ROUTE_TOKEN}, {@link ROUTE_PUSH},
 * {@link ROUTE_SANDBOX}.
 */

/** Which handler serves the route. Absent: forwarded with the route's own headers. */
export const ROUTE_KIND = "x-da-kind";
/** The `env` binding holding the credential, read at the moment it is used, never carried. */
export const ROUTE_TOKEN = "x-da-token-binding";
/** A {@link GitPushPolicy}, as JSON. */
export const ROUTE_PUSH = "x-da-push";
/** `<binding>/<name>` of the sandbox the route belongs to, for a handler that keeps state there. */
export const ROUTE_SANDBOX = "x-da-sandbox";

const CONTROL = [ROUTE_KIND, ROUTE_TOKEN, ROUTE_PUSH, ROUTE_SANDBOX];

/** Headers that carry a credential, removed from whatever the container sent. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "proxy-authorization"
];

/** A route's request, already re-aimed at its upstream, for a handler to finish. */
export interface EgressCall {
  readonly request: Request;
  /** The upstream URL: the route's upstream with the request's path and query. */
  readonly target: URL;
  readonly route: EgressRoute;
  /** The route's `x-da-*` values. */
  readonly control: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, unknown>>;
}

export type EgressHandler = (call: EgressCall) => Promise<Response>;

/** Serve one request the container made. */
export async function sandboxEgress(
  request: Request,
  routes: readonly EgressRoute[],
  env: Readonly<Record<string, unknown>>,
  handlers: Readonly<Record<string, EgressHandler>> = {}
): Promise<Response> {
  const url = new URL(request.url);
  const route = routes.find((each) => each.host === url.hostname);
  if (!route) {
    return new Response(`No egress route for ${url.hostname}`, { status: 403 });
  }
  const target = new URL(
    `${route.upstream.replace(/\/+$/, "")}${url.pathname}${url.search}`
  );
  const control: Record<string, string> = {};
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(route.headers)) {
    if (CONTROL.includes(name.toLowerCase()))
      control[name.toLowerCase()] = value;
    else forwarded[name] = value;
  }
  const call: EgressCall = {
    request,
    target,
    route: { ...route, headers: forwarded },
    control,
    env
  };
  const kind = control[ROUTE_KIND];
  if (kind === "github") return githubEgress(call);
  if (kind !== undefined) {
    const handler = handlers[kind];
    if (!handler) {
      return new Response(`No egress handler for ${kind}`, { status: 500 });
    }
    return handler(call);
  }
  return forward(call, (headers) => {
    for (const name of route.strip) headers.delete(name);
    for (const [name, value] of Object.entries(forwarded))
      headers.set(name, value);
  });
}

/** `call.request` at its target, with `rewrite` applied to its headers; never following a redirect. */
export async function forward(
  call: EgressCall,
  rewrite: (headers: Headers) => void,
  body?: BodyInit
): Promise<Response> {
  const headers = new Headers(call.request.headers);
  headers.delete("host");
  rewrite(headers);
  const hasBody =
    call.request.method !== "GET" && call.request.method !== "HEAD";
  return fetch(call.target, {
    method: call.request.method,
    headers,
    ...(hasBody ? { body: body ?? call.request.body } : {}),
    redirect: "manual"
  });
}

/**
 * GitHub: anonymous unless the placeholder is presented; then the real token,
 * and for git, the push policy.
 */
async function githubEgress(call: EgressCall): Promise<Response> {
  const presented = presentsPlaceholder(
    call.request.headers.get("authorization")
  );
  const strip = (headers: Headers) => {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  };
  if (!presented) return forward(call, strip);

  const binding = call.control[ROUTE_TOKEN];
  const token = binding ? call.env[binding] : undefined;
  if (typeof token !== "string" || token === "") {
    return githubError(
      "no GitHub token is configured for this deployment, so nothing can be done as its account",
      401
    );
  }

  const policy = readPolicy(call.control[ROUTE_PUSH]);
  const git = gitTarget(call.target.pathname);
  let body: ReadableStream | undefined;
  if (policy && git) {
    if (!policy.repos.some((repo) => repo.toLowerCase() === git.repo)) {
      return githubError(
        `this sandbox may not use ${git.repo} as the deployment's account`,
        403
      );
    }
    if (git.service === "receive-pack" && call.request.method === "POST") {
      const [inspected, forwarded] = (
        call.request.body ?? new Blob().stream()
      ).tee();
      const refs = await receivePackRefs(
        inspected,
        call.request.headers.get("content-encoding")
      ).catch(() => undefined);
      if (!refs || refs.length === 0) {
        void forwarded.cancel().catch(() => undefined);
        return githubError("this push names no ref this egress can read", 400);
      }
      const refused = refs.filter(
        (ref) =>
          !ref.startsWith("refs/heads/") ||
          !branchAllowed(policy, ref.slice("refs/heads/".length))
      );
      if (refused.length > 0) {
        void forwarded.cancel().catch(() => undefined);
        return githubError(
          `this sandbox may not push ${refused.join(", ")}; it may push ${policy.branches.join(", ")}`,
          403
        );
      }
      body = forwarded;
    }
  }
  return forward(
    call,
    (headers) => {
      strip(headers);
      headers.set("authorization", githubAuthorization(presented, token));
    },
    body
  );
}

function readPolicy(value: string | undefined): GitPushPolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as GitPushPolicy;
  return { repos: [...parsed.repos], branches: [...parsed.branches] };
}

/** A GitHub route for `host`: git's placeholder host, or `api.github.com` intercepted over HTTPS. */
export function githubRoute(options: {
  host: string;
  upstream: "https://github.com" | "https://api.github.com";
  tokenBinding: string;
  push?: GitPushPolicy;
}): EgressRoute {
  return {
    host: options.host,
    upstream: options.upstream,
    headers: {
      [ROUTE_KIND]: "github",
      [ROUTE_TOKEN]: options.tokenBinding,
      ...(options.push ? { [ROUTE_PUSH]: JSON.stringify(options.push) } : {})
    },
    strip: CREDENTIAL_HEADERS
  };
}
