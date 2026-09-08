# Implementation Checklist

This checklist tracks the native Peephole v0.1 path. Checked items reflect the current extension-shell implementation.

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
- [x] Embed only approved Peephole preview-origin URLs (loopback-only
      allowlist: `isTrustedPreviewArtifactUrl` plus a manifest
      `frame-src` CSP restricted to `http://127.0.0.1:*`/`http://[::1]:*`;
      no production preview domain exists yet, so nothing else is approved)
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
      and authentication adapters (`services/local-preview/devServer.ts`
      composes the persistent Postgres job/queue/cache/quota adapters),
      replacing the previous fixed dev identity with real, two-step
      authentication:
      1. `POST /v1/auth/session` verifies the caller's GitHub personal
         access token against GitHub's own `/user` API
         (`GitHubRequesterAuth`) and exchanges it for a short-lived,
         HMAC-signed Peephole session token (`PreviewSessionIssuer`).
      2. Every other route verifies that session token instead
         (`PreviewSessionAuth`), never the raw GitHub credential again.

      The credential is deliberately sent only once, at login: a
      compromised Preview API then only ever sees Peephole-scoped
      session tokens that expire on their own and are useless anywhere
      else, never the caller's actual GitHub credential repeated on
      every poll. Verified end to end against a real running server with
      a real GitHub token: no/invalid token rejected at login with a
      clear message, a valid token exchanged for a session, that session
      accepted by a real job route, and -- critically -- the raw GitHub
      token rejected when presented directly to a job route instead of a
      session. See `services/preview-api/previewSession.ts`,
      `services/preview-api/previewSessionAuth.ts`,
      `services/preview-api/githubRequesterAuth.ts`, and their test
      files. Reusing an existing GitHub token (rather than a dedicated
      OAuth App + login UI) for the *credential-acquisition* step was a
      deliberate scope choice, not an oversight -- see
      `GitHubRequesterAuth`'s doc comment. Swapping that acquisition
      method later (e.g. a GitHub App + PKCE flow) would not require
      touching the session layer or the `github:<id>` identity model at
      all.

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
      and now run against a real gVisor host (`runsc`, WSL2 Ubuntu; see
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
- [x] gVisor sandbox: kill a runaway write early instead of only catching
      it after the command finishes. Found via a real adversarial test
      that there was previously no live bound at all -- an ordinary
      `npm ci`-style script wrote 500MB inside `RunscCommandRunner`
      without any resistance (`root.path` is a real host directory, not
      a size-bounded mount). `RunscCommandRunner` now polls the
      workspace's on-disk size (default every 1s) while a command runs
      and kills the container the moment it's exceeded
      (`tests/gvisorAdapter.test.ts`, "kills a container early"). **This
      is best-effort, not a hard quota**: it's a userspace poll on a
      timer, so a fast enough writer overshoots by whatever it can write
      in one poll window -- confirmed on a real gVisor host, a 20MB limit
      let ~330MB through before the kill landed. A real hard bound needs
      a loop-mounted, quota-enforcing filesystem for `/workspace`
      (kernel-level ENOSPC, no polling delay) instead of a plain host
      directory -- not attempted here; tracked as a follow-up, not done.
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
      full container platform). `SubnetAllocator` gives every job a
      non-conflicting /30 out of a dedicated `10.200.0.0/16` pool via a
      file-lease-based IPAM, so concurrent jobs don't collide -- verified
      concurrently and end to end (real `npm ci` reaching the real npm
      registry) in `tests/realGvisorSandbox.test.ts` and
      `tests/realGvisorGoldenPath.test.ts`. **Not done**: restricting
      egress to *only* the npm registry -- its IPs (Fastly-fronted)
      aren't stable enough to allowlist directly, so install-phase egress
      is full outbound internet minus the block below, not
      registry-only.
