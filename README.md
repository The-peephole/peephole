# Peephole

> Preview a GitHub repository before you clone it.

Peephole is a Chrome extension and isolated preview service for understanding and previewing supported public GitHub repositories without cloning them locally or handing the repository to a third-party online IDE.

## Problem

Developers often open a repository because they want to answer one question:

> What does this project actually look like?

Today that can require cloning the repository, installing dependencies, finding the right command, supplying environment variables, and discovering too late that the project needs a backend or unsupported tooling.

## Product Goal

Peephole should quickly answer:

- what framework and package manager the repository uses,
- what build or development command is expected,
- whether environment variables or external services are required,
- whether a confirmed deployment already exists,
- whether Peephole can build a safe preview,
- and why a preview is unavailable when it cannot.

## v0.1 Scope

v0.1 targets public, frontend-oriented JavaScript and TypeScript repositories.

The first native-preview compatibility contract is intentionally narrow:

- static HTML/CSS/JavaScript repositories,
- root-level Vite applications using React, Vue, or Svelte,
- repositories that can build without secret environment values,
- repositories with a deterministic package manager and build command,
- static output that can be served from an isolated Peephole preview origin.

Peephole may analyze a broader set of repositories than it can run. Unsupported repositories must receive a clear explanation instead of a best-effort unsafe execution attempt.

## Preview Strategy

```text
GitHub Repository
        |
        v
Peephole Extension
        |
        v
Repository Analysis + Preview Eligibility
        |
        +-- Confirmed deployment found --> Show/Open deployment
        |
        +-- Native static preview supported
        |       |
        |       v
        |   Isolated Peephole build job --> Peephole preview
        |
        +-- Unsupported or blocked --> Analysis and evidence only
```

StackBlitz is not part of the preview architecture. The temporary action from the first UI milestone has been removed; unsupported states now stay inside Peephole.

## Trust Boundary

The Chrome extension is a controller and presentation surface. It never installs dependencies or executes repository source code.

Untrusted build commands run only in an isolated Peephole worker with strict CPU, memory, process, disk, time, and network limits. Built assets are served from a separate preview origin so repository content cannot inherit extension or control-plane privileges.

See [Preview runtime](docs/PREVIEW_RUNTIME.md) for the execution model and threat boundaries.

## Non-goals for v0.1

v0.1 will not:

- run arbitrary code inside the extension,
- guarantee that every repository is runnable,
- support private repositories,
- provision backend services, databases, or secret values,
- support Docker-based projects or arbitrary languages,
- keep persistent Node/SSR application servers alive,
- automatically choose an application inside every monorepo,
- implement AI-generated analysis,
- calculate a misleading numeric previewability score.

## Proposed Stack

Extension:

- WXT
- React
- TypeScript
- Chrome Manifest V3
- Chrome Side Panel

Analysis and preview service:

- GitHub REST API
- Preview control API and job queue
- isolated, disposable build workers
- static artifact storage and a dedicated preview domain

The production worker isolation technology is gVisor on Linux, with a
loop-backed ext4 workspace and per-job network namespace. The local development
launcher remains explicitly unsandboxed.

## User Flow

1. Open a GitHub repository.
2. Click the single `Peephole` action.
3. A side panel shows repository identity and analysis status.
4. For supported repositories, `Build preview` starts an isolated job.
5. The panel displays progress and then the preview.
6. Unsupported repositories show blockers and detected evidence without attempting execution.

## Preview API Configuration

The extension reads the public control-plane base URL at build time:

```text
WXT_PREVIEW_API_BASE_URL=https://api.example.com
```

Copy `.env.example` to `.env.local` for local development. HTTPS is required
except for `localhost`, `127.0.0.1`, or `[::1]`. The configured origin is added
to the generated Chrome host permissions; never place credentials or secrets
in a `WXT_` variable.

If the variable is absent, repository analysis still works and `Build preview`
is shown disabled with a configuration explanation. The production deployment
uses this setting to connect the extension to the public HTTPS Preview API; the
repository also retains a separate local-development launcher.

## Preview API Service Boundary

The control plane now has a real Node HTTP ingress for:

```text
POST   /v1/preview-jobs
GET    /v1/preview-jobs/{jobId}
DELETE /v1/preview-jobs/{jobId}
GET    /healthz
GET    /readyz
```

