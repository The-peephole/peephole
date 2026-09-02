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

The exact worker isolation technology is an infrastructure decision, but it must satisfy the security requirements in the architecture and runtime documents.

## Planned UX

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
is shown disabled with a configuration explanation. This repository defines the
HTTP contract but does not yet bundle or deploy a public control-plane server.

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

After pointing `PEEPHOLE_POSTGRES_TEST_URL` at a disposable test database, run
`npm test -- --run tests/postgresIntegration.test.ts` to apply the idempotent
schema and verify concurrent leasing plus expired-lease recovery. The test
removes the jobs it creates but intentionally leaves the schema in place.

This is still infrastructure code, not a deployed public service. The database
schema, concurrent worker claiming, and expired-lease recovery have been
verified against local PostgreSQL 18.4. Requester authentication, hosted
artifact storage/delivery, and a prepared gVisor host remain required. The
in-memory adapters and local host runner remain test/development-only.

## Current Status

Milestones 0-4 are complete. The local development runner has proven both
golden paths, and Milestone 6 is now in progress:

- repository URL detection,
- GitHub action insertion,
- a compact GitHub action that opens Chrome Side Panel,
- tab-specific repository context synchronization across GitHub navigation,
- idempotent client-side navigation handling,
- typed GitHub REST metadata client,
- background service-worker API broker,
- default branch and commit SHA resolution,
- bounded known-file inspection for the root manifest, recognized lockfiles, environment templates, and Vite configuration,
- framework, TypeScript, package-manager, build-plan, environment, deployment, and workspace detection,
- versioned native-preview eligibility with evidence, warnings, and blockers,
- lazy loading, request cancellation, rate-limit errors, and commit-aware analysis caching,
- analysis and eligibility rendered in the native side panel,
- a typed Preview API client with bounded response validation,
- commit-pinned build creation, status polling, cancellation, retry, and stale-request cleanup in the side panel,
- preview control-plane and worker contracts,
- a tested Node HTTP ingress with liveness/readiness and bounded request handling,
- PostgreSQL job/cache/quota persistence and a leased durable queue,
- a queue-driven worker loop with acknowledgement and delayed retry,
- exact-commit GitHub revalidation and server-owned build-plan resolution,
- real local-development adapters for static HTML and root Vite + React/npm
  golden paths,
- gVisor adapter code with limits and cleanup wiring, pending verification on
  a real Linux/gVisor host.

The extension never installs dependencies or executes repository code. The
Preview API connection is configurable but no public service is deployed yet.
Hosted artifacts, trusted preview embedding, and real gVisor infrastructure
verification remain unfinished.

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
