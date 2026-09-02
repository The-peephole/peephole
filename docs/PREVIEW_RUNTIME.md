# Preview Runtime

## 1. Purpose

This document defines how Peephole can preview supported GitHub repositories without StackBlitz while keeping repository execution outside the Chrome extension and control plane.

The core answer is: it is feasible, but only as a constrained remote execution product with an explicit compatibility contract and production-grade isolation. A browser extension alone is not a safe or sufficiently compatible general project runtime.

## 2. v0.1 Runtime Contract

Supported first:

| Repository class | v0.1 result | Notes |
| --- | --- | --- |
| Static HTML/CSS/JS | Native preview | No package install when unnecessary |
| Root Vite + React | Native preview | First package-based golden path |
| Root Vite + Vue/Svelte | Native preview after gated fixtures | Same static-output contract |
| Existing confirmed deployment | Show/open deployment | Embed only when framing policy allows |
| Next.js SSR / Node server | Unsupported | Persistent server runner deferred |
| Ambiguous monorepo | Unsupported | Workspace selection deferred |
| Backend, DB, Docker, secrets | Unsupported | Requires a broader service model |
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
3. Eligibility produces a normalized build plan
4. User explicitly selects Build preview
5. Control API revalidates and creates/idempotently finds a job
6. Queue assigns the job to an isolated worker
7. Worker fetches, installs, builds, and publishes static output
8. Control API reports an expiring preview URL
9. Side panel embeds the dedicated preview origin
10. Worker workspace and later artifacts are destroyed
```

## 5. Build Plan

The analyzer proposes a plan; the server validates it against the current contract.

```ts
interface BuildPlan {
  contractVersion: string
  repositoryId: number
  owner: string
  name: string
  commitSha: string
  sourceRoot: "."
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none"
  installCommand: string | null
  buildCommand: string | null
  outputDirectory: string
}
```

v0.1 does not accept arbitrary client-supplied shell commands, source roots, output paths, base images, or environment values. Values come from recognized server-side rules.

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
5. Install with lockfile enforcement and controlled registry egress.
6. Disable unrelated network access before the build phase.
7. Execute the approved build command as a non-root user under quotas.
8. Resolve the output directory without following escape symlinks.
9. Validate file count, total bytes, MIME handling, and forbidden content rules.
10. Publish under a job-scoped artifact prefix.
11. Destroy the sandbox and writable filesystem regardless of outcome.

## 8. Isolation Requirements

Public repository builds are hostile multi-tenant workloads. Production isolation must include:

- a stronger boundary than a shared application process,
- non-root execution and least-capability configuration,
- immutable base images and no host mounts,
- no Docker/container socket exposure,
- per-job CPU, memory, PID, disk, output, and time quotas,
- denied loopback, private, link-local, metadata, and control-plane networks,
- explicit dependency-registry allow policy during install,
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

The simplest v0.1 model has phases:

1. source fetch: GitHub archive endpoint only,
2. dependency install: approved package registries only,
3. build: no egress by default,
4. preview delivery: ordinary browser requests from the isolated preview origin.

DNS resolution and redirects must not bypass IP-range restrictions. Network policy should be enforced outside the guest process.

## 11. Caching and Reproducibility

Cache artifacts by:

```text
repository-id
+ commit-sha
+ normalized-build-plan
+ contract-version
+ runner-image-version
```

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

## 15. Infrastructure Decisions

Decided (D-018, D-020, D-021):

- sandbox boundary: gVisor (`runsc`) on Linux x86_64, Firecracker deferred,
- initial resource/timeout limits and archive/workspace/output size caps,
- initial supported runtime: Node 24, npm only,
- golden paths: static HTML, root-level Vite + React.

Still open -- release blockers, not implementation trivia:

- cloud/region and managed queue provider,
- artifact storage/CDN and per-job origin routing,
- anonymous-user quotas and abuse response,
- registry mirror/proxy strategy,
- data retention and deletion policy,
- host-side network policy enforcement for the install phase (restricting
  the sandbox's network namespace to npm-registry-resolved IPs only -- the
  `runsc --network=sandbox|none` selection exists, but the firewall/veth
  rules that would actually constrain "sandbox" mode to the registry do
  not),
- a prepared, maintained base rootfs image (Node 24 + npm, non-root user,
  no secrets) for `GVisorSandboxProvisioner` to copy per job,
- verifying the real `GVisorSandboxProvisioner`/`RunscCommandRunner`
  adapters against an actual gVisor host (they are implemented against
  documented `runsc`/OCI behavior and unit-tested via a fake process
  runner, but have not run against real `runsc` anywhere).

## 16. Primary References

- [esbuild API: running in the browser](https://esbuild.github.io/api/)
- [Sandpack usage](https://sandpack.codesandbox.io/docs/getting-started/usage)
- [Sandpack self-hosted bundler](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
- [gVisor architecture](https://gvisor.dev/docs/architecture_guide/intro/)
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
