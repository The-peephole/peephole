# Implementation Checklist

This checklist tracks the native Peephole v0.1 path. Checked items reflect the
current implementation or a recorded real production verification.

## Bootstrap

- [x] Configure WXT, React, and TypeScript
- [x] Configure linting and formatting
- [x] Add unit-test setup
- [x] Produce a Chrome MV3 production build
- [x] Add Chrome Side Panel entrypoint and permission
- [x] Document extension-to-preview-API configuration

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
- [x] Abort or ignore stale preview responses

## Extension UI

- [x] Open a functional panel from the Peephole action
- [x] Display owner and repository name
- [x] Display immutable commit identity
- [x] Display analysis evidence and blockers
- [x] Display preview eligibility
- [x] Display queued/fetching/installing/building/publishing states
- [x] Add build, cancel, retry, and expiry controls
- [x] Embed only approved Peephole preview-origin URLs: loopback HTTP for local
      development or HTTPS on one valid artifact-id subdomain of the configured
      production artifact base domain; the manifest `frame-src` and runtime URL
      validator enforce the same boundary
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
- [x] Expose the control-plane contract through a bounded Node HTTP ingress
- [x] Add liveness, dependency readiness, request timeouts, and graceful shutdown
- [x] Add a PostgreSQL schema and persistent job/artifact-cache/quota adapters
- [x] Add a PostgreSQL leased queue with expired-lease recovery
- [x] Revalidate repository identity, commit, and build plan server-side
- [x] Compose the API with production-persistent job, queue, cache, quota,
      and authentication adapters in `services/production/server.ts`, replacing
      the previous fixed dev identity with GitHub App identity:
      1. `GET /v1/auth/github/start` validates a server-side allowlisted
         Chrome Extension callback and creates HMAC-signed state binding the
         callback, extension nonce, and PKCE challenge.
      2. `GET /v1/auth/github/callback` validates state and returns the
         one-time GitHub code to the originating extension callback.
      3. `POST /v1/auth/session` validates state and PKCE, exchanges the code
         using the server-only GitHub App Client Secret, resolves `/user`,
         discards the GitHub credential, and issues the existing short-lived,
         HMAC-signed Peephole session (`PreviewSessionIssuer`).
      4. Every preview route verifies that session (`PreviewSessionAuth`) and
         keeps requester identity in the `github:<id>` form.

      The extension stores only the Peephole access session in
      `browser.storage.session`; it removes the legacy PAT value and exposes
      Connect/Disconnect/reconnect UI. Current expiry UX reconnects through
      GitHub. A refreshable Peephole authentication credential remains a
      documented, separable follow-up requiring server-side hashed token
      storage, rotation, revocation, and reuse detection. See
      `services/preview-api/githubAppOAuth.ts`,
      `services/preview-api/previewSession.ts`,
      `services/preview-api/previewSessionAuth.ts`, and
      `docs/GITHUB_APP_AUTH.md`.

