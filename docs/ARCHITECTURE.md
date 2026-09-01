# Architecture

## 1. Overview

Peephole has four trust-separated layers:

```text
GitHub page
    |
    v
Chrome extension ----------------------------+
    |                                        |
    | analysis / preview requests            | presentation only
    v                                        |
Preview control plane                        |
    |                                        |
    | immutable build plan                   |
    v                                        |
Isolated execution plane                     |
    |                                        |
    | static artifacts                       |
    v                                        |
Dedicated preview origin --------------------+
```

The extension integrates with GitHub and presents results. The control plane validates and schedules. The execution plane handles hostile repository code. The delivery plane serves only published artifacts.

## 2. Primary Design Rules

1. GitHub DOM integration is an adapter, not business logic.
2. Repository analysis does not import browser DOM code.
3. Preview eligibility is separate from evidence collection.
4. The extension and control API never execute repository source.
5. Every build is commit-pinned, short-lived, isolated, and reproducible enough to cache.
6. Unsupported is a first-class result, not an exception to bypass.

## 3. Extension Layer

### GitHub adapter

Responsible for:

- extracting `owner/repo` from the current URL,
- verifying that the page is a real repository context,
- locating the current visible repository action area,
- inserting and removing exactly one Peephole action,
- observing GitHub client-side navigation,
- resetting view state when repository identity changes.

It must not analyze `package.json`, call runner infrastructure directly, or infer preview compatibility from DOM text.

### Application and UI

The application layer owns selected repository state, analysis requests, preview job state, cancellation, and stale-result protection. The compact GitHub action opens a Chrome side panel for the complete experience.

Content scripts do not perform cross-origin GitHub API fetches. They send typed repository operations to the background service worker. The background validates owner/repository input, performs only fixed GitHub API operations, owns the metadata cache, and forwards cancellation. It never accepts an arbitrary URL from a content script.

The side panel shows:

- repository identity,
- detected evidence and blockers,
- preview eligibility,
- build progress,
- the resulting preview or a clear unsupported/failure state.

Preview content is embedded only from the dedicated Peephole preview origin. Existing third-party deployments may need to open in a new tab when framing is prohibited.

## 4. Analysis Layer

Analysis fetches a bounded list of repository metadata and text files. It produces facts about framework, package manager, commands, environment declarations, deployment evidence, and monorepo shape.

It must be:

- deterministic for the same commit,
- evidence-based,
- resilient to missing or malformed files,
- independent from GitHub DOM selectors,
- free of repository-code execution.

See [Repository analysis](REPOSITORY_ANALYSIS.md).

## 5. Preview Eligibility

Eligibility converts analysis into one of three modes:

```ts
type PreviewMode =
  | "existing-deployment"
  | "native-static-build"
  | "unsupported"
```

An eligibility result includes evidence, blockers, a package manager, a build command, and an output directory when known. A missing or ambiguous value must not be guessed in order to force a build.

Priority:

1. use a confirmed existing deployment when it is safe and useful,
2. otherwise offer a native static build when the compatibility contract is satisfied,
3. otherwise show analysis and blockers only.

StackBlitz is not a preview mode.

## 6. Preview Control Plane

The control plane exposes asynchronous, idempotent preview jobs. It:

- authenticates the Peephole client when needed,
- resolves repository id and commit SHA,
- revalidates the submitted build plan,
- returns a cached artifact when the cache key matches,
- queues a new job otherwise,
- exposes status, cancellation, expiry, and result metadata,
- never runs package installation or build commands in its own process.

Minimum API shape:

```text
POST   /v1/preview-jobs
GET    /v1/preview-jobs/{jobId}
DELETE /v1/preview-jobs/{jobId}
```

## 7. Execution Plane

The v0.1 runner performs a static build:

1. create a fresh isolated job sandbox,
2. download a public repository archive at the exact commit SHA,
3. verify size and file-count limits,
4. install dependencies using the selected lock file and frozen mode,
5. run the approved build command,
6. validate the configured output directory,
7. publish static artifacts,
8. destroy the writable job workspace.

The runner is described in [Preview runtime](PREVIEW_RUNTIME.md).

## 8. Delivery Plane and Origins

Use different trust origins:

```text
api.peephole.dev       control API
app.peephole.dev       optional web control UI
{job-id}.peephole.run  untrusted preview content
```

The preview domain should be a separate registrable domain, not merely another subdomain of the control UI. It must not receive control-plane cookies, extension tokens, or infrastructure credentials.

Preview responses require restrictive headers and no privileged extension messaging bridge. Cross-job storage isolation should use a per-job origin where practical.

## 9. Caching

Analysis cache key:

```text
repository-id + commit-sha + analyzer-version
```

Build cache key:

```text
repository-id + commit-sha + normalized-build-plan + runner-version
```

Branch names alone are not valid cache keys. Failed builds may use a short negative-cache TTL to prevent rapid repeated abuse, but users need a retry path after configuration changes.

## 10. GitHub SPA Navigation

Navigation handling must combine GitHub navigation events with an idempotent reconciliation step. On every relevant transition:

1. parse the current URL,
2. validate repository context,
3. compare repository identity,
4. abort or detach requests for the old identity,
5. update, insert, or remove the action,
6. ensure no duplicate roots remain.

Async responses must carry their repository key and be discarded if it no longer matches current state.

## 11. Security Boundary

Assume repository files, dependency scripts, build tools, generated HTML, and network requests are malicious.

Required controls include:

- non-root execution,
- disposable per-job isolation,
- CPU, memory, process, disk, output-size, and wall-time limits,
- read-only base image and a bounded writable workspace,
- no host filesystem, container socket, or sibling-job access,
- blocked private, loopback, link-local, and cloud-metadata networks,
- allowlisted dependency-registry egress only during installation,
- no secret environment values,
- build and artifact TTLs,
- cancellation and orphan cleanup,
- audit logs without repository secrets.

A plain shared process or unrestricted container is not an acceptable production boundary for untrusted public builds.

## 12. Suggested Layout

```text
entrypoints/             extension entrypoints
components/              presentation components
core/github-dom/         GitHub selectors and navigation adapter
core/github/             GitHub data client
core/analyzer/           pure evidence detectors
core/preview/            eligibility and client contracts
services/preview-api/    control plane
services/preview-worker/ isolated build worker
types/                   shared domain types
```

Deployable service boundaries may live in separate repositories later. Their contracts must remain explicit here.
