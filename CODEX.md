# Codex Engineering Guide

This repository already contains Peephole's production static-preview
foundation. Treat it as an existing system to extend, not as a bootstrap
exercise. Before changing behavior, inspect the relevant source, tests,
workflows, and living documentation and describe the evidence for the current
behavior.

## Working Agreement

- Do not work directly on `main`. Create a feature branch and use a pull
  request.
- Keep each PR within its stated scope. Do not fold unrelated roadmap work,
  cleanup, or product changes into it.
- Preserve existing behavior, tests, and security boundaries unless the PR is
  explicitly changing one of them.
- Never mark a capability complete from a plan, fixture, type, or test name
  alone. Confirm the production composition and, when relevant, the
  environment-gated verification.
- Do not generalize the product by adding repository-specific conditionals.
  Fixtures prove contracts; they are not production dispatch tables.
- Keep historical release and decision records intact. Update living documents
  and append a new decision or status note when an older accepted decision needs
  qualification.

## Current Production Baseline

The implemented path is:

```text
GitHub repository page
-> Chrome extension repository injection
-> bounded repository analysis at the selected (or default) branch's
   resolved commit
-> authenticated, commit-pinned Preview API job
-> PostgreSQL-backed queue and state
-> real gVisor production worker
-> static artifact publication on an isolated HTTPS origin
-> Chrome Side Panel preview
```

The foundation includes GitHub repository injection, repository analysis,
commit-pinned previews, the Preview Control Plane, PostgreSQL persistence,
GitHub App authentication, sandbox resource/network/disk controls, static
artifact publication, production deployment, and real golden-path tests.

Production execution is deliberately narrower than analysis:

- package-free static HTML rooted at the repository root;
- root or explicitly selected nested Vite + React with npm, a target-local
  `package-lock.json`, `npm ci`, the `build` script, and a deterministic static
  output directory.

Vue/Svelte Vite, other package managers, shared-root workspace orchestration,
backends, persistent servers, secrets, and temporary databases are not current
runner capabilities. A repository's declared homepage and current GitHub
Deployment status are both external-link evidence, opened in a new tab; there
is no embedded deployed-site iframe or arbitrary remote proxy.

## Architecture to Preserve

### Extension and GitHub adapter

- `entrypoints/github.content/` owns GitHub DOM discovery, idempotent action
  insertion, and client-side navigation reconciliation.
- `entrypoints/background.ts` performs fixed, validated cross-origin GitHub
  operations. Content scripts must not receive an arbitrary-fetch primitive.
- `entrypoints/sidepanel/` and `components/` present analysis, authentication,
  job state, and approved preview artifacts.
- Repository code must never execute in a content script, extension page,
  background service worker, or control-plane process.

### Analysis and build plans

- `core/github/` resolves public repository metadata and bounded known files.
- `core/analyzer/` produces evidence, warnings, and blockers without executing
  repository code.
- `core/preview/buildAdapters.ts` is the execution-capability source of truth:
  a typed registry resolves exactly one adapter or no adapter, and rejects
  overlapping matches. `runnerSupport.ts` only maps that shared capability
  result into analyzer blockers.
- The client proposes a versioned build contract; the server independently
  verifies repository identity, the exact commit, analysis, and build plan.
- Branch names are not immutable job or cache identities. Branch Preview must
  resolve a selected branch to a full commit SHA before analysis or execution.
- Repository/application structure detection is bounded and capability-driven:
  it reads a small, fixed set of workspace declarations and conventional
  directory names, never an unbounded or recursive repository crawl. Selection
  is explicit; the selected candidate is reanalyzed and independently
  authorized at the exact commit before execution.

### Control and execution planes

- `services/preview-api/` owns authentication, validation, idempotency, quotas,
  lifecycle transitions, cancellation, cache lookup, and queue admission.
- `services/preview-api/postgres/` provides durable job, artifact, quota, and
  leased-queue state.
- `services/preview-worker/worker.ts` depends on explicit fetch, sandbox,
  install, build, output, and publish ports.
