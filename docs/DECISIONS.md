# Technical Decisions

This document records decisions that constrain implementation. Superseded entries remain for context.

## D-001 - Extension framework: WXT

**Status:** Accepted

Use WXT with React, TypeScript, and Manifest V3 for extension entrypoints and builds.

## D-002 - v0.1 is an analyzer/router, not a runtime

**Status:** Superseded by D-011

The original plan routed unsupported repositories to StackBlitz. The product direction now requires a Peephole-owned preview for a limited compatibility set.

## D-003 - No repository execution in extension context

**Status:** Accepted

Repository source and dependency scripts must never execute in content scripts, extension pages, background workers, or the preview control API process.

## D-004 - Minimal repository fetch for analysis

**Status:** Accepted

Initial analysis fetches only known metadata and small text files. A full commit archive is downloaded only by an isolated runner after explicit user action.

## D-005 - Evidence-based status

**Status:** Accepted

Distinguish confirmed deployments, configuration evidence, inferred compatibility, and unknown states. Every eligibility result includes evidence and blockers.

## D-006 - No numeric previewability score in v0.1

**Status:** Accepted

Use concrete facts and blockers rather than an unexplained number.

## D-007 - Existing deployments may open in a new tab

**Status:** Accepted

Many deployments prohibit framing. Peephole may show a confirmed deployment in-panel only when policy allows; otherwise it opens in a new tab.

## D-008 - StackBlitz as fallback

**Status:** Superseded by D-012

The first extension shell used StackBlitz as a temporary demonstrator. It is not part of the target architecture or v0.1 definition of done.

## D-009 - GitHub SPA navigation is P0

**Status:** Accepted

Repository identity, action insertion, panel state, and preview-job attachment must remain correct across client-side navigation.

## D-010 - Detector functions are pure where possible

**Status:** Accepted

Data fetching, parsing, evidence detection, and eligibility resolution remain separate and independently testable.

## D-011 - Peephole owns the supported preview experience

**Status:** Accepted

v0.1 builds and serves supported static frontend repositories through Peephole-controlled infrastructure. This is a compatibility contract, not a promise to run arbitrary repositories.

## D-012 - No StackBlitz dependency in the target flow

**Status:** Accepted

Unsupported repositories show evidence and blockers. They are not silently handed to StackBlitz or another online IDE.

## D-013 - Execution plane is isolated from extension and control plane

**Status:** Accepted

Untrusted builds run asynchronously in disposable, restricted workers. The API only validates, schedules, and reports jobs.

## D-014 - Static-build-first v0.1 contract

**Status:** Accepted

v0.1 supports static repositories and root-level Vite React/Vue/Svelte applications that build without secrets. Persistent SSR, backends, Docker, and ambiguous monorepos are deferred.

## D-015 - Every preview is pinned to a commit SHA

**Status:** Accepted

Analysis, jobs, cache entries, displayed identity, and artifacts reference an immutable commit SHA. A moving branch is resolved before work starts.

## D-016 - Untrusted previews use a separate registrable domain

**Status:** Accepted

Preview artifacts must not share a cookie or origin boundary with the control UI. Prefer per-job origins under a domain such as `peephole.run`.

## D-017 - Chrome Side Panel is the primary full-preview surface

**Status:** Accepted

GitHub DOM receives only a compact action. Analysis, progress, and previews live in a stable side panel, avoiding fragile large DOM injection and GitHub page CSP constraints.

## D-018 - gVisor (`runsc`) is the v0.1 sandbox boundary; Firecracker deferred

**Status:** Accepted

Use a gVisor (`runsc`)-backed OCI container as the isolation boundary for
install/build execution, targeting Linux x86_64. gVisor intercepts syscalls
in userspace and does not require nested virtualization or a
Firecracker-style microVM host, which keeps the deployment target closer to
an ordinary container host while still giving untrusted repository builds a
real kernel boundary instead of a bare process.

Firecracker is excluded from v0.1 scope, not rejected outright: it needs
KVM/nested-virtualization support on the host and a jailer/VM-image
pipeline that is a larger operational lift than one team should take on
alongside the rest of the v0.1 surface. Revisit if gVisor's syscall
emulation proves insufficient for a supported framework (performance or
compatibility), or if the deployment target moves to bare metal/KVM-capable
hosts where Firecracker's stronger boundary is worth the added ops cost.

Nothing about the worker/adapter contracts (`SandboxProvisioner`,
`CommandRunner`) assumes gVisor specifically -- see D-019.

## D-019 - The runner depends on a `SandboxProvisioner`/`CommandRunner` port, never a specific sandbox technology

**Status:** Accepted

`PreviewJobWorker` and the npm install/build adapters only see
`SandboxProvisioner` (allocate/destroy a workspace) and `CommandRunner` (run
a command against that workspace) -- both defined in
`services/preview-worker/ports.ts` and
`services/preview-worker/local/commandRunner.ts`. Swapping the concrete
implementation (`LocalDevSandboxProvisioner`/`HostCommandRunner` for
development, `GVisorSandboxProvisioner`/`RunscCommandRunner` for gVisor)
changes nothing else in the pipeline.

This is not speculative future-proofing: it is what let Milestone 5 prove
the fetch -> extract -> install -> build -> publish pipeline for real in a
Windows development environment with no Linux kernel at all, while writing
the actual gVisor adapter as real (if locally unverified) code against the
same contract. If gVisor is later replaced or supplemented (e.g. by
Firecracker per D-018's revisit condition), only a new pair of adapters is
required.

## D-020 - Initial runner resource and timeout limits

**Status:** Accepted

Central config (`core/runner/runnerLimits.ts`, `core/runner/archivePolicy.ts`):

| Limit | Value |
| --- | --- |
| CPU | 1 vCPU |
| Memory | 1 GiB |
| PIDs | 128 |
| Total job timeout | 180s |
| Build timeout | 120s |
| Compressed archive | 50 MB |
| Extracted workspace | 250 MB |
| Max files | 20,000 |
| Published artifact output | 100 MB |

These are starting points for the two golden paths (static HTML; root Vite
+ React), not a tuned production budget. Revisit once real gVisor
measurements exist.

## D-021 - v0.1 golden paths are static HTML and root-level Vite + React on npm only

**Status:** Accepted

The real (non-fake) runner adapters implement exactly two repository
shapes: static HTML with no install/build step, and a root-level Vite +
React app installed with `npm ci` (requires a root `package-lock.json`) and
built with the `package.json` `build` script, publishing `dist/` at a fixed
path. pnpm/yarn/bun, monorepos, Next.js, Vue, and Svelte are recognized by
the analyzer's contract but have no real runner adapter yet; a plan
requesting one of them fails fast with a clear error rather than being
silently attempted.

## D-022 - PostgreSQL is the initial durable control-plane store and queue

**Status:** Accepted

Use PostgreSQL for preview-job state, build-artifact cache metadata,
fixed-window quota counters, and the initial durable work queue. Workers claim
one row atomically with `FOR UPDATE SKIP LOCKED`, attach a bounded lease, and
acknowledge by deleting the leased row. An expired lease makes work available
to another worker after a process crash; an unexpected worker exception delays
and releases the row for retry.

The queue remains behind `PreviewQueue`/`PreviewQueueConsumer` ports, so this
decision does not couple build execution to PostgreSQL or prevent adopting a
managed queue after operational evidence warrants it. The managed PostgreSQL
vendor and region remain deployment choices. Unit tests validate the SQL and
transaction contracts; local PostgreSQL 18.4 verifies concurrent claiming and
expired-lease recovery. A database-restart recovery test remains a release
requirement.
