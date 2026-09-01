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

**Status:** In progress

**Goal:** Establish an immutable, bounded analysis input.

- [x] fetch repository id, default branch, and head commit SHA
- [x] fetch homepage and relevant repository metadata
- fetch `package.json`, lock files, environment templates, and selected config files
- [x] cache resolved metadata by repository id and commit SHA
- [x] handle malformed content, request cancellation, and rate limits
- [ ] handle bounded known-file fetching and missing-file results

## Milestone 3 - Analysis and Preview Eligibility

**Goal:** Decide whether a repository fits the v0.1 contract without executing it.

- framework and TypeScript detection
- package manager and frozen-install command
- build command and output-directory detection
- environment and external-service blockers
- existing deployment evidence
- monorepo ambiguity detection
- eligibility result with evidence and blockers

Acceptance: fixtures resolve deterministically to `existing-deployment`, `native-static-build`, or `unsupported`.

## Milestone 4 - Preview Control Plane

**Goal:** Create safe, observable, commit-pinned jobs.

- create/status/cancel API
- idempotency and cache lookup
- job queue and lifecycle persistence
- signed, expiring artifact references
- rate limits, per-user/repository quotas, and structured failure codes
- fake-runner integration tests

## Milestone 5 - Isolated Static Runner

**Goal:** Build the first supported repositories without third-party IDEs.

- fresh sandbox per job
- archive download at exact commit SHA
- repository size and file-count limits
- deterministic install with registry-only egress
- bounded build command and output validation
- static artifact publication
- workspace destruction and orphan cleanup

Start with two golden paths:

1. static HTML repository,
2. root-level Vite React repository.

Add Vue and Svelte only after the same contract and security tests pass.

## Milestone 6 - Native Side-Panel Preview

**Goal:** Complete the user-facing Peephole flow.

- add Chrome Side Panel entrypoint
- show analysis, eligibility, progress, and errors
- start and cancel preview jobs
- embed only trusted Peephole preview-origin URLs
- detach stale jobs on GitHub navigation

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