- `services/preview-worker/gvisor/` is the production isolation implementation.
  `services/preview-worker/local/` is an unsandboxed development path and may
  only run trusted source.
- `services/production/server.ts` composes the real production API, PostgreSQL,
  worker loops, gVisor adapters, recovery gates, and artifact host.

### Artifact boundary

Published output is static content served from an artifact-specific hostname on
a registrable domain separate from the API. It must not receive control-plane
cookies, bearer tokens, extension privileges, or privileged messaging.

## Security Invariants

Treat repository files, dependency scripts, build tools, and generated output
as hostile. Changes must preserve the controls already enforced by the
production worker:

- exact commit identity and server-side plan revalidation;
- non-root gVisor execution with a read-only root filesystem;
- bounded CPU, memory, PIDs, wall time, archive size, workspace disk, output
  size, and file count;
- no host/container socket or sibling-job access;
- install-phase public egress with private, loopback, link-local, metadata,
  host, and inter-job destinations blocked;
- no build-phase network access;
- durable ownership records and startup/normal-path reconciliation for runsc,
  disk, and network resources;
- isolated artifact origins, restrictive response headers, expiry, and
  ownership-aware cleanup;
- no repository or infrastructure secrets in the sandbox, client state, or
  logs.

Do not strengthen a security claim from unit tests or configuration alone.
Production isolation claims require the applicable real-host evidence. The
current install network is not registry-only; package-proxy or equivalent
egress restriction remains future work.

## Development Order

Implement product expansion in this order unless a later accepted decision
changes it:

1. GitHub theme synchronization (implemented)
2. Branch Preview (implemented)
3. Repository / application structure detection (implemented)
4. Build Adapter generalization (implemented)
5. frontend target selection / bounded frontend monorepo support (implemented)
6. existing deployed-site Live Preview (implemented)
7. backend detection
8. backend execution
9. frontend ↔ backend routing
10. ephemeral env / secrets
11. temporary database support

Each stage must expose a reviewed contract and preserve earlier security
boundaries. In particular, do not jump from a full-stack fixture to backend
execution, and do not keep the static build container alive as a server.

GitHub theme synchronization reads the current page's computed Primer semantic
colors, validates a small snapshot, and stores it per tab in
`browser.storage.session`. The injected action inherits Primer variables
directly. The Side Panel receives theme-only runtime updates and changes root
CSS custom properties without remounting repository analysis or preview state.
Theme names are event markers, not palette dispatch keys.