It applies bounded JSON bodies, request timeouts, no-store/nosniff response
headers, safe error serialization, dependency readiness, and graceful server
shutdown. A provider-neutral PostgreSQL composition now persists jobs, artifact
cache metadata, fixed-window quota counters, and a lease-based durable queue.
The queue uses short database leases so another worker can recover work after a
worker process exits. A separate worker loop leases, runs, acknowledges, or
delays failed deliveries without importing PostgreSQL into the build worker.

Before accepting a job, the server-side resolver verifies the repository id and
exact commit against GitHub, repeats the bounded known-file analysis, and emits
only a build plan supported by the implemented static/Vite React npm runner.
The extension's analysis result is never trusted as an executable plan.

Server configuration is read from `PEEPHOLE_API_HOST`, `PEEPHOLE_API_PORT`,
`PEEPHOLE_API_MAX_BODY_BYTES`, and `PEEPHOLE_API_REQUEST_TIMEOUT_MS`.
PostgreSQL configuration uses `PEEPHOLE_DATABASE_URL`, optional
`PEEPHOLE_DATABASE_POOL_SIZE`, and optional `PEEPHOLE_DATABASE_SSL_CA` for a
remote provider's trusted CA. Remote database connections require verified TLS.
The initial schema is in
`services/preview-api/postgres/migrations/001_initial.sql`.

The production gVisor worker uses a loop-backed ext4 hard cap for each
workspace. `PEEPHOLE_SANDBOX_DISK_BYTES` and
`PEEPHOLE_HOST_DISK_RESERVE_BYTES` configure its proposed 1 GiB/2 GiB
defaults; those values must be validated on the target EC2 volume. See
[Sandbox disk security](docs/SANDBOX_DISK_SECURITY.md) for admission,
cleanup/recovery, concurrency sizing, and the mandatory Linux test gate.
The configured bundles and artifact directories must be on the same filesystem
so publication headroom is covered by that admission check.

After pointing `PEEPHOLE_POSTGRES_TEST_URL` at a disposable test database, run
`npm test -- --run tests/postgresIntegration.test.ts` to apply the idempotent
schema and verify concurrent leasing plus expired-lease recovery. The test
removes the jobs it creates but intentionally leaves the schema in place.

The production composition is deployed on AWS EC2 Ubuntu as the `peephole`
systemd service. Caddy terminates public HTTPS while the Preview API,
`ProductionArtifactHost`, and artifact TLS ask listener bind to loopback. The
API uses PostgreSQL for jobs, queue leases, cache metadata, quotas, and artifact
metadata; GitHub App authentication supplies requester identity. The production
worker runs supported builds in real gVisor sandboxes. In-memory adapters and
the local host runner remain test/development-only.

## Local Development Preview Path

`services/local-preview/devServer.ts` wires the real (non-fake) pieces above
into a single process you can run on a development machine:

```text
Chrome side panel --> Preview API (real Node HTTP ingress)
                            |
                            v
                    PostgreSQL job/queue/cache/quota
                            |
                            v
              local worker loop (no sandbox -- see below)
                            |
                            v
        LocalArtifactHost: one loopback HTTP origin per artifact
```

Run it with:

```text
npm run dev:preview-server
```

It reads `.env.local` for `PEEPHOLE_DATABASE_URL` and the API host/port,
applies the PostgreSQL schema, and starts both the API and a worker loop in
one process. `WXT_PREVIEW_API_BASE_URL=http://localhost:8787` in `.env.local`
points the extension build at it.

This launcher is **not** a preview of the production architecture:

- install/build commands run directly on the host process with no sandbox,
  network restriction, or resource limit -- `GVisorSandboxProvisioner`/
  `RunscCommandRunner` exist and are verified against a real gVisor host
  (see "Isolated Static Runner" in
  [docs/IMPLEMENTATION_CHECKLIST.md](docs/IMPLEMENTATION_CHECKLIST.md)),
  but this launcher still uses the unsandboxed local adapters, since
  Windows has no Linux kernel to run gVisor against directly (see D-018 in
  [Technical decisions](docs/DECISIONS.md));
- artifacts are served from `127.0.0.1`/`[::1]` only, so nothing but a
  developer's own machine can reach a build.

Requests *are* authenticated through a GitHub App. The extension starts the
browser flow with `GET /v1/auth/github/start`; after the callback it sends the
one-time authorization code, signed state, and PKCE verifier to
`POST /v1/auth/session`. The server exchanges the code, resolves the GitHub
user through `/user`, discards the GitHub user access token, and returns a
short-lived Peephole session. The extension keeps that session in
`browser.storage.session`, never stores a GitHub credential, and prompts the
user to reconnect when the 30-minute session expires. See
[docs/GITHUB_APP_AUTH.md](docs/GITHUB_APP_AUTH.md) for the flow, redirect
allowlist, production configuration, and refresh-session follow-up design.

