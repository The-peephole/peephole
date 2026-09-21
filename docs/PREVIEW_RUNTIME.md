# Preview Runtime

## 1. Purpose

This document describes the implemented Peephole static-preview runtime and the
boundaries that future runtime work must preserve.

Peephole uses constrained remote execution with an explicit compatibility
contract. A browser extension alone is not a safe or sufficiently compatible
general project runtime.

## 2. Current Runtime Contract

Supported first:

| Repository class | Current result | Notes |
| --- | --- | --- |
| Static HTML/CSS/JS | Native preview | No package install when unnecessary |
| Root Vite + React | Native preview | First package-based golden path |
| Selected nested Vite + React | Native preview | npm with target-local `package.json` and `package-lock.json`; commands run in the selected directory |
| Root Vite + Vue/Svelte | Analysis only / unsupported | Recognized, but no runner target is implemented |
| Existing repository homepage | External link | Normalized HTTP(S) metadata only; no reachability check or embedded Live Preview |
| Next.js SSR / Node server | Unsupported | Persistent server runner deferred |
| Shared-root npm/pnpm/yarn workspace | Analysis only / unsupported | Workspace orchestration remains deferred |
| One narrow backend shape (`express-node-npm-v1`) paired with its frontend | Production-verified server-side (`fullstack-v1`), no extension UI yet | See section 13a; not offered as a Build Preview option in the extension |
| Any other backend, DB, Docker, secrets | Unsupported | Arbitrary Node backends, generated secrets, and provisioned databases remain unimplemented (roadmap stages 10-11) |
| Library repository with no demo app | Analysis only | There may be nothing visual to run |

`react/react` is an example of the last category: it is primarily a library repository and should not be assumed to have a default preview application.

## 3. Why the Extension Does Not Run Projects

An extension page can render HTML and use WebAssembly, but real repositories may require package resolution, lifecycle scripts, native modules, arbitrary build commands, server processes, large files, and network access. Running those inside a privileged extension would combine untrusted code with browser permissions and user session context.

Therefore:

- the content script only integrates with GitHub,
- the side panel only presents and controls,
- the control API only validates and schedules,
- the isolated worker is the only component allowed to execute repository build code.

## 4. System Flow

```text
1. Extension resolves owner/repo and requests analysis
2. Analyzer resolves repository id + commit SHA and bounded project candidates
3. The user may select a candidate, which receives a separate target-scoped
   exact-SHA analysis
4. The Build Adapter resolver produces a normalized build plan when exactly
   one registered capability matches
5. User explicitly selects Build preview
6. Control API revalidates the commit, candidate, target files, analysis, and plan
7. Queue assigns the job to an isolated worker
8. Worker fetches, installs, builds, and publishes only target static output
9. Control API reports an expiring preview URL
10. Side panel embeds the dedicated preview origin
11. Worker workspace and later artifacts are destroyed
```

## 5. Build Plan

The client proposes only the repository/commit and contract identity needed to
request a job. The server reads the exact commit, reruns analysis, resolves a
server-owned Build Adapter, and reconstructs the plan independently.

```ts
interface BuildPlan {
  contractVersion: string
  repository: {
    repositoryId: number
    owner: string
    name: string
    commitSha: string
  }
  sourceRoot: string // "." or a validated repository-relative POSIX directory
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none"
  installCommand: string | null
  buildCommand: string | null
  outputDirectory: string
}
```

The API accepts only a target identity, never client-supplied commands or
outputs. It independently rediscovers and authorizes that source root at the
same exact commit. Executable values come from the explicit
`core/preview/buildAdapters.ts` registry. Its two adapters are
`static-html-v1` and `vite-react-npm-v1`. Shape validation covers repository
identity, the full SHA, contract-compatible source root, basic types, and a safe output path;
adapter validation covers the exact package manager, commands, and output
semantics. A plan for pnpm/yarn/bun cannot become runnable through shape
validation alone.

Adapter identity is intentionally not part of `BuildPlan`. The current two
adapters have fully distinct executable plan semantics, client and server
resolve from analysis deterministically, and the server never trusts a
client-selected adapter or commands. `static-v1` remains root-only with an
implicit `"."`; `static-v2` requires an explicit target and permits a validated
nested source root. Cache and idempotency identity include that source root.

## 6. Job Lifecycle

```text
queued
  -> fetching
  -> installing
  -> building
  -> publishing
  -> ready

Any active phase -> failed or cancelled
Any terminal phase -> expired
```

Job status includes stable error codes and sanitized diagnostics. Raw build logs require strict truncation and redaction before presentation.

## 7. Static Runner Procedure