Branch Preview adds a bounded `GitHubClient.listRepositoryBranches` (single
page, `per_page=100`, default branch always included and reported first,
`truncated` set whenever more branches may exist) and
`GitHubClient.getRepositoryMetadataAtBranch`, which resolves a selected branch
to the same `RepositoryMetadata` shape as the default-branch path without ever
overwriting `defaultBranch` with the selection. `core/github/repositoryRef.ts`
defines the shared `RepositoryRefSelection`
(`{ kind: "default" }` or `{ kind: "branch"; name }`) and
`RepositoryRevisionTarget` (`{ repository, ref }`) contracts, plus the branch-name
validator (GitHub's actual grammar, not `[a-zA-Z0-9-]+`: `/` is allowed,
control characters and git's forbidden ref patterns are not) used at every
message boundary. `RepositoryMetadataCache` keys its short-TTL current-ref
cache per `repositoryKey:ref` so the default branch and a selected branch never
read each other's cached HEAD; the analysis cache and known-files loader stay
keyed on the resolved `commitSha`, unchanged. The Side Panel's branch `<select>`
lives in `components/RepositoryAnalysisView.tsx`, resets to the repository's
default branch on GitHub SPA navigation (it remounts on repository identity
change like the rest of that view), and reuses the existing
`AbortController`-per-effect pattern so a rapid branch switch cannot render a
stale response. `entrypoints/sidepanel/App.tsx` keys `PreviewJobPanel` on
`repositoryId:commitSha`, so a branch change that resolves to an unchanged
commit reuses the existing preview identity instead of creating a new one; the
Preview API/worker contract is unchanged and still receives only the resolved
commit SHA, never a branch name.

Repository/application structure detection adds `RepositoryStructure`
(`types/structure.ts`): a bounded `layout` (`single-project`, `workspace`,
`multi-project`, or `unknown`) plus a bounded list of `RepositoryProjectCandidate`
entries, each labeled `project-candidate`, `package-candidate`, or `unknown`
rather than asserting "application" or "library" without evidence.
`core/analyzer/repositoryStructureDetector.ts` is a pure module (workspace
pattern parsing/classification and the final layout/role assembly, no I/O);
`core/github/repositoryStructureLoader.ts` is the bounded loader that performs
the actual GitHub reads through `GitHubClient.getRepositoryDirectoryEntries`
(a new fixed, validated, path-checked operation alongside the existing
`getRepositoryTextFile`) and `GitHubClient.getRepositoryRootEntries`. Discovery
combines declared workspace patterns (`package.json` `workspaces`, a bounded
`pnpm-workspace.yaml` `packages:` subset -- not a YAML parser) with a small,
fixed set of conventional root directory names, split into direct names
(`frontend`, `backend`, `client`, `web`, each probed for its own
package.json) and container names (`apps`, `packages`, never probed
directly but bounded-listed exactly like a declared `dir/*` wildcard so
`apps/web`/`packages/ui` are found even without a workspace declaration,
deduped against the same directory if a wildcard already covers it); only an
exact 1-2 segment literal path or a single-level `dir/*` wildcard is
supported, so depth never exceeds one level of listing beneath the root.
Every read is bounded (at most 8 directory listings -- wildcard and
container parents share this budget --, 200 entries per listing, 20
candidate package.json probes, 512 KB of nested package.json bytes total,
strictly enforced by capping each nested read's byte limit to `min(256 KB,
bytes remaining in the 512 KB budget)` so no single read can push the total
past the bound) and reads `repository.commitSha` -- the same already-resolved
metadata Branch Preview produces, never a mutable branch name. Hitting a
bound sets `truncated: true` instead of hiding it; a failed candidate read or
a failed directory listing sets `complete: false` (an explicit,
loader-computed I/O signal distinct from `truncated`) and continues with the
rest rather than failing the whole analysis. This adds
a `structure` field to `RepositoryAnalysis`. Target selection later moved
`ANALYZER_VERSION` to `0.1.3` and introduced `static-v2`. The Side Panel keeps
the repository Structure section distinct from selected-target Stack and Build
Plan sections. Detecting `frontend`/`backend` is not execution authority; only
an explicitly selected `project-candidate` receives target-scoped analysis,
and the server independently rediscovers and authorizes it at the exact SHA.

Build Adapter generalization adds the explicit `BuildAdapter` registry and
`BuildAdapterResolver` in `core/preview/buildAdapters.ts`. The only registered
adapters are `static-html-v1` and `vite-react-npm-v1`; zero matches is
unsupported and multiple matches are a configuration/programmer error rather
than first-match dispatch. Shape/security validation remains separate from
adapter-owned command and output invariants. Both client planning and
`GitHubPreviewPlanResolver` derive a plan from the registry, while the server
still fetches and analyzes the requested exact commit independently. The
worker pipeline and gVisor boundary remain adapter-independent. Stage 5 extends
the plan through `static-v2`: safe nested `sourceRoot` values are included in
cache/idempotency/UI identity and drive target-local cwd/output resolution.
This does not add Vue/Svelte, pnpm/yarn/bun, shared-root orchestration, or
backends.

Existing deployed-site Live Preview separates three previously conflated
concepts. `repository.homepage` is renamed at the type level to local
deployment *evidence* (`RepositoryAnalysis.deployment.status`:
`"declared" | "configured" | "unknown"`) -- `detectDeployment` no longer
returns `"confirmed"` for a homepage, since a declared homepage is not proof
of a live deployment (this repository's own homepage is a Chrome Web Store
listing, not a deployed app). `analyzeRepository`'s `preview.mode` formula is
fixed so a genuinely buildable target always resolves to
`native-static-build`; local deployment evidence can no longer override
buildability, only serve as the `existing-deployment` fallback label when a
build is not possible. A confirmed live deployment now requires an
independent, bounded GitHub Deployments API lookup:
`GitHubClient.listRepositoryDeployments` (`per_page=10`, one page) and
`GitHubClient.listDeploymentStatuses` (`per_page=30`, one page, at most 5
deployments ever looked up, ranked `production_environment` first, then a
production-like environment name, then everything else) feed the pure
selector in `core/analyzer/liveDeploymentSelector.ts`, which only ever
selects a deployment with a `success` status and a validated, safe HTTPS
`environment_url` (`core/github/externalUrlPolicy.ts`: HTTPS-only scheme
allowlist, no credentials, no loopback/private/link-local/CGNAT IP literal in
IPv4 or IPv6 form, no control characters, bounded length). This result
(`types/deployment.ts`) is deliberately mutable, short-TTL (45s,
`core/github/liveDeploymentCache.ts`) state keyed by repository identity
only -- never folded into the immutable `repositoryId:commitSha:analyzerVersion`
analysis cache, and never compared against a mutable branch name, only the
selected commit SHA. It reaches the Side Panel through its own bounded
background message (`LOAD_REPOSITORY_DEPLOYMENTS`,
`core/github/liveDeploymentMessages.ts`), not a generic fetch/proxy
primitive, and a lookup failure renders its own isolated error text in
`RepositoryAnalysisView`'s new "Deployment" section without affecting
repository analysis or Build Preview. There is still no embedded iframe or
server-side fetch of the deployment URL: "Open live site" is a plain
`target="_blank"` link, exactly like the pre-existing homepage link, and no
manifest permission or CSP changed (the Deployments API is under the
already-permitted `api.github.com` host). Live deployment stays a
repository-level concept; selecting a nested frontend target never implies
the discovered live deployment belongs to that target.

## Fixture Registry

The official Vite + React golden-path fixture is:

```text
repository: The-peephole/peephole-fixture-vite-react
repository id: 1371620276
commit: 4a2c3b78e15d90865ed565c3d38c4045b5a5235f
```

The previous personal-fork fixture identity is obsolete. The current metadata
was merged by PR #6 at
`dba47191bdd3600b3f451945653efab2363028c2`.

The future full-stack fixture is pinned separately:

```text
repository: The-peephole/peephole-fixture-fullstack
commit: eae411a288b212201933cebb206126dd5bb0d93e
```

Its existence is test preparation only. It is not evidence of full-stack
analysis, execution, routing, secrets, or database support. Its
`frontend`/`backend` layout is now exercised as a real repository structure
detection target (both surface as bounded project candidates); this proves
structure detection only, not a runnable full-stack path.

## Change Procedure

1. Read the relevant implementation and its existing tests before designing a
   change.
2. State which current contract changes and which contracts stay unchanged.
3. Add or update focused tests at the closest layer. Add a real fixture test
   only when the feature needs external/toolchain proof.
4. Keep repository support capability-driven. Generalize detectors and adapter
   interfaces before adding a new fixture target.
5. Run formatting, lint, typechecking, portable tests, and the extension build.
6. Run environment-gated tests only in their required environment and report
   them separately.
7. Update living documentation in the same PR without rewriting historical
   release records.

The `Real golden-path build tests` workflow is scheduled and manually
dispatchable CI that uses live GitHub/npm access. A successful run is not a
production smoke. Production smoke is the separate operator-run API and
host-residue gate in `docs/PRODUCTION_SMOKE.md`.

## Completion Standard for New Capabilities

A capability is complete only when the implementation path, UI or API contract,
failure behavior, tests, and documentation agree. A fixture repository, planned
type, analyzer label, or passing fake-adapter test by itself does not establish
production support.