Because of the second point, only build repositories whose source you already
trust. The Chrome side panel now embeds a `ready` job's artifact in a
sandboxed iframe when, and only when, its URL resolves to one of those
loopback origins (`core/preview/config.ts#isTrustedPreviewArtifactUrl`); any
other origin is shown as a plain "not approved for embedding" message
instead of an iframe. This full path --
GitHub source in, a built static site served back out -- has been run
end-to-end against a real public repository (`octocat/Spoon-Knife`) via the
Preview API's HTTP contract.

## Current Status

Milestones 0-6 are complete for the current public static-preview path;
Milestone 7 release and operations work remains. The deployed path is:

```text
GitHub repository
-> Chrome Extension
-> GitHub App authentication
-> Production Preview API
-> PostgreSQL queue/control plane
-> real gVisor worker on AWS EC2
-> isolated install and build
-> production artifact host and Caddy reverse proxy
-> HTTPS preview
-> sandboxed Side Panel embedding
```

Production has been exercised end to end from the unpacked Chrome extension.
The GitHub App OAuth/PKCE/signed-state flow, authenticated requester identity,
real gVisor build, HTTPS artifact publication, and Side Panel embedding are
verified. `tests/realGvisorSandbox.test.ts` passes 15/15 and
`tests/realGvisorGoldenPath.test.ts` passes 1/1 on the AWS Linux/gVisor host.
Those runs cover non-root execution, read-only rootfs, CPU/memory/PID/time
limits, bounded temporary filesystems, loop-backed ext4 workspace capacity,
network isolation, real `npm ci` and Vite/esbuild, cross-container workspace
persistence, artifact publication, and cleanup.

Disk and network resources have durable marker ownership, fail-closed startup
reconciliation, and periodic cleanup. A production fault test killed the
service with `SIGKILL` during install and verified systemd restart,
health/readiness recovery, safe `failed / RUNNER_UNAVAILABLE` terminalization
after queue-lease recovery, and removal of runsc, namespace, veth, iptables,
mount, loop, lease, and job-file residue. The production cache namespace is
`runnerVersion: "production-2"`; replaying a commit cached under
`production-1` produced a cache miss and a successful fresh preview.

The extension never installs dependencies or executes repository code. v0.1
remains intentionally limited to supported public frontend-oriented
JavaScript/TypeScript and static HTML projects, including root Vite
React/Vue/Svelte contracts. Private repositories, backend provisioning,
secrets, arbitrary Docker/language execution, and persistent SSR servers remain
out of scope. Remaining release work includes accessibility review,
production-grade metrics/log aggregation/alerts, automated production smoke
checks, tighter package egress through an authenticated proxy, and Chrome Web
Store/v0.1 release preparation.

The current non-destructive repository validation is green: `npm test` reports
583 passed and 31 environment-gated skips, and typecheck, lint, build,
format-check, and `git diff --check` pass.

## Local Development Setup

1. Have a local PostgreSQL server running; create a database/role for it and
   put the connection string in `PEEPHOLE_DATABASE_URL` in `.env.local`
   (copy `.env.example` as a starting point).
2. `npm run dev:preview-server` -- applies the schema and starts the Preview
   API + worker loop. Keep this running.
3. `npm run build`, then load `.output/chrome-mv3` as an unpacked extension
   at `chrome://extensions` (enable Developer mode first).
4. Open a supported public GitHub repository, click the `Peephole` action,
   and `Build preview`.

Use `http://127.0.0.1:8787`, not `http://localhost:8787`, for
`WXT_PREVIEW_API_BASE_URL` -- Chrome can resolve `localhost` to the IPv6
loopback address first, which nothing is listening on since the API server
binds to `127.0.0.1` only, and this can surface as the preview request
simply failing to reach the service.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Preview runtime](docs/PREVIEW_RUNTIME.md)
- [Repository analysis specification](docs/REPOSITORY_ANALYSIS.md)
- [MVP roadmap](docs/MVP_ROADMAP.md)
- [Implementation checklist](docs/IMPLEMENTATION_CHECKLIST.md)
- [Test plan](docs/TEST_PLAN.md)
- [Technical decisions](docs/DECISIONS.md)
- [Codex implementation guide](CODEX.md)

## Working Principle

Prefer inspection before execution, and execute only after eligibility is established. When execution is necessary, treat the repository as hostile and run it outside the browser extension in a short-lived sandbox.