1. Allocate a fresh sandbox with no user or infrastructure secrets.
2. Fetch the public source archive for the exact commit SHA.
3. Reject archives that exceed compressed, expanded, path, or file-count limits.
4. Create a bounded writable workspace over a read-only runtime image.
5. Resolve the selected directory with lexical, symlink-segment, and realpath
   containment checks.
6. Install from that directory with a target-local npm lockfile and the current
   bounded public-egress policy.
7. Disable unrelated network access before the build phase.
8. Execute the approved build command from the same directory as a non-root user under quotas.
9. Resolve the target-relative output directory without following escape symlinks.
10. Validate file count, total bytes, entry types/paths, and serving MIME
   behavior.
11. Publish under a job-scoped artifact prefix.
12. Destroy the sandbox and writable filesystem regardless of outcome.

## 8. Isolation Requirements

Public repository builds are hostile multi-tenant workloads. Production isolation must include:

- a stronger boundary than a shared application process,
- non-root execution and least-capability configuration,
- immutable base image and no access to arbitrary or sensitive host paths;
  only owned job/runtime mounts are exposed,
- no Docker/container socket exposure,
- per-job CPU, memory, PID, disk, output, and time quotas,
- denied loopback, private, link-local, metadata, and control-plane networks,
- install egress that blocks private, loopback, link-local, metadata, host, and
  inter-job destinations; registry-only proxying remains future hardening,
- no ambient cloud credentials,
- aggressive cleanup and orphan reaping,
- separate queues or capacity controls to contain abuse.

**Decided (see D-018):** gVisor (`runsc`) on Linux x86_64, as an OCI
container boundary rather than a bare process. Firecracker is deferred, not
rejected -- it needs KVM/nested virtualization and a jailer/VM-image
pipeline that is out of scope for v0.1. The infrastructure choice is not
interchangeable with the requirements: network policy, host hardening,
patching, and observability remain necessary regardless of which sandbox
technology is used, and `SandboxProvisioner`/`CommandRunner` (D-019) keep
the rest of the runner from depending on gVisor specifically.

## 9. Preview Origin Security

Serve generated content from a registrable domain separate from the API/control UI, for example:

```text
api.peephole.dev
{job-id}.peephole.run
```

Requirements:

- no control-plane cookies on preview requests,
- no bearer tokens in query strings,
- per-job origin or equivalent storage isolation,
- restrictive CSP and Permissions Policy,
- `nosniff` and correct MIME types,
- no privileged extension messaging bridge,
- short artifact TTL and explicit expiry state,
- safe SPA fallback rules that cannot expose another job's files.

The side panel must validate the URL origin before embedding it.

## 10. Network Model

The implemented production model has phases:

1. the host fetcher downloads the exact public commit archive from GitHub
   codeload under archive limits;
2. dependency install runs in a dedicated sandbox network namespace with public
   IPv4 egress while private, loopback, link-local, metadata, host, special-use,
   and inter-job destinations are blocked; only the configured resolvers receive
   DNS exceptions;
3. build runs with `network: "none"`;
4. preview delivery is an ordinary browser navigation to the isolated artifact
   origin.

This is not registry-only egress. An authenticated package proxy or equivalent
restriction remains planned hardening. Policy is enforced outside the guest
process.

## 11. Caching and Reproducibility

Cache artifacts by:

```text
repository-id
+ commit-sha
+ normalized-build-plan
+ contract-version
+ runner-image-version
```

The cache key continues to include every executable plan field. Adapter ids are
not added because they provide no execution identity beyond those fields; two
semantically different executable plans therefore still cannot share a key.

Cache hits skip execution but still return a new authorized/expiring job reference if needed. Never reuse mutable workspaces. Dependency caches, if introduced, are read-only or content-addressed and must not allow one job to poison another.

## 12. Browser Runner: Optional Later Optimization

Browser-side compilation is technically possible for a narrow set of projects. `esbuild-wasm` can run in a browser or Web Worker, and tools such as Sandpack demonstrate browser preview workflows.

It is not the primary v0.1 runtime because Peephole would still need to implement secure dependency resolution, package-file fetching, plugin behavior, asset handling, lifecycle-script policy, framework compatibility, memory limits, and error reporting. Native modules, postinstall scripts, SSR, and many bundler plugins would remain incompatible.

A later browser runner may accelerate very small, dependency-constrained projects after the server contract is stable. It must run in an unprivileged isolated origin, not the extension's privileged page.

## 13. Persistent Server Runtime: Deferred

Supporting Next.js SSR or arbitrary Node servers changes the product from static build-and-publish to long-lived untrusted compute. It requires runtime routing, health checks, idle suspension, websocket handling, per-session resource accounting, outbound-network policy, and a larger abuse surface.

Do not extend the static worker by simply leaving the build container running. Define and review a separate server-runtime contract first.

## 13a. Backend Runtime (`backend-v1`): Isolated Standalone Execution

