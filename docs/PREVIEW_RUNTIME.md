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
| Root Vite + Vue/Svelte | Analysis only / unsupported | Recognized, but no runner target is implemented |
| Existing repository homepage | External link | Normalized HTTP(S) metadata only; no reachability check or embedded Live Preview |
| Next.js SSR / Node server | Unsupported | Persistent server runner deferred |
| Ambiguous monorepo | Unsupported | Workspace selection deferred |
| Backend, DB, Docker, secrets | Unsupported | Full-stack roadmap; not implemented |
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
2. Analyzer resolves repository id + commit SHA
3. The Build Adapter resolver produces a normalized build plan when exactly
   one registered capability matches
4. User explicitly selects Build preview
5. Control API revalidates and creates/idempotently finds a job
6. Queue assigns the job to an isolated worker
7. Worker fetches, installs, builds, and publishes static output
8. Control API reports an expiring preview URL
9. Side panel embeds the dedicated preview origin
10. Worker workspace and later artifacts are destroyed
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
  sourceRoot: "."
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none"
  installCommand: string | null
  buildCommand: string | null
  outputDirectory: string
}
```

The API does not accept arbitrary client-supplied shell commands, source roots,
output paths, base images, or environment values. Values come from the explicit
`core/preview/buildAdapters.ts` registry. Its two adapters are
`static-html-v1` and `vite-react-npm-v1`. Shape validation covers repository
identity, the full SHA, root-only source, basic types, and a safe output path;
adapter validation covers the exact package manager, commands, and output
semantics. A plan for pnpm/yarn/bun cannot become runnable through shape
validation alone.

Adapter identity is intentionally not part of `BuildPlan`. The current two
adapters have fully distinct executable plan semantics, client and server
resolve from analysis deterministically, and the server never trusts a
client-selected adapter or commands. `sourceRoot` remains the literal `"."`.

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
5. Install with npm lockfile enforcement and the current bounded public-egress
   policy.
6. Disable unrelated network access before the build phase.
7. Execute the approved build command as a non-root user under quotas.
8. Resolve the output directory without following escape symlinks.
9. Validate file count, total bytes, entry types/paths, and serving MIME
   behavior.
10. Publish under a job-scoped artifact prefix.
11. Destroy the sandbox and writable filesystem regardless of outcome.

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
- static HTML and root-level Vite + React/npm golden paths;
- PostgreSQL job/cache/quota/artifact state and durable leased work claiming;
- GitHub App requester authentication;
- artifact-specific HTTPS hostname routing and persisted artifact expiry;
- real-host gVisor and end-to-end production-path verification recorded in the
  living roadmap/checklist.

Known limitations and follow-up work:

- install egress is bounded public IPv4 rather than an authenticated
  registry-only proxy;
- production-grade metrics, centralized logs, alerts, retention policy, and
  automated post-deployment smoke orchestration remain operational work;
- the dedicated malicious dependency-script suite still needs its recorded
  production-like AWS run;
- existing-site Live Preview, generalized frontend adapters/targets, and every
  full-stack runtime feature remain on the ordered product roadmap.

The official current Vite + React pin is
`The-peephole/peephole-fixture-vite-react@4a2c3b78e15d90865ed565c3d38c4045b5a5235f`
(repository id `1371620276`). The prepared full-stack fixture
`The-peephole/peephole-fixture-fullstack@eae411a288b212201933cebb206126dd5bb0d93e`
is not consumed by the current runtime.

## 16. Primary References

- [esbuild API: running in the browser](https://esbuild.github.io/api/)
- [Sandpack usage](https://sandpack.codesandbox.io/docs/getting-started/usage)
- [Sandpack self-hosted bundler](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
- [gVisor architecture](https://gvisor.dev/docs/architecture_guide/intro/)
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
