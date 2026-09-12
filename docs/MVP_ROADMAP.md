# MVP Roadmap

## Release Target

v0.1 proves one complete native path:

```text
supported public GitHub repository
-> Peephole action
-> analysis and eligibility
-> isolated static build
-> preview in the Peephole side panel
```

StackBlitz is not part of the release target.

## Milestone 0 - Repository Setup

**Status:** Complete

- WXT, React, and TypeScript
- linting, formatting, tests, and production build
- extension permissions kept minimal

## Milestone 1 - GitHub Injection

**Status:** Complete

- parse valid repository URLs
- reject non-repository GitHub routes
- insert exactly one Peephole action
- open a functional owner/repository panel
- update correctly across GitHub client-side navigation
- avoid stale and duplicate UI

The temporary StackBlitz action from this milestone was removed before Milestone 2 work began.

## Milestone 2 - Repository Metadata

**Status:** Complete

**Goal:** Establish an immutable, bounded analysis input.

- [x] fetch repository id, default branch, and head commit SHA
- [x] fetch homepage and relevant repository metadata
- [x] inspect `package.json`, recognized lockfile presence, environment templates, and selected config files
- [x] cache resolved metadata by repository id and commit SHA
- [x] handle malformed content, request cancellation, and rate limits
- [x] handle bounded known-file fetching and missing-file results

## Milestone 3 - Analysis and Preview Eligibility

**Status:** Complete

**Goal:** Decide whether a repository fits the v0.1 contract without executing it.

- [x] framework and TypeScript detection
- [x] package manager and frozen-install command
- [x] build command and output-directory detection
- [x] environment and external-service blockers
- [x] existing deployment evidence
- [x] monorepo ambiguity detection
- [x] eligibility result with evidence and blockers

Acceptance: fixtures resolve deterministically to `existing-deployment`, `native-static-build`, or `unsupported`.

## Milestone 4 - Preview Control Plane

**Status:** Complete

**Goal:** Create safe, observable, commit-pinned jobs.

- [x] create/status/cancel API
- [x] idempotency and cache lookup
- [x] job queue and lifecycle persistence
- [x] signed, expiring artifact references
- [x] rate limits, per-user/repository quotas, and structured failure codes
- [x] fake-runner integration tests
- [x] real Node HTTP ingress with bounded JSON, request timeouts,
      liveness/readiness probes, safe errors, and graceful shutdown
- [x] provider-neutral PostgreSQL job/cache/quota persistence and leased queue
- [x] server-side exact-commit revalidation and build-plan resolution
- [x] production composition with PostgreSQL persistence and durable queue,
      GitHub App requester authentication, and deployed service configuration
      (`services/production/server.ts`), verified end to end on AWS EC2

This milestone is API- and storage-only: no build command is ever executed by
this process. Execution is deferred to the isolated runner in Milestone 5.

## Milestone 5 - Isolated Static Runner

**Status:** Core production runner path complete and verified. The real gVisor
worker and golden path are verified on AWS EC2 Linux (`realGvisorSandbox`:
15/15; `realGvisorGoldenPath`: 1/1). Broader supported-fixture coverage and
authenticated package-proxy egress remain.

**Goal:** Build the first supported repositories without third-party IDEs.

- [x] fetch/install/build/publish worker contract (`services/preview-worker`) driving
      `PreviewControlPlane` phase transitions, verified with fake adapters
- [x] archive and output size/file-count/path-safety policy
      (`core/runner/archivePolicy.ts`), enforced regardless of runner backend
- [x] guaranteed workspace cleanup on success, failure, or concurrent cancellation
- [x] production isolation technology selected and documented (D-018: gVisor,
      Firecracker deferred)
- [x] real `GitHubCommitArchiveFetcher`: commit-pinned codeload download,
      real tar parsing, streamed compressed-size cap
- [x] real archive extraction (`services/preview-worker/local/archiveExtractor.ts`,
      the `tar` package) rejecting traversal/absolute paths/symlinks/device files
- [x] real `NpmDependencyInstaller`/`NpmBuildExecutor`/`LocalOutputResolver`/
      `LocalArtifactPublisher`, proven end to end against real GitHub archives
      for both golden paths (`tests/realStaticHtmlGoldenPath.test.ts`,
      `tests/realViteReactGoldenPath.test.ts`, gated behind
      `PEEPHOLE_REAL_NETWORK_TESTS=1`)
- [x] `GVisorSandboxProvisioner`/`RunscCommandRunner`: real OCI-bundle +
      `runsc` CLI code, CPU/memory/PID quotas, non-root, cancellation-safe
      cleanup, verified against real runsc/gVisor on AWS EC2
- [x] real, active job wall-clock timeout: every install/build command's
      timeout is clamped to the job's remaining budget
      (`jobDeadline.ts`), so exceeding it kills the actual running process
      instead of only flipping the job's status after the fact
