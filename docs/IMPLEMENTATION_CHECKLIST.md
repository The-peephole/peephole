# Implementation Checklist

This checklist tracks the native Peephole v0.1 path. Checked items reflect the current extension-shell implementation.

## Bootstrap

- [x] Configure WXT, React, and TypeScript
- [x] Configure linting and formatting
- [x] Add unit-test setup
- [x] Produce a Chrome MV3 production build
- [ ] Add Chrome Side Panel entrypoint and permission
- [ ] Document extension-to-preview-API configuration

## GitHub Integration

- [x] Parse `owner/repo` from valid GitHub repository URLs
- [x] Reject reserved and non-repository GitHub pages
- [x] Detect GitHub client-side navigation
- [x] Insert exactly one visible Peephole action
- [x] Remove stale UI outside repository context
- [x] Reset repository state when identity changes
- [x] Avoid unsupported Shadow DOM hosts
- [ ] Open and synchronize the side panel from the user gesture
- [ ] Abort or ignore stale analysis and preview responses

## Extension UI

- [x] Open a functional panel from the Peephole action
- [x] Display owner and repository name
- [x] Display immutable commit identity
- [ ] Display analysis evidence and blockers
- [ ] Display preview eligibility
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
- [ ] Fetch `package.json` and lock files
- [ ] Fetch environment templates and selected config files
- [x] Implement metadata request cancellation and rate-limit handling
- [x] Cache metadata by repository id and commit SHA
- [ ] Cache analysis by repository id, commit SHA, and analyzer version
- [x] Never log credentials or secret-like values

## Analyzer

- [ ] Detect static repositories and Vite React/Vue/Svelte
- [ ] Detect TypeScript
- [ ] Detect package manager and frozen-install command
- [ ] Detect build command and static output directory
- [ ] Detect declared environment variable names
- [ ] Detect external API/backend hints
- [ ] Detect confirmed versus configured deployments
- [ ] Detect monorepo ambiguity and unsupported tooling
- [ ] Return evidence, warnings, and blockers
- [ ] Return a versioned preview-eligibility result

## Preview Control Plane

- [ ] Define shared `RepositoryRef`, `BuildPlan`, and `PreviewJob` schemas
- [ ] Implement create/status/cancel endpoints
- [ ] Validate commit SHA and build plan server-side
- [ ] Add idempotency keys and lifecycle persistence
- [ ] Add queue integration and fake-runner adapter
- [ ] Add artifact signing and expiry
- [ ] Add user/repository/IP quotas and abuse throttling
- [ ] Add structured, non-sensitive error codes
- [ ] Ensure the API process cannot execute build commands

## Isolated Static Runner

- [ ] Select and document the production isolation technology
- [ ] Create a fresh non-root sandbox per job
- [ ] Download only the requested public commit archive
- [ ] Enforce archive size, expanded size, and file-count limits
- [ ] Use frozen dependency installation
- [ ] Restrict install egress to approved registries
- [ ] Block loopback, private, link-local, and metadata networks
- [ ] Enforce CPU, memory, process, disk, output, and wall-time limits
- [ ] Validate output path and prevent traversal/symlink escape
- [ ] Publish static artifacts with restrictive headers
- [ ] Destroy workspaces and reap orphan jobs

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
- [ ] analyzer and eligibility fixture tests
- [ ] preview API state-machine and idempotency tests
- [ ] fake-runner integration tests
- [ ] static HTML and Vite golden-path builds
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