- [x] Block cloud metadata and the rest of link-local (169.254.0.0/16,
      which covers 169.254.169.254 on every major cloud) via an `iptables
      -I FORWARD` DROP rule evaluated before the NAT ACCEPT rules --
      verified in `tests/realGvisorSandbox.test.ts` ("blocks the cloud
      metadata address"). **Not done**: blocking the rest of RFC1918
      (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) -- which private ranges
      are safe to block depends on the deployment's own network topology
      (this host's own default route is itself a private address under
      WSL2), so this needs a deployment-specific decision, not a
      one-size-fits-all rule.
- [x] Fixed a real DNS bug found on a real AWS EC2 host (Ubuntu,
      systemd-resolved) that WSL2 never exposed: `/etc/resolv.conf` there
      points at the `127.0.0.53` stub resolver, which systemd-resolved
      only listens on inside the *host's own* default network namespace --
      bind-mounting it verbatim into the sandbox's separate network
      namespace (per the fix above) looks correct but leaves nothing
      listening on that address, so every DNS lookup failed with
      `EAI_AGAIN` even though `network: sandbox` itself worked fine.
      `resolveDnsConfigSource()` (`services/preview-worker/gvisor/dnsConfig.ts`)
      now detects a loopback-only `/etc/resolv.conf` and falls back to
      systemd-resolved's own published uplink file
      (`/run/systemd/resolve/resolv.conf`, the same file Docker reads for
      this), which is threaded through `buildOciRuntimeSpec`'s required
      `dnsConfigSource` field. Environments whose `/etc/resolv.conf`
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
- [x] Publish static artifacts with restrictive headers via
      `LocalArtifactHost` (`services/local-preview/artifactHost.ts`): a
      dedicated loopback HTTP origin per artifact, `cache-control: no-store`,
      `x-content-type-options: nosniff`, a locked-down `permissions-policy`,
      path-traversal/symlink rejection, and 410 once expired -- development-
      only, not the production artifact store
- [x] Prepare the base rootfs image gVisor copies per job:
      `scripts/gvisor/build-base-rootfs.sh` (debootstrap minbase + the
      official Node 24 linux-x64 tarball + ca-certificates); run and
      verified end to end on a real gVisor host. Maintaining it (rebuild
      cadence, security patching) is ongoing, not a one-time task.

## Preview Delivery

- [ ] Provision a registrable preview domain separate from control UI
      (dev-only substitute: a distinct loopback origin/port per artifact)
- [x] Use per-job or equivalent isolated origins (`LocalArtifactHost` binds
      a fresh TCP port -- and therefore a fresh origin -- per artifact;
      loopback-only, not a registrable per-job subdomain)
- [x] Ensure preview requests receive no control-plane cookies or tokens
      (the control plane sets no cookies at all; the extension's API client
      always sends `credentials: "omit"`; the artifact origin's port differs
      from the control-plane API's, so no cookie would be shared even if one
      existed)
- [x] Set restrictive CSP, permissions, MIME, and framing headers
      (`permissions-policy`, `x-content-type-options: nosniff`, MIME types,
      and now a per-response `Content-Security-Policy` -- including
      `frame-ancestors chrome-extension:` -- are set on every artifact
      response in `services/local-preview/artifactHost.ts`)
- [x] Expire artifacts and return a clear expired state (`LocalArtifactHost`
      returns HTTP 410 once `expiresAt` passes; verified in
      `tests/localArtifactHost.test.ts`)
- [x] Delete expired artifact files from disk, not just the in-memory
      origin: `LocalArtifactHost` removes an artifact's directory shortly
      after its tombstone window closes, and a periodic `reap()` (wired
      into `services/local-preview/devServer.ts`'s 60s maintenance loop)
      sweeps any artifact directory left behind by a crash
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
      pipeline, gVisor end to end
- [x] job wall-clock budget and workspace disk-quota enforcement tests
- [x] orphan-sandbox reaper tests (real directories for the dev reaper;
      fake `runsc list` output for the gVisor reaper's unit tests, plus a
      real abandoned-container scenario against an actual gVisor host in
      `tests/realGvisorSandbox.test.ts`)
- [x] PostgreSQL adapter SQL/transaction and durable worker-loop unit tests
- [x] PostgreSQL integration test against local PostgreSQL 18.4, including
      concurrent claiming and expired-lease recovery
- [x] local artifact host tests: per-artifact loopback origin, traversal
      rejection, and expiry (410) (`tests/localArtifactHost.test.ts`)
- [x] side-panel trusted-origin embedding tests: sandboxed iframe for a
      loopback artifact, refusal for a non-loopback origin
      (`tests/PreviewJobPanel.test.tsx`, `tests/previewConfig.test.ts`)
- [x] malicious install/build fixture tests, against a real gVisor host
      (`tests/realGvisorMaliciousScript.test.ts`): can't escape
      `/workspace` through a symlink to `/etc`, can't read `/etc/shadow`,
      can't escalate to root via `su`/`sudo`, gets no default route (and
      can't reach the NAT gateway or another job's network) under
      `network: "none"`. Also directly led to a real fix: an adversarial
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
- [ ] Verify cleanup, cancellation, expiry, and cost limits
- [ ] Verify no stale state across GitHub repository navigation
- [ ] Test unpacked extension from a clean Chrome profile
- [ ] Document supported matrix and known limitations
- [ ] Complete release smoke test
