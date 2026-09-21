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
databases remain non-runnable. Repository homepage metadata and a confirmed
GitHub deployment are both shown as external links opened in a new tab; there
is no embedded deployed-site iframe.

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

### Backend runtime and full-stack routing (M9)

- [x] `backend-v1`: one narrowly-supported adapter (`express-node-npm-v1`),
      independently re-derived and re-validated server-side, executed inside
      its own ingress-only gVisor network namespace
- [x] `fullstack-v1`: a durable parent resource pairing one `backend-v1`
      runtime with one static build behind a single same-origin HTTPS
      preview, routing only `/api`/`/api/*` to the backend
- [x] real gVisor host verification of both, plus fail-closed behavior on a
      `peephole` service restart (a `ready` full-stack preview is
      invalidated, never reconstructed)
- [x] production host smoke passes with both wired into
      `services/production/server.ts`

This remains narrowly scoped: one supported backend adapter, no arbitrary
Node backend, no generated secret, and no provisioned database. Stage 8 was
implemented before this milestone but only production-verified here; see
"Next Development Sequence" below for exact stage numbering.

## Next Development Sequence

These stages are ordered. A later stage must not be presented as supported
because a fixture or interface for it exists.

1. [x] GitHub theme synchronization
2. [x] Branch Preview
3. [x] Repository / application structure detection
4. [x] Build Adapter generalization
5. [x] frontend target selection / bounded frontend monorepo support
6. [x] existing deployed-site Live Preview
7. [x] backend detection + environment requirement analysis
8. [x] backend-v1 execution foundation implemented; production-verified in M9
9. [x] frontend ↔ backend routing; production-verified in M9
10. [ ] ephemeral env / secrets
11. [ ] temporary database support

Build Adapter generalization is complete as an architecture change: an
explicit resolver selects `static-html-v1` or `vite-react-npm-v1`, detects
ambiguous matches, and assigns command/output validation to the selected
adapter. It does **not** mean more frameworks or runners are supported.
Vue/Svelte and pnpm/yarn/bun remain non-runnable. Stage 5 supports only an
explicitly selected, independently installable nested React + Vite + npm target
with its own package.json and package-lock.json. Shared-root workspace
orchestration remains deferred. At this stage the full-stack fixture proved
only frontend-only static build output; its backend and `/api/hello` route
were not yet reachable. Both are now production-verified as of M9 (see
stages 8-9 below) through the separate, narrow `fullstack-v1` contract --
this did not change or extend Stage 5's own frontend target-selection
contract.

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