This is that separate contract, and it is narrow by design. Its success
criterion is **"Peephole can safely start, supervise, stop, and clean up one
narrowly-supported backend process inside gVisor"** -- not "supports
arbitrary Node backends," not "supports full-stack preview," and not
"frontend can call the backend." See D-030 for the full design rationale.

**Contract.** `types/backendRuntime.ts` defines `BackendRuntimePlan`, a
contract fully independent from `BuildPlan`/`static-v1`/`static-v2` with its
own `backend-v1` version namespace. The only implemented adapter is
`express-node-npm-v1` (`core/analyzer/backendRuntimeAdapter.ts`): Express
only, npm with a required `package-lock.json`, zero database dependencies,
and every environment requirement classified `auto-configurable`
(`PORT`/`HOST`/`NODE_ENV` only). A client may request only repository
identity, the exact commit, and an optional `sourceRoot` hint; the server
(`services/backend-runtime-api/githubRuntimePlanResolver.ts`) independently
re-derives everything else at that exact commit, and the worker
(`core/preview/backendRuntimePlanValidator.ts`) re-validates the queued plan
a second time against an exact allowlist before ever executing anything.
The runtime never executes `npm start`, a shell, or a client-supplied
command -- only a structurally-derived `node <entrypoint>.{js,mjs,cjs}`.

**Lifecycle.**

```text
queued -> fetching -> installing -> starting -> running -> stopping -> stopped

Cancel while queued/fetching/installing/starting -> cancelled (direct)
Cancel while running/stopping -> stopping -> stopped
Any active phase -> failed
Any active phase past its TTL -> expired
```

Recommended default TTL is 10 minutes; the worker also carries a longer,
independent OS-process backstop timeout. Recovering from a worker restart is
fail-closed: any runtime still `starting`/`running` at startup is treated as
stale, its sandbox/network/disk are reaped, and it is marked `failed` --
Peephole never lets an orphaned backend keep running after a worker
restart.

**Runtime process primitive.** `runsc run` is a foreground, blocking CLI
call with no "start in background" flag. `RunscCommandRunner` (used for
`npm ci`/`npm run build`) is explicitly "one command, wait for exit,
delete" and is never repurposed into a persistent-server primitive.
`GVisorBackendRuntimeProcess` (`services/preview-worker/gvisor/backendRuntimeProcess.ts`)
is the new, separate primitive: it fires `runsc run` without awaiting its
completion and exposes `start()/waitUntilReady()/waitForExit()/stop()`.
Stopping always goes through `runsc kill` then `runsc delete` -- the same
sanctioned container-lifecycle pair the rest of this codebase already uses
-- never an OS signal to the local `runsc run` process. Readiness is a bare
TCP connect to the sandbox's internal port from the host's own root network
namespace; an application route such as `/health` is never a generic
contract requirement (only used internally against the official fixture in
an environment-gated real-host test).

**Network model: ingress-only, no new outbound.** This is the core security
boundary of this stage. The backend's sandbox gets its own network
namespace with no NAT, no default route, and no DNS: its egress chain
unconditionally drops, so it can never reach the public internet, host
services, cloud metadata, loopback, RFC1918/link-local space, another
Peephole job, the control plane, or the artifact service. A host-side
trusted process (today, the readiness probe) can still reach the sandbox's
assigned port with **zero** firewall exceptions needed, because a
host-root-namespace connection to a directly-connected veth peer is locally
generated `OUTPUT` traffic, not `FORWARD`ed traffic -- only the reply
(`ESTABLISHED,RELATED`) is explicitly allowed back in. Install still runs
under the existing egress-NAT policy (`npm ci` needs registry access); the
runtime process never does. See D-030 for how this was made additive to
`NetworkOrphanReaper`'s existing crash-safety validation instead of
conflicting with it.

**No public backend URL on the standalone resource.** The standalone
`/v1/backend-runtimes` API and UI can only ever report "Running" -- never a
URL, hostname, or "Open backend" control; there is no wildcard public domain
scoped to it, no reverse proxy, no frontend API rewrite, and no iframe
pointed at it directly. Frontend-to-backend routing (stage 9 in
`docs/MVP_ROADMAP.md`) is production-verified as of M9, but it is a
*separate* durable parent resource, `fullstack-v1`
(`/v1/fullstack-previews`, see D-031) -- it pairs one `backend-v1` runtime
with one static build behind its own single same-origin HTTPS preview and
routes only `/api`/`/api/*` to that runtime. It does not add a URL to the
standalone `backend-v1` resource itself.

