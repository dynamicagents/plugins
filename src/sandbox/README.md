# `@dynamicagents/plugins/sandbox`

A container whose own disk is the checkout, driven from a Durable Object through `agents`'
`ContainerHarness`.

The object holds the durable record: sessions, operations, the transcript, and each CLI's resume
files. It **dials** the daemon in the container, and the container never dials back. The files never
cross into the object; inspecting them means asking the container. A container is disposable: it
stops when idle, and the next start begins from a snapshot of its disk.

So a reset of the object touches none of what the container is doing. The container keeps running,
and the object reattaches and replays what it missed. A container that dies settles its run as
`container_lost`, and the run's session resumes in the next container.

## What `ContainerHarness` does not do, and how this closes it

The harness is imported, not forked. What it lacks is closed from outside it, and each gap below is
one a spec here pins (`object.spec.ts`), over the real harness and the real daemon core:

| the harness…                                                                 | so the sandbox…                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| re-arms the container's inactivity timeout only in its lifecycle's `onStart` | starts the lifecycle in the constructor, so no RPC reaches the container without it. A wake that skipped it was measured stopping the container within seconds.                                                                                                                                     |
| starts a container only for a prompt                                         | keeps the root session as a **control session** that the daemon answers without a CLI. `ensureRunning()` is a `control:wake` prompt on it.                                                                                                                                                          |
| takes adapter options once per harness, and runs every turn in one directory | puts a **run header** on the prompt's first line (`header.ts`) with each run's mode, schema, effort, fork and `cwd`. The daemon takes it off before the CLI reads its stdin.                                                                                                                        |
| refuses a session id it did not mint                                         | maps each run to the session it made (`createRun`)                                                                                                                                                                                                                                                  |
| intercepts egress over HTTP only                                             | intercepts `egress.https` routes itself once per container, trusts the CA the runtime mounts after that call, and only then writes [`EGRESS_READY`](./constants.ts) with the container's runtime id. A CLI turn waits for that marker, and the alarm checks for new containers while a run is open. |
| snapshots a container only when it stops it                                  | `checkpoint()` snapshots now and writes the harness's own record, so that is the next start. `seedFrom()` starts another sandbox of the class from it.                                                                                                                                              |
| stops with no hook                                                           | the sandbox's own idle stop **backs up every checkout to R2** (`DirectoryBackup`), then stops. A start on a new image, which drops the snapshot, restores each checkout from its backup.                                                                                                            |
| settles an abort before the CLI has left                                     | `stopRun()` waits for no CLI to be left, plus one sync, before anything commits or stops                                                                                                                                                                                                            |

## The object

```ts
import {
  DEFAULT_INSTALL_PLAN,
  githubRoute,
  GITHUB_PLACEHOLDER_HOST,
  SandboxObjectBase,
  type SandboxObjectConfig
} from "@dynamicagents/plugins/sandbox";

export class CodingSandbox extends SandboxObjectBase<Env> {
  protected sandboxConfig(): SandboxObjectConfig {
    return {
      label: "coding-sandbox",
      adapter: "da-claude", // the adapter id the image's daemon serves
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 8000 },
      egress: {
        binding: this.ctx.exports.CodingEgress,
        routes: [
          githubRoute({
            host: GITHUB_PLACEHOLDER_HOST,
            upstream: "https://github.com",
            tokenBinding: "GITHUB_TOKEN",
            push: { repos: ["owner/repo"], branches: ["coding/*"] }
          })
        ]
      },
      installPlan: { ...DEFAULT_INSTALL_PLAN, overrides: {} },
      backups: {
        binding: "SANDBOX_BACKUPS",
        prefix: "coding/",
        gateway: this.ctx.exports.DirectoryBackupGateway
      }
    };
  }
}
```

Address a sandbox by **name** only (`getByName`/`idFromName`): `agents`' `Lifecycle` cannot start
without `ctx.id.name`.

The RPCs:

- `ensureRunning`, `exec` (always as the agent, through `setpriv` with no capabilities), and the file
  RPCs over `@cloudflare/sandbox`'s `Files`, confined to `/workspace`;
