import type { EgressRoute } from "agents/harness/container";

/**
 * The container's way out, on the Worker side.
 *
 * A plugin that needs a host from inside the container declares it as a
 * {@link SandboxEgressRule}: the hosts to intercept, the placeholders its
 * processes see, and the handler that swaps a placeholder for the real
 * credential. A consumer lists the rules a sandbox class carries once, and
 * hands that list both to the class's config and to the entrypoint that calls
 * {@link sandboxEgress}. This module names no host and holds no credential.
 *
 * An intercepted request reaches the entrypoint, a stateless Worker invocation
 * outside the container. The sandbox object is on the path only when a handler
 * calls it ({@link EgressCall.sandbox}).
 */

export interface SandboxEgressRule {
  /** Names the rule where a clash or a refusal is reported. */
  readonly name: string;
  /**
   * Hosts intercepted over plain HTTP, each to its real `https:` upstream: a
   * placeholder host the container is pointed at, so nothing in it terminates
   * TLS.
   */
  readonly http?: Readonly<Record<string, string>>;
  /**
   * Real hosts intercepted over HTTPS, each to its `https:` upstream, for a
   * client that cannot be pointed at a placeholder. The sandbox trusts the
   * runtime's interception CA in every container that has one.
   */
  readonly https?: Readonly<Record<string, string>>;
  /**
   * What a process needs to reach those hosts — a placeholder credential, a
   * base URL. Every command `exec` runs and every CLI turn gets it, over its
   * own environment. Never a secret: the container can read it.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Serve one intercepted request: swap the placeholder for the real credential, then {@link forward}. */
  handle(call: EgressCall): Promise<Response>;
}

/** One request the container made, for the rule serving its host. */
export interface EgressCall {
  readonly request: Request;
  /** The rule's upstream for the request's host, with the request's path and query. */
  readonly target: URL;
  /** The Worker's `env`, where a credential is read at the moment it is used. */
  readonly env: Readonly<Record<string, unknown>>;
  /**
   * The sandbox whose container made the request, by the name it was reached
   * by — waking it if it is not in memory. Throws for a sandbox reached without
   * a name.
   */
  sandbox(): DurableObjectStub;
}

/** What one sandbox registers for its rules. */
export interface EgressPlan {
  /** Intercepted over HTTP by the harness, at every start. */
  readonly http: readonly EgressRoute[];
  /** Intercepted over HTTPS by the sandbox, once per container. */
  readonly https: readonly EgressRoute[];
  /** Every rule's `env`, merged. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * On each route, `<binding>/<name>` of the sandbox it was registered by. A
 * route is the only thing the harness hands the entrypoint, so it is the only
 * way the entrypoint can know which sandbox's container is calling.
 */
const ROUTE_SANDBOX = "x-da-sandbox";

/** Headers that carry a credential, which a handler removes from what the container sent. */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "x-api-key",
  "proxy-authorization"
];

/**
 * `rules` as the sandbox `sandbox` (`<binding>/<name>`) registers them.
 *
 * Throws for a host two rules declare, an environment key two rules set, or an
 * upstream that is not https: each would otherwise surface as a request that
 * reaches the wrong handler, or none.
 */
export function egressPlan(
  rules: readonly SandboxEgressRule[],
  sandbox?: string
): EgressPlan {
  const hosts = new Map<string, string>();
  const keys = new Map<string, string>();
  const http: EgressRoute[] = [];
  const https: EgressRoute[] = [];
  const env: Record<string, string> = {};
  const route = (
    rule: SandboxEgressRule,
    host: string,
    upstream: string
  ): EgressRoute => {
    const owner = hosts.get(host);
    if (owner !== undefined)
      throw new Error(
        `egress: ${host} is declared by both ${owner} and ${rule.name}`
      );
    hosts.set(host, rule.name);
    if (!upstream.startsWith("https://"))
      throw new Error(
        `egress: ${rule.name} sends ${host} to ${upstream}, which is not https`
      );
    return {
      host,
      upstream,
      headers: sandbox === undefined ? {} : { [ROUTE_SANDBOX]: sandbox },
      strip: []
    };
  };
  for (const rule of rules) {
    for (const [host, upstream] of Object.entries(rule.http ?? {}))
      http.push(route(rule, host, upstream));
    for (const [host, upstream] of Object.entries(rule.https ?? {}))
      https.push(route(rule, host, upstream));
    for (const [key, value] of Object.entries(rule.env ?? {})) {
      const owner = keys.get(key);
      if (owner !== undefined)
        throw new Error(
          `egress: ${key} is set by both ${owner} and ${rule.name}`
        );
      keys.set(key, rule.name);
      env[key] = value;
    }
  }
  return { http, https, env };
}

/**
 * Serve one request the container made: `routes` are what the sandbox
 * registered for this container, which the harness hands the entrypoint as its
 * props, and `rules` the same list the sandbox's config holds.
 */
export async function sandboxEgress(
  request: Request,
  routes: readonly EgressRoute[],
  env: Readonly<Record<string, unknown>>,
  rules: readonly SandboxEgressRule[]
): Promise<Response> {
  const url = new URL(request.url);
  const route = routes.find((each) => each.host === url.hostname);
  if (!route) {
    return new Response(`No egress route for ${url.hostname}`, { status: 403 });
  }
  for (const rule of rules) {
    const upstream =
      upstreamOf(rule.http, url.hostname) ??
      upstreamOf(rule.https, url.hostname);
    if (upstream === undefined) continue;
    const named = route.headers[ROUTE_SANDBOX];
    return rule.handle({
      request,
      target: new URL(
        `${upstream.replace(/\/+$/, "")}${url.pathname}${url.search}`
      ),
      env,
      sandbox: () => sandboxStub(env, named)
    });
  }
  return new Response(`No egress rule serves ${url.hostname}`, {
    status: 403
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

function upstreamOf(
  hosts: Readonly<Record<string, string>> | undefined,
  host: string
): string | undefined {
  return hosts && Object.hasOwn(hosts, host) ? hosts[host] : undefined;
}

function sandboxStub(
  env: Readonly<Record<string, unknown>>,
  named: string | undefined
): DurableObjectStub {
  const slash = named?.indexOf("/") ?? -1;
  const namespace =
    named !== undefined && slash > 0 ? env[named.slice(0, slash)] : undefined;
  if (
    named === undefined ||
    !namespace ||
    typeof (namespace as DurableObjectNamespace).getByName !== "function"
  ) {
    throw new Error(
      `egress: this route names no sandbox the Worker can reach (${JSON.stringify(named ?? null)}); ` +
        "a sandbox is reached by name, and its config's `egress.self` is its binding"
    );
  }
  return (namespace as DurableObjectNamespace).getByName(
    named.slice(slash + 1)
  );
}
