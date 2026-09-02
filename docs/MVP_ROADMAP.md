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

This milestone is API- and storage-only: no build command is ever executed by
this process. Execution is deferred to the isolated runner in Milestone 5.

## Milestone 5 - Isolated Static Runner

**Status:** Real adapters proven for both golden paths in an unsandboxed
development runner, with active timeout/disk-quota enforcement and orphan
reaping; gVisor adapter and its reaper are written but unverified on real
gVisor. Remaining work needs a real Linux/gVisor host and infra decisions
this environment cannot provide (see D-018..D-021 and PREVIEW_RUNTIME.md
§15).

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
      cleanup -- written against documented `runsc`/OCI behavior and tested
      via a fake process runner, but **never run against a real gVisor
      host** (this repo's environment has no Linux kernel)
- [x] real, active job wall-clock timeout: every install/build command's
      timeout is clamped to the job's remaining budget
      (`jobDeadline.ts`), so exceeding it kills the actual running process
      instead of only flipping the job's status after the fact
- [x] real workspace disk-usage quota, checked after install and after
      build independent of archive/output size checks
- [x] orphan-sandbox reaping: `LocalDevSandboxReaper` (real, tested) and
      `GVisorOrphanReaper` (written against `runsc list --format json`,
      unverified against a real binary)
- [ ] fresh non-root sandbox per job on a **real** gVisor host (unverified)
- [ ] deterministic install with registry-only egress (network policy not enforced)
- [ ] CPU/memory/PID limits actually enforced on a **real** gVisor host (unverified)
- [ ] static artifact publication with restrictive headers (local-fs stand-in only)
- [ ] prepared base rootfs image for `GVisorSandboxProvisioner`

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

**Status:** In progress. Repository context, analysis, eligibility, and errors
now live in Chrome Side Panel; preview-job controls and trusted preview delivery
are not connected yet.

**Goal:** Complete the user-facing Peephole flow.

- [x] add Chrome Side Panel entrypoint
- [x] move repository analysis, eligibility, and analysis errors into the panel
- [x] synchronize repository context across GitHub client-side navigation
- [ ] show preview job progress and errors
- [ ] start and cancel preview jobs
- [ ] embed only trusted Peephole preview-origin URLs
- [ ] detach stale preview jobs on GitHub navigation

## Milestone 7 - Security and Reliability Gate

**Goal:** Make the public build service safe enough for v0.1.

- malicious dependency-script fixtures
- CPU, memory, process, disk, output, and time-limit tests
- private-network and metadata endpoint blocking tests
- cross-job and cross-origin isolation tests
- abuse throttling and budget controls
- cache invalidation and runner-version rollout
- operational metrics, logs, cancellation, and cleanup alerts

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