**Production capability gate.** `WXT_BACKEND_RUNTIME_ENABLED` is a
client-side (extension) build flag, independent of server wiring: it must be
exactly `"true"` before the extension creates a backend runtime client or
renders Start/Stop controls, and there is still no such extension-facing UI.
Server-side, `backend-v1`'s control plane and worker (and `fullstack-v1`'s)
are wired into `services/production/server.ts`'s `main()`, and the
ingress-only network policy has been verified against a real gVisor/Linux
production host -- both done during M9 (see docs/PRODUCTION_SMOKE.md and
docs/TEST_PLAN.md's M9 production verification record). A candidate may be
compatible, but this still must not imply that end-user Build Preview
execution of a backend is available -- it is not.

**Control plane.** A separate resource, `POST/GET/DELETE
/v1/backend-runtimes` (`services/backend-runtime-api/`) -- never the
existing `PreviewJob` resource. Ownership is bound to the requester subject;
a different requester gets `404`, not `403`, on both read and cancel. An
identical in-flight request is returned idempotently; otherwise one active
runtime per requester is enforced by default. Errors are one of a specific
typed set (`FETCH_FAILED`, `UNSUPPORTED_BACKEND`, `INSTALL_FAILED`,
`RUNTIME_START_FAILED`, `RUNTIME_READINESS_TIMEOUT`, `RUNTIME_EXITED`,
`RUNTIME_TIMEOUT`, `RUNTIME_DISK_LIMIT`, `RUNTIME_UNAVAILABLE`) -- raw
stdout/stderr, filesystem paths, and runsc/network internals are never
exposed to a client.

**Known limitations.** Persistence remains in-memory only
(`InMemoryBackendRuntimeStore`/`InMemoryBackendRuntimeQueue`); a durable
Postgres-backed store, matching the static path's, is future work (the
`fullstack-v1` *parent* row is Postgres-backed per D-031, but the
`backend-v1` child runtime state it references is not). The ingress-only
network policy initially had only unit coverage; it was exercised against a
real gVisor/Linux host and `composeProductionBackendRuntime`
(`services/preview-worker/gvisor/composeProductionBackendRuntime.ts`) was
wired into production startup during M9. A live disk-quota watcher during
the *running* phase is not implemented; the sandbox's fixed-size ext4
workspace remains the non-bypassable backstop, matching install/build.

## 14. Minimum API Contract

Create:

```http
POST /v1/preview-jobs
Idempotency-Key: <opaque key>
```

The request identifies repository and commit plus a contract version; it does not provide arbitrary shell commands. The response returns job id, state, cache status, and expiry.

Status:

```http
GET /v1/preview-jobs/{jobId}
```

Cancel:

```http
DELETE /v1/preview-jobs/{jobId}
```

The API validates that a caller may observe/cancel the job and exposes only sanitized errors.

## 15. Infrastructure Status

Implemented and verified in the production path:

- gVisor (`runsc`) on Linux x86_64 with a prepared Node 24/npm rootfs;
- non-root execution, resource/timeout limits, bounded loop-backed workspace,
  read-only rootfs, network namespaces, and cleanup/reconciliation;
- static HTML, root Vite + React/npm, and selected nested frontend-only golden paths;
- PostgreSQL job/cache/quota/artifact state and durable leased work claiming;
- GitHub App requester authentication;
- artifact-specific HTTPS hostname routing and persisted artifact expiry;
- real-host gVisor and end-to-end production-path verification recorded in the
  living roadmap/checklist;
- `backend-v1` real gVisor ingress-only execution and `fullstack-v1`
  frontend/backend routing, both wired into production and production-verified
  in M9, including fail-closed behavior on a `peephole` service restart (see
  docs/PRODUCTION_SMOKE.md and docs/TEST_PLAN.md).

Known limitations and follow-up work:

- install egress is bounded public IPv4 rather than an authenticated
  registry-only proxy;
- production-grade metrics, centralized logs, alerts, retention policy, and
  automated post-deployment smoke orchestration remain operational work;
- the dedicated malicious dependency-script suite still needs its recorded
  production-like AWS run;
- generated-secret injection and temporary database provisioning (roadmap
  stages 10-11) remain unimplemented.

The official current Vite + React pin is
`The-peephole/peephole-fixture-vite-react@4a2c3b78e15d90865ed565c3d38c4045b5a5235f`
(repository id `1371620276`). The full-stack fixture
`The-peephole/peephole-fixture-fullstack@eae411a288b212201933cebb206126dd5bb0d93e`
is now consumed by the current runtime's `backend-v1`/`fullstack-v1` real
gVisor verification (see docs/TEST_PLAN.md); it does not make arbitrary
backends supported.

## 16. Primary References

- [esbuild API: running in the browser](https://esbuild.github.io/api/)
- [Sandpack usage](https://sandpack.codesandbox.io/docs/getting-started/usage)
- [Sandpack self-hosted bundler](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
- [gVisor architecture](https://gvisor.dev/docs/architecture_guide/intro/)
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