- [x] Verify the production GitHub App and preview path end to end
      (2026-09-09):
      - GitHub App OAuth
      - PKCE S256
      - HMAC-signed state
      - allowlisted `chromiumapp.org` redirect
      - GitHub identity and Peephole session issuance
      - authenticated gVisor preview build
      - HTTPS artifact publication and SidePanel embedding

      This is a real production E2E result rather than only automated or local
      coverage. Refresh sessions and private-repository Installation Access
      Tokens remain separate follow-up scopes; see `docs/GITHUB_APP_AUTH.md`.

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
      non-root uid/gid, CPU/memory/PID quotas, cancellation-safe cleanup)
      and now run against real gVisor hosts, including AWS EC2 Ubuntu (see
      `tests/realGvisorSandbox.test.ts`). This surfaced and fixed five real
      bugs invisible to the fake-process-runner unit tests: `fs.cp`
      couldn't copy the base image's `/dev` (ENODEV); `fs.cp` silently
      rewrote relative symlinks (npm, npx, corepack) to absolute paths
      pointing at the shared base image instead of the per-job copy;
      `runsc`'s default root overlay (`root:self`) discarded every write
      once its container exited, so a later container could never see an
      earlier one's output; the copied workspace/home directories were
      owned by whatever uid ran the copy, not the sandboxed uid, so the
      sandboxed process couldn't write into its own workspace or npm
      cache; and the container's `/etc/resolv.conf` was never mounted, so
      any DNS lookup failed outright. All fixed in
      `gvisorSandboxProvisioner.ts`, `runscCli.ts`, `runscCommandRunner.ts`,
      and `ociConfig.ts`.
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
- [x] Add a non-bypassable workspace hard cap: each job gets a preallocated,
      fixed-size loop-backed ext4 image mounted at `/workspace`; HOME/npm
      cache are inside it, and the copied OCI rootfs is read-only. gVisor
      enforces byte capacities for `/tmp` (64 MiB) and the separate `/dev/shm`
      mount (16 MiB); `/dev` root is not writable by uid 65534. The verified
      gVisor version ignores tmpfs inode hints, so memory-cgroup and wall-clock
      limits bound metadata pressure instead. Allocation reserves
      rootfs/archive/artifact exposure, and startup synchronously reconciles
      strictly marker-owned mount/loop resources before workers. The complete
      real AWS suite passes 15/15; see `docs/SANDBOX_DISK_SECURITY.md`.