- [x] real workspace disk-usage quota, checked after install and after
      build independent of archive/output size checks
- [x] fixed-size loop-backed ext4 workspace hard quota, read-only rootfs,
      bounded `/tmp` and `/dev/shm`, host-reserve admission, and fail-closed
      mount/loop/image/bundle recovery, verified on the real AWS host
- [x] orphan-sandbox reaping: `LocalDevSandboxReaper` (real, tested) and
      `GVisorOrphanReaper`, including real abandoned-container and production
      `SIGKILL` recovery verification
- [x] durable queue consumer loop with lease acknowledgement, delayed retry,
      and graceful polling shutdown
- [x] fresh non-root sandbox per job on a real gVisor host (uid/gid 65534)
- [x] deterministic install with public IPv4 egress while host, private,
      link-local, metadata, and inter-job destinations are denied
- [ ] replace broad public install egress with an authenticated package proxy
- [x] CPU throttling and memory/PID limits enforced on a real gVisor host
- [x] static artifact publication with restrictive headers and expiry through
      both the local development host and the production artifact host
- [x] prepared base rootfs image for `GVisorSandboxProvisioner`, exercised by
      real `npm ci` and Vite/esbuild builds

The dev proof (`LocalDevSandboxProvisioner` + `HostCommandRunner`) runs
install/build directly on the host with **no isolation at all** and must
never be pointed at untrusted or arbitrary repository content -- see
D-019 and the adapters' own doc comments.

Golden paths (both proven for real, not with fakes):

1. static HTML repository (`octocat/Spoon-Knife`),
2. root-level Vite + React repository
   (`ppsssj/peephole-fixture-vite-react`, a fixture authored for this
   project, npm only).

Add Vue and Svelte only after the same contract and security tests pass.

## Milestone 6 - Native Side-Panel Preview

**Status:** Complete for the v0.1 production preview path. A real Chrome
Extension has completed GitHub App authentication, requested a preview from
the deployed API, and embedded the resulting HTTPS production artifact after a
real gVisor build.

**Goal:** Complete the user-facing Peephole flow.

- [x] add Chrome Side Panel entrypoint
- [x] move repository analysis, eligibility, and analysis errors into the panel
- [x] synchronize repository context across GitHub client-side navigation
- [x] show preview job progress and errors
- [x] start and cancel preview jobs through the configured HTTP API
- [x] embed only trusted Peephole preview-origin URLs: local loopback during
      development or an exact artifact-id subdomain under the configured
      production artifact base domain
- [x] detach stale preview requests on GitHub navigation
- [x] connect GitHub App authentication and expiring Peephole sessions without
      storing GitHub credentials in the extension
- [x] verify Chrome Extension -> production Preview API -> real gVisor worker
      -> HTTPS artifact -> Side Panel end to end

## Milestone 7 - Security and Reliability Gate

**Status:** In progress. The core sandbox, resource-limit, network-isolation,
cache-rollout, and crash-recovery gates are verified; operational and release
polish remains.

**Goal:** Make the public build service safe enough for v0.1.

- [x] malicious dependency-script and hostile sandbox tests on real gVisor
- [x] CPU, memory, PID, disk hard-cap, output, and wall-clock limits
- [x] metadata, private-network, host-service, and inter-job blocking
- [x] cross-job network and artifact-origin isolation
- [x] API quotas, abuse throttling, and bounded job budgets
- [x] cache invalidation through `runnerVersion: "production-2"` rollout
- [x] cancellation, cleanup, startup reconciliation, and production `SIGKILL`
      recovery core paths
- [ ] production-grade operational metrics, log aggregation, and alerts
- [ ] automated production deployment smoke and release checks
- [ ] replace broad public install egress with an authenticated package proxy
- [ ] keyboard/focus/contrast/screen-reader review and release polish

## v0.1 Definition of Done

v0.1 is complete when:

- exactly one Peephole action works across GitHub SPA navigation,
- analysis is pinned to a commit and explains its evidence,
- a supported static/Vite public repository builds in an isolated runner,
- progress and the final app appear in the Peephole side panel,
- unsupported repositories explain blockers without executing,
- artifacts expire and no secret or privileged origin is exposed,
- the end-to-end flow has no StackBlitz dependency,
- security-gate tests and release smoke tests pass.

## v0.2 Candidates

- private repositories with an explicit GitHub App permission model
- selected workspace support for known monorepos
- Next.js static export
- broader package-manager compatibility
- browser-side bundling as an optimization for very small projects

## Later Candidates

- persistent SSR/Node application sandboxes
- backend and database service composition
- user-provided secrets with a dedicated secret model
- collaborative sessions
- AI-assisted analysis

These require a broader threat model and are not v0.1 shortcuts.
