# Peephole Roadmap

## Current Baseline

Peephole has a deployed, commit-pinned static-preview path:

```text
public GitHub repository
-> GitHub action and Chrome Side Panel
-> bounded analysis of the selected (or default) branch's resolved commit
-> authenticated Preview Control Plane job
-> PostgreSQL queue/state
-> isolated gVisor build
-> static HTTPS artifact
-> Side Panel preview
```

The following foundation is implemented:

- GitHub repository injection and SPA navigation handling;
- repository metadata and bounded known-file analysis;
- evidence, warnings, blockers, and versioned eligibility;
- GitHub App authentication with short-lived Peephole sessions;
- commit-pinned asynchronous jobs, cancellation, expiry, quotas, caching, and
  PostgreSQL persistence;
- a real production worker using gVisor, non-root execution, resource limits,
  disk bounds, phased network controls, and recovery/reaping;
- isolated static artifact publication and Chrome Side Panel rendering;
- production deployment plus portable, live-network, PostgreSQL, and
  environment-gated gVisor verification paths.

This baseline does not imply arbitrary repository or full-stack support.

## Current Execution Contract

The production runner accepts only:

1. package-free static HTML/CSS/JS with a root `index.html`;
2. a root-level Vite + React application using npm, a root
   `package-lock.json`, `npm ci`, a `build` script, and a deterministic static
   output directory.

The analyzer recognizes more evidence than the worker can execute. Vue/Svelte
Vite, pnpm/yarn/bun, monorepos, backends, persistent servers, secrets, and
databases remain non-runnable. Repository homepage metadata may be shown as an
external link, but deployed-site Live Preview is not implemented.

## Completed Foundation Milestones

### Extension and analysis

- [x] WXT + React + TypeScript Manifest V3 extension
- [x] idempotent GitHub repository action and client-side navigation handling
- [x] Chrome Side Panel state synchronization
- [x] public repository id, default branch, and immutable head commit resolution
- [x] bounded known-file loading and metadata caching
- [x] framework, package-manager, runtime, environment, deployment, and
      workspace evidence
- [x] explicit blockers and runner-capability gating

### Control plane and persistence

- [x] create/status/cancel Preview API
- [x] server-side repository, commit, and build-plan revalidation
- [x] idempotency, cache lookup, quotas, expiry, and structured failures
- [x] PostgreSQL job, cache, quota, artifact, and leased-queue persistence
- [x] GitHub App OAuth/PKCE flow and authenticated preview sessions

### Production execution and delivery

- [x] commit archive fetch, bounded extraction, frozen npm install, static
      build, output validation, and artifact publication
- [x] real gVisor production composition and non-root execution
- [x] CPU, memory, PID, wall-clock, archive, workspace-disk, output-size, and
      file-count controls
- [x] install/build network phase separation and blocking for private,
      loopback, link-local, metadata, host, and inter-job destinations
- [x] startup and normal-path reconciliation for runsc, disk, and network state
- [x] artifact-specific HTTPS origins, restrictive headers, expiry, and cleanup
- [x] end-to-end Chrome extension -> production API -> PostgreSQL -> gVisor ->
      artifact -> Side Panel verification recorded

## Next Development Sequence

These stages are ordered. A later stage must not be presented as supported
because a fixture or interface for it exists.

1. [x] GitHub theme synchronization
2. [x] Branch Preview
3. [x] Repository / application structure detection
4. [x] Build Adapter generalization
5. [x] frontend target selection / bounded frontend monorepo support
6. [ ] existing deployed-site Live Preview
7. [ ] backend detection
8. [ ] backend execution
9. [ ] frontend ↔ backend routing
10. [ ] ephemeral env / secrets
11. [ ] temporary database support

Build Adapter generalization is complete as an architecture change: an
explicit resolver selects `static-html-v1` or `vite-react-npm-v1`, detects
ambiguous matches, and assigns command/output validation to the selected
adapter. It does **not** mean more frameworks or runners are supported.
Vue/Svelte and pnpm/yarn/bun remain non-runnable. Stage 5 supports only an
explicitly selected, independently installable nested React + Vite + npm target
with its own package.json and package-lock.json. Shared-root workspace
orchestration remains deferred. The full-stack fixture proves frontend-only
static build output; its backend and `/api/hello` route remain unavailable.

Theme synchronization uses computed GitHub/Primer semantic colors rather than
a theme-name palette table. Theme changes update the injected action through
the page cascade and the Side Panel through a validated, tab-scoped snapshot;
they do not remount analysis, preview jobs, or the artifact iframe.