Existing deployed-site Live Preview removes a real false-positive: a declared
`repository.homepage` alone used to force `preview.mode` to
`"existing-deployment"` even when the repository was genuinely buildable, and
was labeled "confirmed" even though a homepage can be anything (this
repository's own homepage is a Chrome Web Store listing, not a deployed app).
`detectDeployment` now returns `"declared"` for a homepage and `"configured"`
for a `vercel.json`/`netlify.toml` marker with no known URL; neither value is
proof of a live deployment, and `preview.mode` resolves to
`native-static-build` whenever the target is actually buildable regardless of
either. A real "confirmed" live deployment now requires a separate, bounded
GitHub Deployments API lookup (`GitHubClient.listRepositoryDeployments`,
`per_page=10`, one page; `GitHubClient.listDeploymentStatuses`, `per_page=30`,
one page, at most 5 deployments ever checked, ranked
`production_environment` first) whose pure selection rule
(`core/analyzer/liveDeploymentSelector.ts`) only accepts a `success` status
with a validated, safe HTTPS `environment_url`
(`core/github/externalUrlPolicy.ts`: HTTPS-only, no credentials, no
loopback/private/link-local/CGNAT IPv4 or IPv6 literal, no control
characters, bounded length). This result is mutable, short-TTL (45s) state
keyed by repository identity only (`core/github/liveDeploymentCache.ts`),
kept out of the immutable `repositoryId:commitSha:analyzerVersion` analysis
cache, and reaches the Side Panel through its own bounded background message
(`LOAD_REPOSITORY_DEPLOYMENTS`) rather than a generic fetch/proxy primitive.
A lookup failure renders its own isolated message in the new "Deployment"
section and never affects repository analysis or Build Preview. There is
still no embedded remote iframe or server-side fetch of the deployment URL:
"Open live site" is a plain `target="_blank"` link, exactly like the
pre-existing homepage link, and no manifest permission or CSP changed (the
Deployments API is under the already-permitted `api.github.com` host). Live
deployment stays a repository-level concept -- selecting a nested frontend
target never implies the discovered live deployment belongs to that target.

Backend detection + environment requirement analysis is detection only, never
execution or provisioning. `RepositoryAnalysis.backend` reports bounded,
evidence-graded candidates (Express/NestJS/Fastify/Koa/Hapi, database/server
dependencies as supporting evidence only, a textually-derived and
network-unverified entrypoint, weak directory-name evidence) for the
repository root (classified from data already fetched, zero extra requests)
and a bounded set of nested candidates from the already-discovered
`RepositoryStructure.projects` (`MAX_BACKEND_CANDIDATES` = 5, fetched via
fixed `package.json`/`.env.*` reads, never a directory listing or a fresh
crawl). A hosted-backend-client dependency (Supabase/Firebase/AWS Amplify)
alone never creates a candidate. `RepositoryAnalysis.environmentRequirements`
classifies declared `.env.example`-family variable names (never values) as
auto-configurable, preview-generated-secret-candidate,
database-requirement, external-routing-candidate, user-required, or
unknown -- none of these are acted on: no secret is generated, no value is
injected, no routing is rewritten. A backend discovery failure degrades to
an "unavailable" result instead of failing repository analysis or Build
Preview, and none of this relaxes `SECRET_ENV_REQUIRED`/`BACKEND_REQUIRED`
eligibility (a repository like this one's own portfolio fixture with
`MARKETPLACE_PAT` still blocks Build Preview exactly as before). A backend
candidate is never selectable as a preview target and no new Build Adapter
was added.

The early stages establish repository selection and generalized build contracts
before full-stack execution is considered. Backend execution requires a new
reviewed runtime contract; it must not be implemented by extending the lifetime
or privileges of the static-build sandbox.

Backend execution is that new, wholly separate `backend-v1` runtime contract
(`types/backendRuntime.ts`, `services/backend-runtime-api/`,
`services/backend-runtime-worker/`) -- see D-030 and
docs/PREVIEW_RUNTIME.md's "Backend Runtime (backend-v1)" section for the
full design. Its success criterion is narrowly "safely start, supervise,
stop, and clean up one supported backend process inside gVisor," not
"supports arbitrary Node backends" and not "frontend can call the backend."
The only implemented adapter (`express-node-npm-v1`) requires Express, npm,
a committed `package-lock.json`, zero database dependencies, and every
environment requirement already classified `auto-configurable`
(`PORT`/`HOST`/`NODE_ENV` only); everything else keeps showing "Execution:
Not supported yet" exactly as stage 7 left it. The runtime gets its own
ingress-only network namespace (no NAT, no default route, an unconditional
egress `DROP`) instead of the install/build sandbox's NAT'd egress policy.
At the time this contract was first implemented there was still no public
backend URL, no frontend/backend routing, no generated secret, and no
provisioned database. Frontend/backend routing (stage 9) was later
production-verified in M9 through the separate `fullstack-v1` parent
resource (`/v1/fullstack-previews`), which reports its own public HTTPS
origin and routes only `/api`/`/api/*` to the backend; the standalone
`backend-v1` resource (`/v1/backend-runtimes`) still never reports a URL of
its own. A generated secret and a provisioned database remain unimplemented
(stages 10-11). `static-v1`/`static-v2`/`BuildPlan`/the static artifact
pipeline are unchanged. Persistence in this stage remains in-memory only
(see D-030); the ingress-only network policy was initially unit-tested only
and was later verified against a real gVisor/Linux production host and
wired into production startup during M9 -- see
docs/PREVIEW_RUNTIME.md's "Backend Runtime (backend-v1)" section and
docs/PRODUCTION_SMOKE.md for the verification record.

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

The full-stack fixture:

```text
repository: The-peephole/peephole-fixture-fullstack
commit: eae411a288b212201933cebb206126dd5bb0d93e
```

was originally reserved for future roadmap work and, at earlier stages, only
served as a real verification target for repository structure detection
(its `frontend`/`backend` layout is surfaced as bounded project candidates --
structure-detection evidence only, not full-stack preview, backend, or
routing support). It is now also the pinned fixture for the narrow
`fullstack-v1` contract (stages 8-9), production-verified in M9: a real
gVisor `backend-v1` process (`express-node-npm-v1` adapter only) and
frontend/backend routing through a dedicated `FullStackPreview` origin. This
remains the one narrow supported backend shape -- it does not imply support
for arbitrary Node backends, generated secrets, or provisioned databases
(stages 10-11).

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
