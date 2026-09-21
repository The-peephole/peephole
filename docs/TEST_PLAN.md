# Test Plan

## 1. Verification Layers

Peephole spans extension, control-plane, execution, and artifact trust zones.
Results from one layer must not be reported as proof of another.

1. **Portable CI** runs formatting, lint, typechecking, portable Vitest suites,
   the extension build, and PostgreSQL integration without a gVisor production
   host.
2. **Real golden-path workflow** fetches pinned public archives and runs the
   real package/build toolchain with live GitHub/npm access. The Vite test in
   this workflow uses the unsandboxed trusted-fixture development adapters.
3. **Real gVisor suites** require a suitable privileged Linux host and exercise
   sandbox, network, disk, cleanup, and end-to-end worker behavior.
4. **Production smoke** targets an already-deployed production instance and
   combines authenticated public API checks with host-local database/resource
   inspection.

Unit tests use fixtures and do not depend on live GitHub APIs. A successful
golden-path workflow is not a production smoke result.

## 2. Current Fixture Registry

Official Vite + React golden path:

```text
repository: The-peephole/peephole-fixture-vite-react
repository id: 1371620276
commit: 4a2c3b78e15d90865ed565c3d38c4045b5a5235f
contract: static-v1
```

PR #6 updated the shared fixture metadata at merge commit
`dba47191bdd3600b3f451945653efab2363028c2`. The manually dispatched
`Real golden-path build tests` workflow succeeded on that `main` revision. The
previous personal-fork repository identity and its old id/SHA are obsolete.

The package-free static golden path currently uses the pinned public
`octocat/Spoon-Knife` commit declared in
`tests/realStaticHtmlGoldenPath.test.ts`.

Future full-stack fixture:

```text
repository: The-peephole/peephole-fixture-fullstack
commit: eae411a288b212201933cebb206126dd5bb0d93e
```

No current test should treat that repository as a supported runtime target.
Full-stack detection, execution, routing, secrets, and databases require their
own later contracts and gates.

## 3. Portable Tests

### GitHub integration

Cover repository URL parsing, reserved routes, idempotent action insertion,
visible target selection, repository/non-repository navigation, Turbo-style DOM
replacement, Side Panel messaging, cancellation, and stale-result rejection.

Theme coverage uses deterministic jsdom fixtures, not live GitHub requests. It
includes Light, Dark, and Dark Dimmed semantic values; missing and malformed
token fallback; focused root mutation observation; repository/theme state
separation; tab-scoped session storage and message validation; SPA navigation;
and Side Panel CSS updates that preserve analysis DOM and the preview iframe.

Manual unpacked-extension verification for a theme-changing release:

- GitHub Light, Dark, and Dark Dimmed: repository action normal, hover,
  focus-visible, disabled, icon-border, and error states;
- each theme: Side Panel text, muted text, borders, status colors, buttons,
  focus indicators, and disabled states;
- with the Side Panel open, switch GitHub theme and confirm the panel updates
  without losing analysis or preview-job state;
- navigate repository A -> repository B, repository -> non-repository, and back
  through GitHub SPA navigation and confirm one action plus the current theme;
- change theme while a preview is ready and confirm the artifact iframe is not
  reloaded or visually forced to the GitHub theme.

### Branch Preview

Deterministic unit/component fixtures, not live GitHub requests, cover:

- default-branch and non-default-branch listing and selection, including
  branch names containing `/`, `.`, `-`, and `_`;
- malformed/empty branch-list API responses and message-boundary rejection
  (`tests/githubClient.test.ts`, `tests/branchMessages.test.ts`,
  `tests/repositoryRef.test.ts`);
- the bounded single-page (`per_page=100`) listing policy and the `truncated`
  flag, with no follow-on pagination;
- branch-to-commit-SHA resolution (`getRepositoryMetadataAtBranch`) without
  `defaultBranch` being overwritten by the selection;
- current-ref cache isolation between the default branch and a selected
  branch, same-branch TTL reuse, post-TTL refresh, and two branches sharing
  one commit-pinned metadata/analysis entry
  (`tests/repositoryMetadataCache.test.ts`,
  `tests/repositoryAnalysisService.test.ts`);
- stale-request abandonment on branch switch and rapid A → B → C selection
  rendering only the final branch's result
  (`tests/RepositoryAnalysisView.test.tsx`);
- a deleted/nonexistent selected branch surfacing an explicit error without
  silently falling back to the default branch, and a branch-list failure not
  blocking the independent default-branch analysis;
- repository SPA navigation resetting branch selection to the new
  repository's default branch;