- `createRun`, `submit`, `poll` (stored messages of one operation, each with a digest), `stopRun`;
- `checkpoint`, `snapshotRecord`, `seedFrom`, `release`;
- `noteCheckout`, `checkoutDir`, `startInstall`, `advisories`, `reclaimIfIdle`;
- `debug`, which exists only when `debugSecretBinding` names a secret.

## Egress

Each route's `host` is intercepted in the container and handed to one entrypoint the consumer
exports. That entrypoint serves it with `sandboxEgress`, plus a handler per route kind it adds.
GitHub is built in. The Anthropic credential pool is `/claude-code`'s, so it arrives as a handler
rather than an import:

```ts
export class CodingEgress extends WorkerEntrypoint<
  Env,
  { routes: EgressRoute[] }
> {
  fetch(request: Request) {
    return sandboxEgress(request, this.ctx.props.routes, this.env);
  }
}
```

**GitHub** requests go out anonymous unless they present `GITHUB_TOKEN_PLACEHOLDER`, which commands
get from `githubEnv()`. The egress swaps the placeholder for the token it reads from `env` at that
moment. git reaches GitHub through `GITHUB_PLACEHOLDER_HOST` over plain HTTP, so nothing in the
container terminates TLS. With a `push` policy, a credentialed `git-receive-pack` may update only the
allowed branches of the allowed repositories, and the refs are read from the request before GitHub
sees it.

## The image

The daemon is `@dynamicagents/plugins/sandbox/daemon`, which is Node-only. A consumer bundles it
with its own CLI options from its own `node_modules`, so the daemon and the object speak one `agents`
version:

```ts
import { serveSandboxDaemon } from "@dynamicagents/plugins/sandbox/daemon";

await serveSandboxDaemon({
  cli: { id: "da-claude", stateDirs: [".claude/projects"], command, parser }
});
```

The image provides:

- the user `agent` (uid and gid `10001`, home `/home/agent`), owning `/workspace`;
- `setpriv` (util-linux), `timeout` (coreutils), `git`, and `update-ca-certificates`;
- `/usr/local/bin/sandbox-shim`, from `cloudflare/sandbox`'s donor image, for `Files` and `DirectoryBackup`;
- `/etc/da/skel`, root-owned, which every session's home starts as. It may be empty.

The daemon runs as `agent`, holding one capability, `net_bind_service`, and refuses to start
otherwise:

```dockerfile
ENTRYPOINT ["setpriv", "--reuid=10001", "--regid=10001", "--init-groups", \
  "--inh-caps=-all,+net_bind_service", "--ambient-caps=+net_bind_service", \
  "--bounding-set=-all,+net_bind_service", "node", "/opt/da/daemon.mjs"]
```

It launches the CLI without that capability. The capability grants nothing here; it is there so
Linux refuses agent processes the daemon's `/proc/<pid>/environ` and `mem`, where the harness's
token is. As root, the daemon would instead have the harness chown each session home, and chown
follows a symlink the agent left there to the file it names. Each session's home lives under
`/home/agent/.harness/sessions`, which the agent owns. A session writes its resume files there, so a
lost container can resume it.

## `wrangler.jsonc`

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "CODING_SANDBOX", "class_name": "CodingSandbox" }]
  },
  "containers": [
    {
      "class_name": "CodingSandbox",
      "scheduling_policy": "durable_object",
      "images": { "app": { "dockerfile": "./Dockerfile.sandbox" } }
    }
  ],
  "r2_buckets": [
    { "binding": "SANDBOX_BACKUPS", "bucket_name": "my-sandbox-backups" }
  ]
}
```

The Worker entry exports the egress entrypoint and `DirectoryBackupGateway`, so both exist on
`ctx.exports`.

## What a snapshot is

A container snapshot is the writable root filesystem: the checkout and `node_modules`, with no
memory and no processes. It restores only onto the image it was taken on. Measured on a 1.8 GB
checkout:

|                                       | time       |
| ------------------------------------- | ---------- |
| first snapshot                        | about 27 s |
| restore                               | 2–3 s      |
| later snapshot (an incremental delta) | about 5 s  |

A `DirectoryBackup` is a directory as tar+zstd in R2, and restores onto any image. Its gateway needs
only the R2 binding.