Branch Preview lets the Side Panel select any branch from a bounded (up to
100, default branch always included) `GET .../branches` listing and resolves
it to a full 40-character commit SHA (`GitHubClient.getRepositoryMetadataAtBranch`)
before analysis, build plan, or Preview API requests ever see it. The selected
mutable ref (`RepositoryRefSelection`), the repository identity, and the
resolved immutable commit stay three distinct concepts
(`RepositoryRevisionTarget` in `types/repository.ts`); `defaultBranch` on
`RepositoryMetadata` always reflects the repository's real default branch, never
the current UI selection. The metadata current-ref cache is keyed per
repository *and* ref (`getRepositoryRefCacheKey`), so a default-branch lookup
and a named-branch lookup never contaminate each other; analysis, known-files,
and preview identity remain keyed on `repositoryId:commitSha` exactly as
before, so two branches pointing at the same commit share one cached analysis
and one preview-job identity. Branch switches abort the in-flight analysis
request through the existing `AbortController`/effect-cleanup contract, so
rapid re-selection cannot render a stale branch's result.

Repository/application structure detection is a detection-only stage: it
describes a repository's layout (`single-project`, `workspace`,
`multi-project`, or `unknown`) and lists bounded project candidates without
selecting or building any of them. Discovery combines declared workspace
patterns (`package.json` `workspaces`, a bounded `pnpm-workspace.yaml`
`packages:` subset) with a small, capability-driven set of conventional root
directory names (`apps`, `packages`, `frontend`, `backend`, `client`, `web`);
directory names alone are never treated as proof of an application. Every
read is bounded (at most 8 wildcard directory listings, 200 entries per
listing, 20 candidate probes, 512 KB of nested `package.json` bytes total) and
uses the already-resolved commit SHA from Branch Preview, never a mutable
branch name; hitting a bound sets `truncated`, and a failed read sets
`complete: false` instead of failing the whole analysis. Candidates are
labeled `project-candidate`, `package-candidate`, or `unknown` rather than
asserting "application" or "library" from directory names alone, and the
existing `AMBIGUOUS_WORKSPACE` preview blocker still applies exactly as
before -- detecting `frontend`/`backend` in
`The-peephole/peephole-fixture-fullstack` does not make it buildable.

The early stages establish repository selection and generalized build contracts
before full-stack execution is considered. Backend execution requires a new
reviewed runtime contract; it must not be implemented by extending the lifetime
or privileges of the static-build sandbox.

## Fixture Status

The official Vite + React golden-path fixture is:

```text
repository: The-peephole/peephole-fixture-vite-react
repository id: 1371620276
commit: 4a2c3b78e15d90865ed565c3d38c4045b5a5235f
```

PR #6 updated the shared fixture metadata on `main` at merge commit
`dba47191bdd3600b3f451945653efab2363028c2`. A manually dispatched
`Real golden-path build tests` run on that `main` revision succeeded. This is a
live-network workflow result, not a production smoke result.

The full-stack fixture is reserved for future roadmap work:

```text
repository: The-peephole/peephole-fixture-fullstack
commit: eae411a288b212201933cebb206126dd5bb0d93e
```

It is not connected to a supported full-stack runtime contract today. Its
`frontend`/`backend` layout is now a real verification target for repository
structure detection (both are surfaced as bounded project candidates); this
is structure-detection evidence only, not full-stack preview, backend, or
routing support.

## Cross-Cutting Work

These items remain important but do not reorder the product sequence above:

- [ ] complete keyboard, focus, contrast, and screen-reader review;
- [ ] add production-grade metrics, centralized logs, and alerts;
- [ ] automate production deployment smoke orchestration without conflating it
      with CI;
- [ ] replace broad public install egress with an authenticated package proxy
      or equivalently constrained service;
- [ ] run the dedicated malicious dependency-script suite on the
      production-like gVisor host;
- [ ] complete the supported/unsupported fixture matrix and external security
      review.

## Verification Gates

- Portable CI covers formatting, lint, typechecking, unit/integration tests, and
  extension build without requiring a production host.
- `Real golden-path build tests` exercises pinned public archives and the real
  package/build toolchain with live network access.
- Real gVisor suites require a suitable privileged Linux host and establish
  claims about that sandbox environment.
- Production smoke requires an already-deployed instance plus operator-held
  production credentials and host visibility. A green golden-path workflow
  does not satisfy this gate.
