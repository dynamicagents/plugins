/**
 * A container for specs: the real harness daemon core, served over a
 * `WebSocketPair` from inside the Worker, with `exec` answered by a script.
 *
 * Adapted from `agents`' own harness specs (`packages/agents/src/harness/
 * container/tests/fake-container.ts` in cloudflare/agents, MIT, Copyright (c)
 * 2025 Cloudflare, Inc.), with what a sandbox adds: images, HTTPS intercepts
 * and a scriptable `exec`.
 */
import {
  CLOSE_UNAUTHORIZED,
  CONTAINER_ENV,
  CONTAINER_HEALTH_PATH,
  CONTAINER_SESSION_PATH,
  CONTAINER_TOKEN_HEADER,
  ContainerDaemon,
  type ContainerAdapter
} from "agents/harness/container/daemon";

export interface ExecCall {
  readonly cmd: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
}

export type ExecScript = (
  call: ExecCall
) => { exitCode?: number; stdout?: string; until?: Promise<void> } | undefined;

export class FakeContainer {
  readonly images = { app: "test-image" };
  starts = 0;
  lastStart: { image?: string; containerSnapshot?: { id: string } } = {};
  lastEnv: Record<string, string> = {};
  inactivityTimeoutMs: number | undefined;
  execs: ExecCall[] = [];
  intercepts = new Map<string, Fetcher>();
  httpsIntercepts = new Map<string, Fetcher>();
  snapshots = 0;
  script: ExecScript = () => undefined;
  #daemon: ContainerDaemon | undefined;
  #token = "";
  #sockets = new Set<WebSocket>();
  readonly #adapter: ContainerAdapter;

  constructor(adapter: ContainerAdapter) {
    this.#adapter = adapter;
  }

  get running(): boolean {
    return this.#daemon !== undefined;
  }

  start(options?: {
    env?: Record<string, string>;
    image?: string;
    containerSnapshot?: { id: string };
  }): void {
    const env = options?.env ?? {};
    this.starts += 1;
    this.lastEnv = { ...env };
    this.lastStart = {
      ...(options?.image ? { image: options.image } : {}),
      ...(options?.containerSnapshot
        ? { containerSnapshot: options.containerSnapshot }
        : {})
    };
    this.execs = [];
    this.intercepts = new Map();
    this.httpsIntercepts = new Map();
    this.#token = env[CONTAINER_ENV.token] ?? "";
    this.#daemon = new ContainerDaemon({
      adapter: this.#adapter,
      runtimeId: env[CONTAINER_ENV.runtimeId] ?? "unknown"
    });
  }

  async exec(
    cmd: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<{
    exitCode: Promise<number>;
    output(): Promise<{
      exitCode: number;
      stdout: ArrayBuffer;
      stderr: ArrayBuffer;
    }>;
    kill(): void;
  }> {
    if (!this.running) throw new Error("container is not running");
    const call: ExecCall = {
      cmd: [...cmd],
      cwd: options?.cwd,
      env: options?.env
    };
    this.execs.push(call);
    const answer = this.script(call) ?? {};
    const exitCode = answer.exitCode ?? 0;
    const bytes = new TextEncoder().encode(answer.stdout ?? "");
    const stdout = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
    const ended = (answer.until ?? Promise.resolve()).then(() => exitCode);
    return {
      exitCode: ended,
      output: async () => ({
        exitCode: await ended,
        stdout,
        stderr: new ArrayBuffer(0)
      }),
      kill: () => {}
    };
  }

  async snapshotContainer(): Promise<{ id: string; size: number }> {
    if (!this.running) throw new Error("container is not running");
    this.snapshots += 1;
    return { id: `snapshot-${this.snapshots}`, size: 1 };
  }

  async interceptOutboundHttp(host: string, binding: Fetcher): Promise<void> {
    this.intercepts.set(host, binding);
  }

  async interceptOutboundHttps(host: string, binding: Fetcher): Promise<void> {
    this.httpsIntercepts.set(host, binding);
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.inactivityTimeoutMs = Number(ms);
  }

  async destroy(): Promise<void> {
    const daemon = this.#daemon;
    this.#daemon = undefined;
    for (const socket of this.#sockets) {
      try {
        socket.close(1011, "container stopped");
      } catch {
        // Already closed, or owned by an aborted object.
      }
    }
    this.#sockets.clear();
    await daemon?.close();
  }

  /** The container dies under the object, as a crash or a host failure would. */
  crash(): Promise<void> {
    return this.destroy();
  }

  getTcpPort(_port: number): Fetcher {
    const bound = this.#daemon;
    const fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const daemon = this.#daemon;
        if (!daemon || daemon !== bound) {
          throw new Error(
            "There is no container instance that can be provided to this Durable Object"
          );
        }
        const url = new URL(request.url);
        if (url.pathname === CONTAINER_HEALTH_PATH) return new Response("ok");
        if (!url.pathname.startsWith(CONTAINER_SESSION_PATH)) {
          return new Response("not found", { status: 404 });
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        server.accept();
        if (request.headers.get(CONTAINER_TOKEN_HEADER) !== this.#token) {
          server.close(CLOSE_UNAUTHORIZED, "unauthorized");
          return new Response(null, { status: 101, webSocket: client });
        }
        this.#sockets.add(server);
        const session = decodeURIComponent(
          url.pathname.slice(CONTAINER_SESSION_PATH.length)
        );
        const connection = daemon.connect(session, {
          send: (text) => server.send(text),
          close: (code, reason) => {
            try {
              server.close(code, reason);
            } catch {
              // Owned by an aborted object.
            }
          }
        });
        server.addEventListener("message", (event) => {
          connection.receive(
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data)
          );
        });
        server.addEventListener("close", () => {
          this.#sockets.delete(server);
          connection.closed();
        });
        return new Response(null, { status: 101, webSocket: client });
      }
    };
    // SAFETY: the harness calls only `fetch` on a container port.
    return fetcher as unknown as Fetcher;
  }

  asContainer(): Container {
    // SAFETY: the harness and the sandbox use only the members above.
    return this as unknown as Container;
  }
}

const containers = new Map<string, FakeContainer>();

/** The fake container for one object, kept across that object's restarts. */
export function containerFor(
  id: DurableObjectId,
  adapter: ContainerAdapter
): FakeContainer {
  const key = id.toString();
  let container = containers.get(key);
  if (!container) {
    container = new FakeContainer(adapter);
    containers.set(key, container);
  }
  return container;
}

/** The fake behind an object, for a spec to inspect or break. */
export function fakeOf(id: DurableObjectId): FakeContainer {
  const container = containers.get(id.toString());
  if (!container) throw new Error(`no fake container for ${id.toString()}`);
  return container;
}
