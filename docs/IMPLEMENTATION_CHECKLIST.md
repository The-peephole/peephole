# Implementation Checklist

This checklist tracks the native Peephole v0.1 path. Checked items reflect the current extension-shell implementation.

## Bootstrap

- [x] Configure WXT, React, and TypeScript
- [x] Configure linting and formatting
- [x] Add unit-test setup
- [x] Produce a Chrome MV3 production build
- [x] Add Chrome Side Panel entrypoint and permission
- [ ] Document extension-to-preview-API configuration

## GitHub Integration

- [x] Parse `owner/repo` from valid GitHub repository URLs
- [x] Reject reserved and non-repository GitHub pages
- [x] Detect GitHub client-side navigation
- [x] Insert exactly one visible Peephole action
- [x] Remove stale UI outside repository context
- [x] Reset repository state when identity changes
- [x] Avoid unsupported Shadow DOM hosts
- [x] Open and synchronize the side panel from the user gesture
- [x] Abort or ignore stale analysis responses
- [ ] Abort or ignore stale preview responses

## Extension UI

- [x] Open a functional panel from the Peephole action
- [x] Display owner and repository name
- [x] Display immutable commit identity
- [x] Display analysis evidence and blockers
- [x] Display preview eligibility
- [ ] Display queued/installing/building/publishing states
- [ ] Add build, cancel, retry, and expiry controls
- [ ] Embed only approved Peephole preview-origin URLs
- [x] Remove the transitional StackBlitz action and URL generator
- [ ] Add keyboard, focus, contrast, and screen-reader checks

## GitHub Data Access

- [x] Create a typed GitHub client
- [x] Route cross-origin GitHub requests through a background service worker
- [x] Validate background message types and repository identity
- [x] Fetch repository id, default branch, and head commit SHA
- [x] Fetch homepage and selected metadata
- [x] Fetch `package.json` and inspect recognized lockfile presence
- [x] Fetch environment templates and selected config files
- [x] Implement metadata request cancellation and rate-limit handling
- [x] Cache metadata by repository id and commit SHA
- [x] Cache analysis by repository id, commit SHA, and analyzer version
- [x] Never log credentials or secret-like values

## Analyzer

- [x] Detect static repositories and Vite React/Vue/Svelte
- [x] Detect TypeScript
- [x] Detect package manager and frozen-install command
- [x] Detect build command and static output directory
- [x] Detect declared environment variable names
- [x] Detect external API/backend hints
- [x] Detect confirmed versus configured deployments
- [x] Detect monorepo ambiguity and unsupported tooling
- [x] Return evidence, warnings, and blockers
- [x] Return a versioned preview-eligibility result

## Preview Control Plane

- [x] Define shared `RepositoryRef`, `BuildPlan`, and `PreviewJob` schemas
- [x] Implement create/status/cancel endpoints
- [x] Validate commit SHA and build plan server-side
- [x] Add idempotency keys and lifecycle persistence
- [x] Add queue integration and fake-runner adapter
- [x] Add artifact signing and expiry
- [x] Add user/repository/IP quotas and abuse throttling
- [x] Add structured, non-sensitive error codes
- [x] Ensure the API process cannot execute build commands

## Isolated Static Runner

- [x] Define the worker's fetch/install/build/publish port contracts
- [x] Drive fetch -> install -> build -> publish through the control-plane
      phase state machine (fake adapters, then real adapters)
- [x] Enforce archive size, expanded size, and file-count limits
- [x] Validate output path and prevent traversal/symlink escape
- [x] Guarantee workspace cleanup on success, failure, and cancellation
- [x] Select and document the production isolation technology (D-018: gVisor)
- [x] Download only the requested public commit archive (real: `GitHubCommitArchiveFetcher`)
- [x] Real archive extraction rejecting traversal/absolute paths/symlinks/device files
- [x] Real npm install/build/output/publish adapters, proven end to end for
      both golden paths against real GitHub archives
- [x] `GVisorSandboxProvisioner`/`RunscCommandRunner` written (OCI bundle,
      non-root uid/gid, CPU/memory/PID quotas, cancellation-safe cleanup) --
      **not run against a real gVisor host**; verified only via a fake
      process runner (no Linux kernel in this environment)
- [x] Enforce a real, active job wall-clock budget: every install/build
      command's timeout is clamped to the job's remaining time
      (`services/preview-worker/local/jobDeadline.ts`), so
      `HostCommandRunner`/`RunscCommandRunner` actually kill the running
      process once the total job timeout is exceeded, not just mark the job
      failed after the fact
- [x] Enforce a real workspace disk-usage quota: `directorySizeExceeds`
      checks the workspace tree after install and after build, independent
      of the source archive/output size checks (catches a build that
      writes far more to disk than either bound would show)
- [x] Reap orphan jobs: `LocalDevSandboxReaper` (real, tested against real
      temp directories) and `GVisorOrphanReaper` (written against `runsc
      list --format json`, cross-referencing bundle age; **unverified
      against a real runsc binary** -- see below)
- [ ] Create a fresh non-root sandbox per job on a **real** gVisor host
- [ ] Use frozen dependency installation with registry-only egress (network
      policy selection exists in the `runsc` CLI wiring; host-side
      firewall/veth enforcement does not)
- [ ] Block loopback, private, link-local, and metadata networks
- [ ] Enforce CPU, memory, and PID limits **on a real gVisor host** (limits
      are wired into the OCI config; unverified)
- [ ] Publish static artifacts with restrictive headers (local-fs stand-in
      only, no HTTP serving layer yet)
- [ ] Prepare and maintain the base rootfs image gVisor copies per job

## Preview Delivery

- [ ] Provision a registrable preview domain separate from control UI
- [ ] Use per-job or equivalent isolated origins
- [ ] Ensure preview requests receive no control-plane cookies or tokens
- [ ] Set restrictive CSP, permissions, MIME, and framing headers
- [ ] Expire artifacts and return a clear expired state
- [ ] Prevent preview content from reaching privileged extension messaging

## Tests

- [x] GitHub URL parser unit tests
- [x] GitHub action insertion and reconciliation tests
- [x] client-side navigation tests
- [x] analyzer and eligibility fixture tests
- [x] preview API state-machine and idempotency tests
- [x] fake-runner integration tests
- [x] preview worker fetch/install/build/publish contract tests (fake adapters)
- [x] archive and output policy unit tests (size, file-count, path safety)
- [x] static HTML and Vite golden-path builds (real network + real npm/vite,
      gated behind `PEEPHOLE_REAL_NETWORK_TESTS=1`; unsandboxed development
      proof, not run through gVisor)
- [x] gVisor OCI/`runsc` CLI wiring tests (fake process runner; real runsc untested)
- [x] job wall-clock budget and workspace disk-quota enforcement tests
- [x] orphan-sandbox reaper tests (real directories for the dev reaper,
      fake `runsc list` output for the gVisor reaper)
- [ ] malicious install/build fixture tests
- [ ] resource and network isolation tests
- [ ] artifact path and origin isolation tests
- [ ] end-to-end Chrome side-panel test

## Before v0.1

- [x] Remove all StackBlitz product paths
- [ ] Pass supported and unsupported fixture matrix
- [ ] Complete external isolation/security review
- [ ] Verify cleanup, cancellation, expiry, and cost limits
- [ ] Verify no stale state across GitHub repository navigation
- [ ] Test unpacked extension from a clean Chrome profile
- [ ] Document supported matrix and known limitations
- [ ] Complete release smoke test