- [x] Reap orphan jobs: `LocalDevSandboxReaper` (real, tested against real
      temp directories) and `GVisorOrphanReaper` (cross-references stale
      bundle directories against `runsc list --format json`) -- both now
      verified against a real gVisor host: `runsc list`'s actual JSON
      output does follow the assumed `{id, bundle, ...}` shape, and
      `reap()` correctly finds, kills, and deletes a container abandoned
      mid-run (simulating a worker crash) and removes its bundle
      directory (`tests/realGvisorSandbox.test.ts`, "reaps a container
      abandoned mid-run")
- [x] Connect the durable queue to the worker contract with lease,
      acknowledgement, delayed retry, and abortable polling
- [x] Renew (heartbeat) the queue lease while a job is running, fence
      stale/recovered attempts via an `attempts` counter on
      acknowledge/release/renew, and abandon a job past `maxAttempts`
      instead of retrying it forever
      (`services/preview-worker/workerLoop.ts`,
      `services/preview-api/postgres/queue.ts`)
- [x] Make job creation and initial queue admission atomic (a single
      PostgreSQL transaction), so an API crash between the two cannot
      strand a `queued` job that the queue never sees
      (`services/preview-api/postgres/jobStore.ts`)
- [x] Create a fresh non-root sandbox per job on a **real** gVisor host --
      verified: `id -u` inside the sandbox reports 65534, and files it
      writes are owned by uid/gid 65534 on the host
      (`tests/realGvisorSandbox.test.ts`)
- [x] Give the sandbox real network egress: `VethNatNetworkProvisioner`
      (`services/preview-worker/gvisor/networkNamespace.ts`) replicates
      what `runsc do` does internally -- a veth pair, one end moved into a
      fresh namespace the OCI spec joins via its `path`, addressed as a
      /30, NAT'd through the host's discovered default interface --
      because a bare `runsc run --network=sandbox` never brings its own
      interface up on its own (a CNI plugin normally does this under a
      full container platform). `NetworkLeaseManager` gives every job a
      non-conflicting /30 out of a dedicated `10.200.0.0/16` pool via a
      file-lease-based IPAM, so concurrent jobs don't collide -- verified
      concurrently and end to end (real `npm ci` reaching the real npm
      registry) in `tests/realGvisorSandbox.test.ts` and
      `tests/realGvisorGoldenPath.test.ts`. **Not done**: restricting
      egress to *only* the npm registry -- its IPs (Fastly-fronted)
      aren't stable enough to allowlist directly, so install-phase egress
      is full outbound internet minus the block below, not
      registry-only.
- [x] Install-stage egress now blocks loopback, link-local/cloud metadata,
      RFC 1918, shared CGNAT, the `10.200.0.0/16` inter-job pool, and other
      non-public/special-purpose IPv4 destinations in per-veth chains.
      Exact configured resolver addresses receive only UDP/TCP 53 exceptions
      before those drops, so an AWS VPC or link-local Route 53 resolver keeps
      working without exposing its other ports. A separate INPUT chain blocks
      host services, the reverse FORWARD chain accepts only
      `ESTABLISHED,RELATED`, and IPv6 INPUT/FORWARD is denied completely.
      All mandatory rules precede NAT and any failure aborts setup. Full policy,
      packet-flow reasoning, verification, and limitations are documented in
      `docs/SANDBOX_NETWORK_SECURITY.md` and tested in
      `tests/networkNamespace.test.ts` / `tests/realGvisorSandbox.test.ts`.
- [x] Make network ownership and crash recovery durable. The subnet slot is
      now published transactionally with a complete, fsynced marker before
      any netns/veth/iptables/NAT operation. `NetworkOrphanReaper` runs as a
      synchronous production startup gate after runsc/disk reconciliation,
      verifies marker-derived identity and host state, rejects unowned
      Peephole-shaped resources, and releases a lease only after a second
      inspection proves every owned resource absent. Normal teardown shares
      the same verified path and propagates partial-cleanup failures. Unit
      coverage includes partial setup, corrupt/symlinked leases, live owners,
      unowned resources, command/verification failure, temporary transaction
      recovery, and concurrent IPAM; the opt-in real suite includes an
      intentionally abandoned full network allocation.
- [x] Fixed a real DNS bug found on a real AWS EC2 host (Ubuntu,
      systemd-resolved) that WSL2 never exposed: `/etc/resolv.conf` there
      points at the `127.0.0.53` stub resolver, which systemd-resolved
      only listens on inside the *host's own* default network namespace --
      bind-mounting it verbatim into the sandbox's separate network
      namespace (per the fix above) looks correct but leaves nothing
      listening on that address, so every DNS lookup failed with
      `EAI_AGAIN` even though `network: sandbox` itself worked fine.
      `resolveDnsConfig()` (`services/preview-worker/gvisor/dnsConfig.ts`)
      now detects a loopback-only `/etc/resolv.conf` and falls back to
      systemd-resolved's own published uplink file
      (`/run/systemd/resolve/resolv.conf`, the same file Docker reads for
      this), which is threaded through `buildOciRuntimeSpec`'s required
      `dnsConfigSource` field while its exact IPv4 nameservers configure the
      DNS-only firewall exceptions. Environments whose `/etc/resolv.conf`
      already has a real, non-loopback nameserver (WSL2's own
      `10.255.255.254`) are left exactly as before -- verified by a real
      regression run on WSL2 (`tests/realGvisorSandbox.test.ts`'s
      "resolves a real, non-loopback DNS config source on this host") on
      top of unit coverage in `tests/dnsConfig.test.ts`.
- [x] Host prerequisite found while re-verifying the DNS fix on WSL2:
      `net.ipv4.ip_forward` must be `1` for `network: sandbox` to reach
      anything at all -- with it `0` (WSL2 resets this on every VM
      restart; some minimal cloud images ship it disabled too), the host
      kernel drops forwarded packets before they ever reach the
      `iptables` FORWARD/NAT rules `VethNatNetworkProvisioner` sets up, so
      every sandboxed connection attempt times out with no indication
      anything is misconfigured. Not currently set by the code itself
      (same category of prerequisite as having `runsc`/`ip`/`iptables`
      installed) -- confirm with `sysctl net.ipv4.ip_forward` (or
      `cat /proc/sys/net/ipv4/ip_forward`) before trusting a
      `network: sandbox` failure as a real bug.
- [x] Enforce PID limits **on a real gVisor host** -- verified: a
      sandboxed fork bomb against a 16-PID limit fails
      (`tests/realGvisorSandbox.test.ts`)
- [x] Enforce CPU limits **on a real gVisor host** -- verified: a fixed
      CPU-bound workload (repeated SHA-256) takes more than twice as long
      in wall-clock time under a 0.1-core quota as under a 4-core quota
      (`tests/realGvisorSandbox.test.ts`, "throttles CPU usage")
- [x] Enforce memory limits **on a real gVisor host** -- verified, but
      only after finding and fixing a real gap: the OCI spec set
      `memory.limit` but not `memory.swap`, so a process that hit the
      memory ceiling was pushed into swap by the kernel's reclaim path
      instead of OOM-killed (confirmed by polling the cgroup live:
      `memory.current` held right at the configured limit while
      `memory.events`' `max` counter climbed into the thousands, and the
      sandboxed process kept allocating well past the intended cap
      because swap was available). Setting `swap` equal to `limit`
      (`services/preview-worker/gvisor/ociConfig.ts`) closes that
      headroom; a 200MB allocation against a 64MB limit now gets killed
      (`tests/realGvisorSandbox.test.ts`, "enforces the configured memory
      limit").
- [x] Publish static artifacts with restrictive headers via both
      `LocalArtifactHost` for development and `ProductionArtifactHost` for the
      deployed path. Production authorization/expiry is persisted in
      PostgreSQL and each artifact is routed by its isolated HTTPS hostname.
- [x] Prepare the base rootfs image gVisor copies per job:
      `scripts/gvisor/build-base-rootfs.sh` (debootstrap minbase + the
      official Node 24 linux-x64 tarball + ca-certificates); run and
      verified end to end on a real gVisor host. Maintaining it (rebuild
      cadence, security patching) is ongoing, not a one-time task.

## Preview Delivery

- [x] Provision and verify a public HTTPS artifact domain separate from the
      Preview API/control plane, routed through Caddy to the loopback production
      artifact host
- [x] Use isolated artifact-id hostnames in production and a distinct loopback
      origin/port per artifact in local development
- [x] Ensure preview requests receive no control-plane cookies or tokens
      (the control plane sets no cookies at all; the extension's API client
      always sends `credentials: "omit"`; production artifacts use a separate
      registrable domain, while the local artifact origin uses a different
      port)
- [x] Set restrictive CSP, permissions, MIME, and framing headers in both local
      and production artifact hosts, including extension-only/trusted-origin
      framing and no cross-origin readable CORS response
- [x] Expire artifacts and return HTTP 410 for persisted expired production
      metadata as well as local-development expiry
- [x] Delete expired artifact metadata and files through serialized production
      reaping; retain local crash/expiry reaping for development
- [ ] Prevent preview content from reaching privileged extension messaging

## Production Deployment

- [x] Real production launcher (`services/production/server.ts`), separate
      from `services/local-preview/devServer.ts` -- devServer.ts's own
      behavior is untouched; the two entrypoints share the Preview
      API/PostgreSQL control-plane wiring (`composePostgresControlPlane`,
      session auth) but nothing about how a job actually runs.
      `services/preview-worker/gvisor/composeProductionWorker.ts` wires the
      real, non-fake pipeline: `GVisorSandboxProvisioner` +
      `RunscCommandRunner` (install with `network: "sandbox"`, build with
      `network: "none"`, matching the split already verified end to end in
      tests/realGvisorGoldenPath.test.ts) in place of
      `composeLocalDevWorker`'s unsandboxed `LocalDevSandboxProvisioner`/
      `HostCommandRunner`, plus `GVisorOrphanReaper` in place of
      `LocalDevSandboxReaper` for crash recovery. Verified with a
      composition test
      (`tests/productionWorkerComposition.test.ts`) that runs a full
      fetch -> extract -> install -> build -> publish job through the real
      classes with a fake `runsc`/`ip`/`iptables` process runner (the real
      end-to-end proof against actual `runsc` is the existing
      tests/realGvisorSandbox.test.ts /
      tests/realGvisorGoldenPath.test.ts suites, re-run unchanged after this
      work to confirm nothing regressed).
- [x] Startup preflight (`services/production/preflight.ts`,
      `ensureProductionPreflight`) checks every host prerequisite gVisor
      sandboxing/networking silently assumed until this project found each
      one the hard way on a real host: `runsc`/`ip`/`iptables`/`ip6tables`
      present and runnable, cgroup v2's unified hierarchy
      (`/sys/fs/cgroup/cgroup.controllers`), `net.ipv4.ip_forward=1`, a
      populated base rootfs image, and a DNS config source that actually
      resolves to a usable (non-loopback) nameserver (reusing
      `resolveDnsConfigSource()`/`hasUsableNameserver()` from
      `dnsConfig.ts`). All failures are collected and thrown as one clear
      error rather than failing one at a time inside a job hours later.
      Verified with injected fakes (`tests/productionPreflight.test.ts`), on
      WSL2 where it correctly detected a reset `net.ipv4.ip_forward=0`, and in
      the successful AWS EC2 production startup path.
- [x] Worker concurrency is configurable
      (`PEEPHOLE_WORKER_CONCURRENCY`, `services/production/config.ts`),
      defaulting to 1 -- the current AWS EC2 deployment target is 2 vCPU /
      2GB RAM, which one CPU/memory-quota'd sandbox can already consume
      most of. `services/production/server.ts` runs that many
      `PreviewWorkerLoop` instances against the same queue, sharing one
      shutdown signal.
- [x] `PEEPHOLE_SESSION_SIGNING_SECRET` is required (not auto-generated) in
      the production launcher -- unlike devServer.ts's dev-only random
      fallback, an unset or per-process-random secret in production would
      either sign every user out on every restart or, worse, differ across
      a multi-process deployment.
- [x] Run the production launcher as the `peephole` systemd service on AWS EC2
      Ubuntu with worker concurrency 1; Caddy fronts the loopback Preview API
      and production artifact host and consults the loopback TLS ask listener
- [x] Verify the public Chrome Extension -> GitHub App -> production API ->
      PostgreSQL queue -> real gVisor worker -> HTTPS artifact -> Side Panel
      path end to end
- [x] Roll the cache namespace to `runnerVersion: "production-2"`; replaying a
      commit cached by `production-1` produced `cache_status=miss`, then a
      successful ready preview
- [x] Kill `peephole.service` with `SIGKILL` during install and verify systemd
      restart, health/readiness recovery, queue-lease recovery, safe
      `failed / RUNNER_UNAVAILABLE` terminalization, and zero final runsc,
      network, mount, loop, lease, or job-file residue

## Tests

- [x] Current non-destructive validation: 583 tests passed, 31
      environment-gated tests skipped; typecheck, lint, build, format-check,
      and `git diff --check` passed
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
- [x] gVisor OCI/`runsc` CLI wiring tests (fake process runner,
      `tests/gvisorAdapter.test.ts`), veth/NAT command-sequence and IPAM
      tests (fake process runner, `tests/networkNamespace.test.ts`,
      `tests/subnetAllocator.test.ts`), plus real-`runsc` sandbox tests
      (`tests/realGvisorSandbox.test.ts`, gated on
      `PEEPHOLE_REAL_GVISOR_TESTS`): non-root uid/gid, cross-container
      disk persistence, PID/CPU/memory-limit enforcement, real network
      egress, metadata blocking, and concurrent-job network isolation,
      all against an actual gVisor host -- plus a full sandboxed golden-path
      test (`tests/realGvisorGoldenPath.test.ts`, same gate): real `npm
      ci` + `npm run build` through the actual `PreviewJobWorker`
      pipeline, gVisor end to end. The latest AWS verification passed 15/15
      sandbox tests and 1/1 golden-path test
- [x] job wall-clock budget and portable workspace disk-quota enforcement tests
- [x] orphan-sandbox reaper tests (real directories for the dev reaper;
      fake `runsc list` output for the gVisor reaper's unit tests, plus a
      real abandoned-container scenario against an actual gVisor host in
      `tests/realGvisorSandbox.test.ts`)
- [x] PostgreSQL adapter SQL/transaction and durable worker-loop unit tests
- [x] PostgreSQL integration test against local PostgreSQL 18.4, including
      concurrent claiming and expired-lease recovery
- [x] local artifact host tests: per-artifact loopback origin, traversal
      rejection, and expiry (410) (`tests/localArtifactHost.test.ts`)
- [x] side-panel trusted-origin embedding tests: sandboxed iframe for local
      loopback and exact production artifact origins, refusal for unapproved
      origins
      (`tests/PreviewJobPanel.test.tsx`, `tests/previewConfig.test.ts`)
- [ ] Run the dedicated malicious install/build fixture suite on the
      production-like AWS gVisor host
      (`tests/realGvisorMaliciousScript.test.ts`): it checks that scripts can't escape
      `/workspace` through a symlink to `/etc`, can't read `/etc/shadow`,
      can't escalate to root via `su`/`sudo`, gets no default route (and
      can't reach the NAT gateway or another job's network) under
      `network: "none"`. Earlier development of this suite directly led to a
      real fix: an adversarial
      disk-fill script found there was no live disk-usage bound at all
      (see "Enforce a real workspace disk-usage quota" above) --
      confirming this kind of testing is worth doing, not just a
      checkbox.
- [x] resource and network isolation tests -- PID/CPU/memory limits and
      metadata/link-local blocking verified against a real gVisor host
      (`tests/realGvisorSandbox.test.ts`); concurrent jobs confirmed to
      get independent, non-interfering networks (same file, "gives
      concurrent jobs independent, non-conflicting networks"). **Not
      done**: two concurrent jobs *competing* for the same host's overall
      CPU/memory/disk (each job's own cgroup limits are enforced
      independently and verified, but nothing here tests host-wide
      capacity planning under concurrent load).
- [x] artifact path and origin isolation tests
      (`tests/localArtifactHost.test.ts`): two artifacts get distinct
      loopback origins (ports), and one artifact's server never resolves
      another artifact's id as a path (direct or via traversal). Found
      and fixed a real gap while writing these: every artifact response
      sent `Access-Control-Allow-Origin: *` and
      `Cross-Origin-Resource-Policy: cross-origin` -- neither is needed
      (the extension only ever navigates an iframe to the artifact's
      URL, which was never gated by CORS/CORP) and both defeat the
      isolated-origin-per-artifact design this host exists for: any
      ordinary website open in another tab could have port-scanned
      127.0.0.1, found a live preview, and read its contents via
      `fetch()` -- a known attack class against permissive local dev
      servers. Removed the CORS header entirely and tightened CORP to
      `same-origin` (`services/local-preview/artifactHost.ts`).
- [x] end-to-end Chrome side-panel test (manual only, no automated
      end-to-end test exists yet): an unpacked build of the extension, a
      real GitHub repository, `Build preview` clicked in the real side
      panel, through to a real Vite + React build rendered in the embedded
      iframe. Caught and fixed a real bug this way --
      `PreviewApiClient` stored `options.fetch ?? globalThis.fetch`
      unbound, so calling it as `this.fetch(...)` tripped Chrome's native
      `fetch` receiver check (`TypeError: Illegal invocation`), silently
      swallowed into a generic "could not be reached" error with no
      network request ever sent and no console output -- every existing
      unit test injected a plain mock and never exercised the real
      receiver. Fixed in `core/preview/apiClient.ts` and covered by a
      receiver-checking regression test in `tests/previewApiClient.test.ts`.

## Before v0.1

- [x] Remove all StackBlitz product paths
- [ ] Pass supported and unsupported fixture matrix
- [ ] Complete external isolation/security review
- [x] Verify cleanup, cancellation, expiry, and cost/resource limits
- [x] Verify no stale state across GitHub repository navigation
- [ ] Test unpacked extension from a clean Chrome profile
- [ ] Document supported matrix and known limitations
- [ ] Complete release smoke test

## Remaining Work

- [ ] Complete keyboard, focus, contrast, and screen-reader accessibility checks
- [ ] Add production-grade metrics, centralized log aggregation, and alerts
- [ ] Automate production deployment smoke and release checks
- [ ] Replace broad public install egress with an authenticated package proxy
      or equivalently constrained package-egress service
- [ ] Prepare the Chrome Web Store submission and v0.1 release

Refreshable Peephole sessions and private-repository Installation Access Tokens
remain post-v0.1 scopes; private repository support is not a v0.1 completion
condition. On Linux, `tests/sandboxDisk.test.ts` performs real `chown` calls and
must run with sufficient privilege: the recorded root run passed 18/18. An
unprivileged EPERM result is a test-execution prerequisite failure, not a product
regression.