- preview-job identity staying keyed on `repositoryId:commitSha`, so two
  branches resolving to the same commit share one preview identity while a
  different commit resets it (`tests/branchPreviewIdentity.test.tsx`).

Manual unpacked-extension verification, on a repository with multiple
branches:

- default-branch analysis, then select a non-default branch and confirm the
  displayed commit SHA matches that branch's actual GitHub HEAD;
- confirm the Build preview request targets that resolved SHA (Preview API
  request/network inspection), then switch back to the default branch;
- observe loading and error UI while switching branches, including selecting
  a branch that was since deleted upstream;
- repeat branch selection in GitHub Light, Dark, and Dark Dimmed, including
  switching theme while the branch selector is open, and confirm theme
  synchronization is not regressed;
- navigate GitHub repository A (non-default branch selected) to repository B
  through SPA navigation and confirm B opens on its own default branch;
- close and reopen the Side Panel, and perform rapid repeated branch
  switching, confirming the UI always settles on the last-selected branch's
  result.

### Repository / Application Structure Detection

Deterministic tests split detection logic from GitHub access, per
[Repository analysis](REPOSITORY_ANALYSIS.md#12-repository-structure-detection):

- pure workspace-pattern parsing/classification and layout/role assembly,
  with no GitHub client involved (`tests/repositoryStructureDetector.test.ts`):
  root-only single-project and package-free-static-root layouts;
  `package.json` `workspaces` array and object forms; a bounded
  `pnpm-workspace.yaml` `packages:` list; malformed/unsupported declarations
  producing a warning instead of a guess; `apps/*`-style wildcard versus
  literal-path classification; `..`, absolute, negated, `**`, and
  deeper-than-two-segment patterns rejected as unsupported;
  `project-candidate`/`package-candidate`/`unknown` role classification
  (including `packages/*` staying `package-candidate` even with a frontend
  dependency); malformed nested `package.json` kept as a warning-carrying
  candidate; a failed candidate read marking the result `complete: false`;
  the bounded project-candidate/truncation limits; `apps`/`packages`
  resolving as containers (never a bare literal probe) whether declared as a
  workspace wildcard or only present as a conventional root directory name,
  with the two sources deduping into a single listing; and a directory
  listing failure marking the result `complete: false` (a distinct signal
  from `truncated`, which means a bound was reached by design) while sibling
  candidates from other listings are kept;
- the bounded GitHub loader against a fake client
  (`tests/repositoryStructureLoader.test.ts`): resolving `apps/*` and
  `pnpm-workspace.yaml` patterns by listing exactly the wildcard parent
  directory (never a discovered subdirectory); conventional direct
  `frontend`/`web`/`backend` candidates with no workspace manager present;
  conventional container `apps`/`packages` discovery with no workspace
  manager present, including multiple children, a package-candidate role, and
  a bare `apps`/`packages` directory never itself probed for a package.json;
  candidate dedup between a workspace declaration and a conventional
  directory name (both direct and container); excluding symlink/submodule
  listing entries; the directory listing count (shared across wildcard and
  container parents), per-listing entry count, and candidate-probe count
  bounds; the total nested-byte budget strictly enforced by capping each
  read's byte limit to `min(256 KB, bytes remaining)` -- covering multiple
  reads summing within the budget, a read whose maxBytes reflects the actual
  remaining budget (not the flat per-file cap), a candidate too large for
  what remains failing without crashing, and exhausting the budget skipping
  the next candidate entirely and reporting `truncated: true`; a directory
  listing failure keeping candidates from a sibling listing that succeeded
  while marking the result `complete: false`; and an abort propagating
  instead of being swallowed as a warning;
- `GitHubClient.getRepositoryDirectoryEntries`
  (`tests/githubClient.test.ts`): resolving a nested directory at the
  resolved commit SHA, and rejecting an absolute path, `..` traversal,
  backslash traversal, a trailing slash, an empty segment, and a malformed
  (non-array) response before or without making a request
  (`tests/repositoryPath.test.ts` covers the underlying path validator
  directly);
- Side Panel rendering of the detected layout, project paths, and a
  truncated/incomplete notice (`tests/RepositoryAnalysisView.test.tsx`);
- `analyzeRepository` keeping the existing `AMBIGUOUS_WORKSPACE` blocker and
  root-only `native-static-build` eligibility unchanged while adding the new
  `structure` field, and using a structure-informed blocker message only once
  more than one project candidate is actually found
  (`tests/analyzeRepository.test.ts`).

Spot-checked against real GitHub data (not part of the portable suite): the
official `peephole-fixture-vite-react` golden path keeps its exact prior
`single-project` / `native-static-build` / zero-blocker result, and
`peephole-fixture-fullstack` resolves to `multi-project` with `frontend`
(`project-candidate`) and `backend` (`unknown`) candidates. Its independently
installable `frontend` is supported as a frontend-only target; the backend is
not executed or routed.

Manual unpacked-extension verification:

1. `The-peephole/peephole-fixture-vite-react`: Structure shows layout
   "Single project" and one project path, `.`; branch selection and preview
   build continue to work exactly as before.
2. `The-peephole/peephole-fixture-fullstack`: Structure shows `frontend` and
   `backend`; Preview target offers root and `frontend`, but not `backend`.
   Selecting `frontend` shows React + Vite, npm, `npm ci`, `npm run build`, and
   `dist`; its artifact loads while `/api/hello` may fail because no backend is
   started or routed.
3. A monorepo/workspace fixture (or a deterministic test case): Structure
   shows a workspace marker, candidate project roots, and a truncated or
   incomplete indicator when applicable.

### Existing Deployed-Site Live Preview

Deterministic unit/component fixtures, not live GitHub requests, cover:

- the false-positive fix itself: a declared repository homepage alone is
  `deployment.status: "declared"`, never `"confirmed"`, and never overrides
  `preview.mode: "native-static-build"` for a genuinely buildable target
  (`tests/analyzeRepository.test.ts`);
- `vercel.json`/`netlify.toml` alone remains `"configured"` with `url: null`;
  no evidence stays `"unknown"`;
- `existing-deployment` mode appearing only as the fallback when a build is
  not possible but local evidence exists, and `unsupported` when neither
  applies;
- `GitHubClient.listRepositoryDeployments`/`listDeploymentStatuses`: field
  mapping, the bounded single-page request (`per_page=10` / `per_page=30`,
  never paginated further), `truncated` set when a page comes back full, an
  invalid deployment id rejected before any request, and malformed list
  responses rejected (`tests/githubClient.test.ts`);
- `core/analyzer/liveDeploymentSelector.ts`
  (`tests/liveDeploymentSelector.test.ts`): `production_environment`-first
  and production-like-name ranking with stable tie order; a `success`
  status with a valid URL confirmed; a missing `environment_url`,
  failed/inactive/error/pending/in_progress/queued status, or unsafe URL
  never selected regardless of environment name; zero lookups producing
  `not-detected` with `candidateCount: 0`; the `truncated` flag propagated;
- `core/github/repositoryDeploymentsLoader.ts`
  (`tests/repositoryDeploymentsLoader.test.ts`): zero deployments short-
  circuiting to `not-detected` without any status lookup; picking the most
  recent status by `createdAt` regardless of API response order; bounding
  status lookups to the top `MAX_DEPLOYMENT_STATUS_LOOKUPS` (5) ranked
  deployments and marking `truncated` when more existed; a single
  deployment's failed status lookup degrading to an unknown status without
  failing the whole load; an abort propagating instead of being swallowed;
  the deployment-list `truncated` flag propagating through;
- `core/github/externalUrlPolicy.ts` (`tests/externalUrlPolicy.test.ts`):
  HTTPS accepted, HTTP rejected by default and accepted only with
  `allowHttp`, HTTP still rejected on a private host even with `allowHttp`;
  `javascript:`/`data:`/`file:`/`blob:`/`chrome-extension:` rejected;
  `localhost`/`*.localhost`, `127.0.0.1`, `::1`, RFC 1918 private IPv4
  (`10.x`, `172.16-31.x`, `192.168.x`), link-local IPv4 (`169.254.x`), CGNAT
  IPv4 (`100.64-127.x`), link-local IPv6 (`fe80::/10`), unique-local IPv6
  (`fc00::/7`), and an IPv4-mapped IPv6 loopback literal all rejected; a
  public IPv4 literal accepted; embedded credentials, control characters,
  and an excessively long URL rejected; malformed and non-string input
  rejected;
- `core/github/liveDeploymentCache.ts` (`tests/liveDeploymentCache.test.ts`):
  TTL reuse, case-insensitive repository-identity keying, TTL expiry
  refetch, two repositories in separate entries, a failed lookup not cached,
  and the default TTL falling between 30 and 60 seconds;
- `core/github/liveDeploymentMessages.ts`
  (`tests/liveDeploymentMessages.test.ts`): message validation, a malformed
  request id or repository identity ignored rather than forwarded,
  cancellation aborting the matching background request, GitHub errors
  serialized without leaking unknown-error detail, a malformed response
  rejected instead of forwarded, and abort-triggered cancellation on the
  loader side;
- `RepositoryAnalysisView`'s new "Deployment" section
  (`tests/RepositoryAnalysisView.test.tsx`): the repository homepage
  rendered separately from live-deployment status; a Chrome Web Store (or
  any other) homepage never labeled a confirmed live deployment; a
  confirmed candidate's environment/URL/ref/SHA and its
  matches/differs/unknown comparison against the selected commit; an "Open
  live site" link using safe external navigation
  (`target="_blank"`/`rel="noopener noreferrer"`) with no iframe introduced;
  a deployment lookup failure rendering its own isolated message while
  `Build Preview`/"Native preview compatible" analysis output is unaffected;
  the live deployment lookup not re-firing on a branch change (only the
  comparison text can change); and repository SPA navigation clearing a
  still-in-flight previous repository's deployment response instead of
  leaking it into the new repository's view.

Not covered by the portable suite (documented policy only, since it depends
on live/mutable GitHub deployment state): a real repository with a
publisher-managed live deployment. Manual verification below exercises this
against `The-peephole/peephole` (declared homepage only, no live deployment)
as the false-positive regression case.

Manual unpacked-extension verification:

1. `The-peephole/peephole` (declared homepage only, currently a Chrome Web
   Store listing): Repository homepage shows that link separately; "Live
   deployment" reads "Not detected" and is never labeled confirmed; Build
   Preview behavior is unaffected by this section (unchanged by the WXT
   `UNSUPPORTED_FRAMEWORK` blocker already present before this stage).
2. A public repository with a confirmed GitHub deployment (production
   environment, successful status, `environment_url` set): the Deployment
   section shows environment/URL/ref/SHA and a matches/differs comparison
   against the selected commit; "Open live site" opens a new tab and leaves
   the Side Panel state intact; switching branches updates the comparison
   text without claiming the deployment belongs to the newly selected
   branch, and does not visibly re-run the deployment lookup.
3. A public repository with only a `vercel.json`/`netlify.toml` marker and no
   confirmed deployment: "Deployment configuration detected" appears with no
   fabricated URL.
4. Repository SPA navigation from a repository with a confirmed live
   deployment to one without: no residue of the previous repository's
   deployment URL/state remains visible.
5. GitHub Light, Dark, and Dark Dimmed: the Deployment section remains
   readable in each theme.
6. Simulate (or wait for) a GitHub API rate limit while the Deployment
   section is loading: it shows an isolated "unavailable" message while
   Build Preview and repository analysis remain fully usable.

### Backend Detection + Environment Requirement Analysis

Detection only -- no test in this section may spawn, start, or health-check
a backend process, generate or inject a secret, or rewrite/route a URL.

Deterministic unit fixtures, not live GitHub requests, cover:

- `core/analyzer/backendDetector.ts` (`tests/backendDetector.test.ts`):
  Express/NestJS/Fastify/Koa/`@hapi/hapi`/legacy-`hapi` recognized as strong
  framework evidence; a database dependency (`pg`, et al.) alone creating a
  candidate without inventing a framework; database evidence preserved
  alongside a confirmed framework; a hosted backend client
  (`@supabase/supabase-js`/`firebase`) alone never creating a candidate, and
  recorded as a warning (not framework evidence) when it coexists with a
  real framework; a directory with no package.json never confirmed as
  backend; a frontend-only candidate (react/vite, no backend/database
  dependency) never mislabeled backend; a `start`/`dev` script recorded as
  supporting evidence; a safe `node <path>`-style entrypoint resolved only
  from a narrow grammar, and left null for anything with flags, chaining,
  substitution, an absolute path, or `..` traversal; a malformed nested
  package.json degrading to a warning-carrying candidate instead of
  crashing; conventional directory-name evidence attached only to an
  already-qualifying candidate; root (`.`) and nested (including
  multi-segment, e.g. `apps/api`) source roots preserved; deterministic
  multi-candidate ordering; a candidate's own environment template
  classified and scoped to its `sourceRoot`;
- `core/github/backendCandidateLoader.ts`
  (`tests/backendCandidateLoader.test.ts`): a candidate detected from a
  fetched package.json; a candidate with no package.json reported
  not-detected; an env-template read attached to a qualifying candidate;
  `MAX_BACKEND_CANDIDATES` respected with `truncated: true` beyond it;
  `MAX_BACKEND_ENV_TEMPLATE_READS` respected across candidates; a
  package.json read failure marking `complete: false` (not `truncated`)
  while recording the failure as a warning; a single failed env-template
  read degrading only that candidate's environment evidence without failing
  the whole load; an abort propagating instead of being swallowed; every
  request using a fixed file path, never a directory listing or a wildcard;
- `core/analyzer/environmentRequirements.ts`
  (`tests/environmentRequirements.test.ts`): all four known template names
  parsed; a real `.env`/`.env.local` never read; `export VAR=` syntax;
  comments/blank lines ignored; duplicate variables deterministic;
  deterministic name ordering; `PORT`/`HOST`/`NODE_ENV` -> auto-configurable;
  `JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET`/`CSRF_SECRET` ->
  preview-generated-candidate; `API_KEY`/`TOKEN`/`PAT`/`CLIENT_SECRET`/
  `PRIVATE_KEY` -> user-required + secret-like (including
  `MARKETPLACE_PAT` specifically, to guard the existing portfolio-repository
  regression); `DATABASE_URL`/`POSTGRES_URL`/`MYSQL_URL`/`REDIS_URL`/
  `MONGODB_URI` -> database-requirement, never framed as an auto-provisioned
  database; `VITE_API_URL`/`NEXT_PUBLIC_API_URL` -> client-public
  external-routing-candidate; `VITE_API_TOKEN`/`NEXT_PUBLIC_SECRET`/
  `VITE_PRIVATE_KEY` -> client-public **and** secret-like, with the explicit
  public-prefix-exposes-a-secret warning (never silently trusted as safe);
  an unrecognized name staying `unknown`/`unknown` rather than a guessed
  classification; an ordinary public-prefixed name with no other signal
  classified `public`; no raw template value anywhere in the returned
  result; every requirement tagged with its given `sourceRoot`; two
  different source roots never merging into one result; no template present
  producing an empty result;
- `analyzeRepository`/`RepositoryAnalysisService` merge and isolation
  behavior (`tests/analyzeRepository.test.ts`,
  `tests/repositoryAnalysisService.test.ts`): a root backend detected from
  already-fetched root data with no nested loader involved; not-detected
  reported for a root-only frontend; nested candidates from a separately
  supplied `BackendDetection` merged into `analysis.backend`/
  `analysis.environmentRequirements`, tagged by source root; a buildable
  root frontend's `preview.mode` unaffected by nested backend evidence; an
  incomplete nested backend result not affecting `preview.mode`; root
  environment variables classified into `environmentRequirements`; the same
  variable from the root package.json and the root's own backend
  classification never double-counted; existing `SECRET_ENV_REQUIRED`/
  `BACKEND_REQUIRED` blocker behavior unchanged by the richer models;
  `RepositoryAnalysisService` probing only nested (non-root) structure paths
  for backend evidence; a nested-backend-loader failure not failing
  repository analysis (`preview.mode` unaffected); an abort from the nested
  backend loader propagating instead of being masked; the
  `repositoryId:commitSha:analyzerVersion` cache identity applying to
  backend/environment data too (a branch resolving to the same commit reuses
  the cached result without a second backend probe);
- `RepositoryAnalysisView`'s new "Backend" section and richer "Environment"
  section (`tests/RepositoryAnalysisView.test.tsx`): "No backend detected"
  for an empty result; a detected candidate showing its framework, source
  root, and "Not supported yet" execution status; a backend candidate never
  appearing as a `preview-target` `<select>` option and no
  run/start/build-backend control ever rendered; environment requirements
  grouped and labeled by source root, showing only names and classification
  labels, never a raw value.

Not covered by the portable suite (network-dependent, environment-gated
separately): `tests/realFullStackBackendDetection.test.ts`, gated behind
`PEEPHOLE_REAL_NETWORK_TESTS`, confirms the official
`The-peephole/peephole-fixture-fullstack` fixture's `backend/` directory is
detected as Express while its `frontend/` directory is not misdetected as
backend -- detection only, no execution.

Manual unpacked-extension verification:

1. `The-peephole/peephole-fixture-fullstack`
   (`eae411a288b212201933cebb206126dd5bb0d93e`): Structure shows `frontend`
   and `backend` as before (unchanged from stage 5); the new Backend section
   shows `backend` detected as Express with "Execution: Not supported yet";
   no backend starts, no port is allocated, no `/api/hello` request is made,
   and the frontend static preview continues to work exactly as it did
   before this stage.
2. A public repository with `.env.example` evidence (e.g. a personal
   portfolio repository declaring `MARKETPLACE_PAT=`): the Environment
   section shows `MARKETPLACE_PAT` classified user-required/secret-like;
   Build Preview remains blocked by `SECRET_ENV_REQUIRED` exactly as before
   this stage; no PAT is generated, requested, or stored.
3. A repository with a `PORT`/`JWT_SECRET`/`DATABASE_URL`-style backend
   `.env.example` and a `VITE_API_URL`-style frontend `.env.example`:
   confirm the Environment section groups them under `backend`/`.`
   (or the selected frontend target) separately, with the classifications
   documented above, and no raw value ever visible.
4. GitHub Light, Dark, and Dark Dimmed: the new Backend and Environment
   sections remain readable in each theme.

### Repository analysis

Use bounded file-map fixtures for:

- static HTML and React/Vue/Svelte Vite evidence;
- Next.js, WXT, and non-Vite React blockers;
- TypeScript evidence;
- npm/pnpm/yarn/bun lockfiles and conflicts;
- malformed `package.json` and incomplete known-file reads;
- environment template parsing and secret-like names;
- normalized homepage versus provider-configuration evidence;
- workspace/monorepo ambiguity (the `AMBIGUOUS_WORKSPACE` blocker itself;
  bounded structure candidate discovery is covered separately below);
- current runner gating: static/none and React-Vite/npm accepted, recognized
  but unavailable targets blocked.

Analysis tests must not imply that every recognized framework or package
manager is executable.

### Build Adapter resolution

Cover the exact static and React-Vite-npm matches and plans, no-match behavior
for Vue/Svelte and pnpm/yarn/bun, target-local package locks, blocked analysis,
explicit overlapping-match failure, source-root/output containment, command
mutation, unsupported plan admission, and cache-key separation by source root.
Also cover server candidate authorization and the real full-stack fixture's
frontend-only build without claiming backend or full-stack support.

### Preview control plane

Cover create/status/cancel, authenticated requester ownership, server-side
repository and exact-commit verification, build-plan re-resolution,
idempotency, cache keys, quotas, lifecycle transitions, cancellation races,
expiry, sanitized failures, and inability of the API process to execute a
shell.

PostgreSQL adapter and integration coverage includes parameter binding,
transactions, atomic queue admission, concurrent claiming, leases, retry and
recovery semantics, artifact authorization, and quota rollback. Deployment-
specific database restart/cancellation verification must be reported
separately.

### Worker and artifact boundaries

Portable tests use fake processes or trusted local temporary directories to
cover archive limits, traversal/symlink rejection, output resolution, command
timeouts, cancellation, disk accounting, cleanup, queue behavior, production
composition wiring, origin validation, artifact expiry, MIME/header behavior,
and reaper ownership rules.

The local development worker is unsandboxed. Its passing tests are functional
pipeline evidence, not production isolation evidence.

### Backend runtime (`backend-v1`)

Wholly separate from the static build/worker tests above -- see
docs/PREVIEW_RUNTIME.md's "Backend Runtime (backend-v1)" and D-030.

- `tests/backendRuntimeAdapter.test.ts` (29): every branch of
  `resolveBackendExecutionSupport`/`resolveBackendRuntimePlan` -- framework
  rejection, missing lockfile, unsafe/traversal/absolute/`.ts` entrypoint
  rejection, database rejection, the full environment-requirement-kind
  matrix, the fixed internal port, and no raw `npm start` string anywhere
  in the produced plan.
- `tests/backendRuntimeControlPlane.test.ts` (22): creation, idempotent
  reuse, per-requester quota, ownership isolation (wrong requester gets
  404), full phase progression and invalid-transition rejection,
  cancel-from-queued-vs-running semantics, TTL expiry,
  `shouldContinueRunning`/`isWorkerRuntimeActive` polling semantics, and
  safe error messages that never leak stdout/stderr.
- `tests/backendRuntimeHttp.test.ts` (5): route matching, create-never-
  returns-a-url, get/cancel round trip, malformed body rejection.
- `tests/backendRuntimeApiClient.test.ts` (6): the client-side
  `BackendRuntimeApiClient` -- session/auth handling, response validation
  that ignores an unrecognized field such as a url, and typed error mapping.
- `tests/githubBackendRuntimePlanResolver.test.ts`: exact-commit backend
  authorization accepts confirmed absence only; env/package/lock read errors
  fail closed, aborts propagate, and explicit pnpm/yarn/bun declarations are
  rejected while npm remains accepted.
- `tests/backendRuntimeWorkerLoop.test.ts` (4): lease/renew/acknowledge/
  release, mirroring `previewWorkerLoop.test.ts`'s coverage exactly for the
  separate `BackendRuntimeWorkerLoop`.
- `tests/networkNamespace.test.ts`, `tests/networkOrphanReaper.test.ts`,
  `tests/subnetAllocator.test.ts`, `tests/gvisorAdapter.test.ts`: the new
  `policy: "egress-nat" | "ingress-only"` lease field, `createIngressOnly`'s
  exact firewall rule generation (unconditional egress `DROP`, input
  accepts only `ESTABLISHED,RELATED`, unconditional return `DROP`, no NAT,
  no default route), `expectedRules()`'s policy-aware branching,
  reconciliation/cleanup for a mix of egress-nat and ingress-only leases in
  the same host snapshot, and the two independent per-workspace network
  namespace allocations (egress install vs. ingress-only runtime) never
  colliding in the activation registry -- all against a fake process
  runner, never a real host.
- `tests/backendRuntimeProcess.test.ts` (10): `GVisorBackendRuntimeProcess`
  against a fake `ProcessRunner` and a real local TCP listener standing in
  for the sandboxed process -- readiness success, exit-before-ready,
  readiness timeout, crash detection via `waitForExit`, idempotent `stop()`,
  failed/timed-out/thrown kill with forced-delete attempt,
  and the OCI spec it writes (direct `node <entrypoint>`, only the platform
  environment allowlist, the ingress-only namespace path).
- `tests/backendRuntimeSupervisor.test.ts` (14): the full FETCH -> INSTALL
  -> START -> monitor -> STOP orchestration against fake
  fetcher/sandbox/install-runner/runtime-process-starter dependencies --
  every phase's specific failure code, readiness timeout stopping the
  half-started process, a mid-run crash producing `RUNTIME_EXITED`, TTL
  expiry and explicit cancellation both reaching a clean `stopped` (not
  `failed`) state, a tampered/mismatched queued plan being rejected before
  anything executes, and a recovered non-queued runtime never being started
  twice. This suite also caught and fixed a real deadlock (the monitoring
  loop's own cleanup awaited the very exit signal that only a caller-level
  `stop()` could ever produce) -- see D-030's implementation notes.
- `tests/RepositoryAnalysisView.test.tsx`: a qualifying candidate shows
  "Supported (express-node-npm-v1)" and calls the new
  `renderBackendRuntimeControls` render prop; a non-qualifying candidate is
  unchanged ("Not supported yet"); still never a preview-target option.

Not yet portable-tested: `BackendRuntimeSupervisor`/`GVisorBackendRuntimeProcess`
against a *real* gVisor sandbox (see section 5), and the composition
function `composeProductionBackendRuntime` end to end (it is not wired into
production `main()` in this change).

## 4. Live-Network Golden Paths

With `PEEPHOLE_REAL_NETWORK_TESTS=1`, exercise:

- pinned static HTML archive fetch and publication;
- the official Vite + React fixture through real `npm ci`, `npm run build`,
  output resolution, and publication;
- the pinned full-stack fixture through server-side root reanalysis, confirming
  that no Build Adapter matches and no nested target is selected.

The scheduled/manual `.github/workflows/golden-path.yml` workflow provides this
environment. It does not have production credentials or host visibility and
must not be described as production smoke.

New frontend targets require an independently pinned first-party fixture only
after repository/application detection and Build Adapter generalization define
a non-fixture-specific contract.

## 5. Real gVisor Verification

With `PEEPHOLE_REAL_GVISOR_TESTS=1` on the documented Linux environment, verify
the applicable production claims, including:

- non-root identity and read-only-root behavior;
- process, CPU, memory, workspace disk, temporary storage, output, and time
  limits;
- network namespace allocation, DNS behavior, public install egress, blocked
  private/link-local/metadata/host/inter-job destinations, and no build egress;
- cross-job filesystem/network isolation;
- cancellation plus abandoned runsc/network/disk reconciliation;
- the Vite + React job through real gVisor, npm, build, and publication.

The dedicated `realGvisorMaliciousScript` suite exists but its production-like
AWS run remains a separate unchecked gate. Do not promote its assertions to a
recorded production result until that run is completed and retained.

The `backend-v1` ingress-only network policy (`VethNatNetworkProvisioner
.createIngressOnly`, the `policy` field on `NetworkLease`) has full portable
coverage (see section 3) but has **not** been exercised against a real
gVisor/Linux host by this change -- there was no such host available. Before
`composeProductionBackendRuntime` is wired into production `main()`, verify
on a real host: the sandbox can accept a host-initiated TCP connection with
zero firewall exceptions added, the sandbox cannot reach the public
internet/host services/metadata/another job's namespace/the control plane,
`GVisorBackendRuntimeProcess.stop()` actually terminates the sandboxed
process (not just the local `runsc run` CLI), and a worker restart with a
live `running`/`starting` runtime is correctly reaped as stale on the next
startup reconciliation.

### Production-host safety for privileged real-gVisor suites

Privileged real-gVisor tests that create or reconcile Peephole host resources
must not run concurrently with live production preview workloads on the same
host.

This includes tests that may create or mutate:

- `peephole-*` network namespaces;
- `veph*` / `vpph*` veth interfaces;
- `ppe*` / `ppi*` / `ppr*` iptables chains or hooks;
- runsc containers;
- network lease markers;
- Peephole-owned bundle, mount, loop-device, or workspace resources.

`NetworkOrphanReaper` deliberately fails closed when it encounters a
Peephole-shaped network resource whose ownership cannot be proven from the
current lease set. Such a resource must not be treated as safe to delete
automatically.

Before running an orphan/reconciliation real-gVisor suite on a
production-like host:

1. require the host to be quiescent, with no live preview workload;
2. record the current Peephole runsc, network, firewall, lease, and disk
   resource baseline;
3. run the privileged suite only after that baseline is clean;
4. after the suite, require zero unexpected Peephole-shaped residue;
5. if a failed test leaves residue, preserve the failed result rather than
   deleting the residue merely to obtain a passing test result.

If test-created residue prevents the production service from starting,
ownership and liveness must first be established before manual recovery.
Such cleanup is incident recovery and does not convert the failed test into a
passing result.

During the 2026-09-21 M9 production verification, an orphan-reconciliation
backend test was initially run while a live FullStackPreview network namespace
was present. The test reaper failed closed on that unrelated live namespace
before cleaning its own test-created resources. The remaining test resource
then caused the next production startup reconciliation to fail closed.

After incident recovery, the same `tests/realBackendRuntime.test.ts` suite was
rerun from a clean, quiescent host and passed 2/2 with no runsc, network, or
iptables residue.

## 6. Failure and Security Cases

Maintain coverage for missing/conflicting lockfiles, malformed manifests,
unsupported runner targets, install/build/publish failure, oversized archives
or outputs, too many files, unsafe paths, timeout, cancellation, worker crash,
artifact expiry, GitHub failure/rate limiting, and stale navigation results.

Security tests should verify only the controls present in the relevant
environment. Do not infer host isolation from a fake command runner or infer
registry-only egress from the current public-egress deny rules. User-visible
diagnostics must remain bounded and must not expose credentials, internal paths,
or secret values.

## 7. Production Smoke

Follow [Production smoke verification](PRODUCTION_SMOKE.md) for the operator
gate. The API half authenticates through the normal Peephole session, creates a
job for the pinned Vite fixture, validates the artifact, and checks a cache hit.

The host half verifies service/readiness state, queue quiescence, known error
logs, and absence of owned runsc/network/disk residue.

Record the deployed revision, command outputs, and job identifiers. Do not
claim a production-smoke pass from the successful `main` golden-path Action.

Production smoke and privileged real-gVisor mutation tests are separate gates.
Do not run orphan/reconciliation real-gVisor suites concurrently with
production smoke or live preview workloads on the same host. Privileged
host-mutation suites require a quiescent test window and a clean resource
baseline.

## 8. Roadmap Test Expansion

Add coverage in the same order as product development:

1. GitHub light/dark/dimmed theme synchronization and navigation changes (implemented)
2. branch selection, immutable resolution, stale branch movement, and cache keys (implemented)
3. repository/application structure fixtures (implemented)
4. generalized Build Adapter contract tests (implemented)
5. frontend target/monorepo selection and isolation (implemented)
6. existing deployed-site Live Preview: deployment evidence hierarchy, bounded
   GitHub Deployments API discovery, URL safety, mutable cache, and
   comparison/navigation policy (implemented)
7. backend detection evidence and false positives, plus environment
   requirement classification, bounded discovery, and failure isolation
   (implemented)
8. backend process lifecycle and isolation -- adapter/plan matching, plan
   re-validation, control plane lifecycle/ownership/quota, the gVisor
   runtime process primitive, ingress-only network policy generation and
   reconciliation, and supervisor orchestration are all covered by portable
   tests (implemented); real-gVisor-host verification of the ingress-only
   network policy specifically is not yet done -- see section 5
9. frontend/backend routing and cross-origin policy
10. ephemeral secret redaction, scope, and teardown
11. temporary database tenancy, credentials, lifecycle, and cleanup

The full-stack fixture becomes eligible for these tests only as each required
contract is actually implemented.
