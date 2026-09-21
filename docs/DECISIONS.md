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

## D-023 - A single-process local development launcher stands in for a deployed Preview API/worker, with a loopback-only artifact host in place of a preview domain

**Status:** Accepted

`services/local-preview/devServer.ts` composes the real (non-fake)
Postgres-backed control plane (`composePostgresControlPlane`), a worker loop
running the same unsandboxed adapters as the golden-path tests
(`composeLocalDevWorker` -- `LocalDevSandboxProvisioner`/`HostCommandRunner`,
per D-019), and a new `LocalArtifactHost`
(`services/local-preview/artifactHost.ts`) into one Node process, run with
`npm run dev:preview-server`.

`LocalArtifactHost` binds a fresh `127.0.0.1` TCP port -- and therefore a
fresh origin -- per published artifact, since D-016's registrable preview
domain does not exist yet. It sets `cache-control: no-store`,
`x-content-type-options: nosniff`, a locked-down `permissions-policy`,
rejects path traversal/symlinks, and returns HTTP 410 once the artifact's
signed expiry passes. The Chrome side panel embeds a `ready` job's artifact
in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin
allow-forms"`) only when its URL passes
`core/preview/config.ts#isTrustedPreviewArtifactUrl` (loopback HTTP only),
and the extension's own manifest CSP additionally restricts `frame-src` to
`http://127.0.0.1:*`.

This is deliberately **not** a preview of the production architecture:
`devServer.ts`'s `resolveRequester` returns one fixed identity for every
request (no authentication), and the worker has no sandbox, network
restriction, or resource limit (this environment has no Linux kernel to run
gVisor against, per D-018). Consequently this launcher must only ever build
repositories the operator already trusts, on their own machine -- it is a
development tool for proving the fetch -> build -> serve -> embed path end
to end (verified against real GitHub repositories through a real unpacked
Chrome extension), not a step toward relaxing D-013's isolation requirement.

## D-024 - GitHub token: client-side storage only, never a `WXT_` build variable

**Status:** Superseded by D-025

Unauthenticated GitHub REST calls are capped at 60 requests/hour per IP.
Peephole's own design intentionally doubles that cost per `Build preview`
click: the side panel analyzes a repository, and the control plane
independently re-fetches and re-validates the same repository server-side
before scheduling a job (see the Preview Control Plane security
requirements) rather than trusting the client's analysis. A token (no
scopes required for public repositories) raises the limit to 5,000/hour and
is worth supporting even though v0.1 has no user-account model.

Any `WXT_`-prefixed environment variable is compiled directly into the
built extension bundle and is trivially readable by anyone who unpacks it
(see the existing warning in `.env.example`/`core/preview/config.ts`), so a
personal access token must never be one. Instead:

- **Client:** an options page (`entrypoints/options/`) writes the token to
  `chrome.storage.local` (`core/github/tokenStorage.ts`) -- local to the
  browser profile, never synced, never bundled. `GitHubClient` accepts a
  `getToken` hook (`core/github/client.ts`) resolved fresh on every request
  so a token saved after the background service worker starts still takes
  effect, and attaches it as `Authorization: Bearer <token>` only when
  present.
- **Server:** `services/local-preview/devServer.ts` reads
  `PEEPHOLE_GITHUB_TOKEN` from the Node process environment
  (`.env.local`/deployment secrets), never from a `WXT_` variable, and
  passes it to its own `GitHubClient` instance through the same hook.

The token is never logged (see "Never log credentials or secret-like
values" in `docs/IMPLEMENTATION_CHECKLIST.md`). This was the original PAT
design and remains here as decision history only. D-025 removes end-user PAT
storage and input entirely.

## D-025 - GitHub App identity with ephemeral Peephole access sessions

**Status:** Accepted

End users authenticate with a GitHub App web flow instead of creating or
pasting a personal access token. The Preview API owns the GitHub App Client
Secret and exchanges the one-time authorization code server-side. It uses the
resulting GitHub user access token only for `GET /user`, derives requester
subject `github:<id>`, and discards the token. The existing
`PreviewSessionIssuer` and `PreviewSessionAuth` remain the access-session
boundary for all preview routes.

The extension generates a nonce and PKCE verifier, launches the browser auth
flow, verifies the returned nonce, and stores only the 30-minute Peephole
access session in `browser.storage.session`. It never stores a GitHub access
token, Client Secret, App private key, or session-signing secret. Any legacy
`peepholeGithubToken` value is removed from `browser.storage.local`.

The server accepts extension callback URLs only when the extension ID is in
`PEEPHOLE_ALLOWED_EXTENSION_IDS` and the URL is exactly
`https://<allowed-extension-id>.chromiumapp.org/github`. The HMAC-signed,
short-lived state binds that redirect URL, the extension nonce, and the PKCE
challenge. The callback never trusts an unsigned client redirect target.

This milestone intentionally uses reconnect-on-expiry rather than a long-lived
refresh bearer in persistent extension storage. A secure refresh design needs
server-side revocation state, hashed opaque refresh-token storage, rotation,
and reuse detection; it is kept as a separable follow-up instead of weakening
the new credential-storage rule. See `docs/GITHUB_APP_AUTH.md`.

The GitHub App is identity-only. Public repository fetching and every preview
job, worker, gVisor, artifact, and cache contract remain unchanged. Private
repository support with Installation Access Tokens is a separate future scope.

## D-026 - Preserve the static-preview foundation and expand through ordered contracts

**Status:** Accepted

The current production capability remains the D-021 execution set:
package-free static HTML and root-level Vite + React on npm. Analyzer recognition
of Vue/Svelte, other package managers, backend dependencies, or workspaces does
not make those targets executable. This note clarifies the broader aspirational
wording in D-014 without rewriting that historical decision.

Product expansion proceeds in this order:

1. GitHub theme synchronization
2. Branch Preview
3. Repository / application structure detection
4. Build Adapter generalization
5. frontend target selection / frontend monorepo support
6. existing deployed-site Live Preview
7. backend detection
8. backend execution
9. frontend ↔ backend routing
10. ephemeral env / secrets
11. temporary database support

The order exists to establish immutable source selection, application structure,
and generalized build contracts before adding long-lived or composed runtime
resources. Each stage must preserve the existing Preview Control Plane,
server-side plan verification, gVisor/resource boundaries, artifact-origin
isolation, and recovery behavior. A new fixture must exercise a general
contract; production code must not dispatch on fixture repository identity.

The official Vite + React golden fixture is repository id `1371620276`,
`The-peephole/peephole-fixture-vite-react` at
`4a2c3b78e15d90865ed565c3d38c4045b5a5235f`. PR #6 merged this metadata in
`dba47191bdd3600b3f451945653efab2363028c2`; the subsequent manually dispatched
`Real golden-path build tests` run on `main` succeeded. That result is
live-network CI, not production smoke.

`The-peephole/peephole-fixture-fullstack` at
`eae411a288b212201933cebb206126dd5bb0d93e` is reserved for future stages. Its
existence does not establish backend detection, backend execution, routing,
ephemeral secrets, or temporary database support.

## D-027 - Version nested frontend targets as static-v2

**Status:** Accepted

Frontend target selection expands real execution semantics, so it does not
silently broaden `static-v1`. Legacy `static-v1` remains root-only: its request
must omit `target`, which the server interprets as `sourceRoot: "."`.
`static-v2` requires an explicit `{ sourceRoot }` target and permits either the
root or a normalized repository-relative POSIX directory.

The extension discovers bounded project candidates, but discovery is not
authorization. After selection, it performs a separate target-scoped analysis
at the resolved commit. On job creation the server independently verifies the
repository and exact SHA, repeats bounded structure discovery, confirms the
requested path is a non-root `project-candidate`, reloads target-local known
files, reruns analysis, and reconstructs the plan through the server-owned
Build Adapter registry. Client commands, package manager, adapter, and output
directory are never authoritative.

The only new nested execution contract is an independently installable React +
Vite + npm target containing both `package.json` and `package-lock.json`.
`npm ci` and `npm run build` execute with that target as cwd, and only
`sourceRoot/outputDirectory` is published. Shared-root npm workspaces,
pnpm/yarn/bun, Turbo/Nx orchestration, Vue/Svelte, SSR, backends, routing,
secrets, and databases remain outside this contract.

Source roots participate in target-analysis caches, build cache keys,
idempotency fingerprints, and React preview component identity. The extension
stores no preview-job session; its existing browser session is authentication
only and remains user-scoped. Worker path resolution validates lexical
containment, rejects symbolic-link path segments, and verifies realpath
containment before install/output access. Existing archive extraction already
rejects symlinks and hard links.

The full-stack fixture's `frontend` directory is the golden nested target. A
successful static frontend build is not a full-stack preview: its `/api/hello`
request may fail because the backend is intentionally not started or routed.

## D-028 - Live Deployment is separate, mutable, evidence-graded state; never an embedded iframe or proxy

**Status:** Accepted

`deploymentDetector.ts` previously treated any `repository.homepage` as
`status: "confirmed"`, and `analyzeRepository.ts` let that status override
`preview.mode` even for a genuinely buildable target -- hiding Build Preview
for any repository with a homepage set, regardless of whether it was
buildable, and regardless of whether the homepage was actually a deployed
application (this repository's own homepage is a Chrome Web Store listing,
not a deployed app). Both problems are fixed:

- `RepositoryAnalysis.deployment.status` drops `"confirmed"` entirely, in
  favor of `"declared"` (homepage) / `"configured"` (provider config,
  unchanged) / `"unknown"`. Neither value is proof of a live deployment.
- `analyzeRepository`'s `preview.mode` formula now checks buildability first:
  `native-static-build` whenever the target has no blockers, regardless of
  deployment evidence; `existing-deployment` only as the fallback label when
  a build is not possible but local evidence exists; `unsupported` otherwise.
- `ANALYZER_VERSION` bumps `0.1.3` -> `0.1.4` for this schema/semantic change.

A real confirmed live deployment now requires an independent, bounded GitHub
Deployments API lookup: `GitHubClient.listRepositoryDeployments` (`per_page=10`,
one page, no further pagination) and `GitHubClient.listDeploymentStatuses`
(`per_page=30`, one page, at most `MAX_DEPLOYMENT_STATUS_LOOKUPS`=5
deployments ever checked). The pure selector
(`core/analyzer/liveDeploymentSelector.ts`) ranks `production_environment`
deployments first, then a production-like environment name, then everything
else, and only ever selects a deployment whose most recent status is
`success` and whose `environment_url` passes the shared safety validator
(`core/github/externalUrlPolicy.ts`: HTTPS-only for this path, no
credentials, no loopback/private/link-local/CGNAT IPv4 or IPv6 literal, no
control characters, bounded length; `localhost`/GitHub Pages-style
local-development hosts are not special-cased in). Hitting either bound sets
`truncated` rather than hiding it; a per-deployment status-lookup failure
degrades that one deployment to an unknown status instead of failing the
whole lookup.

This result (`types/deployment.ts`) is deliberately mutable and short-TTL
(45 seconds, `core/github/liveDeploymentCache.ts`), keyed by repository
identity alone -- never by commit SHA or branch, and never folded into the
immutable `repositoryId:commitSha:analyzerVersion` analysis cache, since a
repository's live deployment can change independently of any analyzed
commit. It reaches the Side Panel through its own fixed, bounded background
message (`LOAD_REPOSITORY_DEPLOYMENTS`,
`core/github/liveDeploymentMessages.ts`) mirroring the existing
`branchMessages.ts` contract -- not a generic `FETCH_URL`/proxy primitive. A
lookup failure (rate limit, network, malformed response) is surfaced as a
rejected loader promise / message error and renders as an isolated message in
the new "Deployment" section of `RepositoryAnalysisView`; it never fails
repository analysis or disables Build Preview.

The live deployment's reported `sha` (when present) is compared against the
currently selected preview commit for display only ("Matches selected
commit" / "Deployment commit differs from selected preview commit" /
"Deployment commit unknown") -- never as a build-correctness signal, and
never assumed to be the default branch HEAD when absent. Selecting a
different branch changes which commit this comparison runs against but never
re-triggers the deployment lookup itself, and the live deployment is never
described as belonging to a selected nested frontend target -- it is
reported as the repository's own live deployment.

Peephole does not fetch, proxy, or embed the deployment's HTML: "Open live
site" is a plain `target="_blank"` anchor to the validated URL, exactly like
the pre-existing homepage link. No `services/preview-api/` endpoint fetches
an arbitrary URL, no server-side screenshot/HTML-proxy service was added, and
no manifest permission or CSP changed -- the Deployments API is reached
through the already-permitted `api.github.com` host via the existing
background-owned `GitHubClient`, per D-003's content-script restriction.
Backend detection, execution, routing, secrets, and database support (roadmap
stages 7-11) remain untouched by this decision.

## D-029 - Backend detection and environment requirement analysis are read-only classification, layered onto existing bounded discovery

**Status:** Accepted

Backend detection reuses the repository/application structure detection
architecture rather than adding a second crawler. The repository root's own
backend evidence is classified in `analyzeRepository.ts` directly from data
already fetched for the rest of analysis (zero extra GitHub requests).
Nested candidates come only from paths `RepositoryStructure.projects`
already discovered -- no new directory listing, no fresh crawl -- and are
probed by a new bounded loader, `core/github/backendCandidateLoader.ts`:
`MAX_BACKEND_CANDIDATES` = 5 nested paths, each a direct fixed-path fetch of
`{path}/package.json` (the same fixed `GitHubClient.getRepositoryTextFile`
operation structure detection itself uses to probe a candidate, never a
directory listing) plus up to two `{path}/.env.*` template names, bounded
overall by `MAX_BACKEND_ENV_TEMPLATE_READS` = 10 and
`MAX_BACKEND_TOTAL_BYTES` = 512 KB (matching structure detection's own total
byte bound for a comparably small candidate set). Hitting a bound sets
`truncated`; a candidate's read failure sets `complete: false` without
failing sibling candidates; `RepositoryAnalysisService` wraps the whole
nested-backend call so its failure (anything but an abort) degrades to an
"unavailable" `BackendDetection` instead of failing repository analysis or
disabling Build Preview for the already-working frontend path.

The evidence model (`core/analyzer/backendDetector.ts`,
`types/backend.ts`) is deliberately conservative: a candidate requires
either a recognized backend framework dependency (`express`, `@nestjs/core`,
`fastify`, `koa`, `@hapi/hapi`, and the legacy unscoped `hapi` package name
-- an improvement over `analyzeBuildTarget.ts`'s `SERVER_DEPENDENCIES`,
which only recognizes the legacy name, without changing that blocker's
behavior) or a database/server-side dependency
(`@prisma/client`/`prisma`/`pg`/`mysql2`/`mongoose`/`better-sqlite3`, which
alone never claims a specific framework). A directory name
(`backend`/`server`/`api`) is only ever supporting evidence text on an
already-qualifying candidate, never sufficient by itself. A hosted backend
client (`@supabase/supabase-js`/`firebase`/`aws-amplify`) alone never
creates a candidate -- on a qualifying candidate it is recorded as a warning
distinguishing it from local backend evidence. A textually-derived
`entrypoint` (from a narrow, safe `node <path>`-style start/dev script
grammar with no flags, chaining, substitution, or traversal) is never
verified to exist on GitHub; verifying it would cost one more request per
candidate for marginal value at a detection-only stage, so it is explicitly
labeled unverified evidence instead.

Environment requirement analysis (`core/analyzer/environmentRequirements.ts`,
`types/environment.ts`) is additive to the existing `environmentDetector.ts`:
it reads the same bounded `.env.example`-family templates
(`core/analyzer/envTemplateFiles.ts` is now the single shared filename list)
and classifies declared variable *names* only -- never a value, never a real
`.env`/`.env.local` file -- into `exposure`, `requirementKind`
(`auto-configurable`/`preview-generated-candidate`/`database-requirement`/
`external-routing-candidate`/`user-required`/`unknown`), and `sensitivity`.
None of these classifications are acted on in this stage: nothing is
generated, injected, stored, or requested from a user. A client-public
prefix never overrides a secret-like name -- `VITE_API_TOKEN`/
`NEXT_PUBLIC_SECRET`/`VITE_PRIVATE_KEY` stay `sensitivity: "secret-like"`
with an explicit warning. `RepositoryAnalysis`/`BuildTargetAnalysis` gain
`environmentRequirements` alongside the pre-existing `environment` field,
which keeps governing `SECRET_ENV_REQUIRED` exactly as before -- a
repository whose `.env.example` declares `MARKETPLACE_PAT` still blocks
Build Preview identically to before this stage.

`ANALYZER_VERSION` bumps `0.1.4` -> `0.1.5` (new `backend`/
`environmentRequirements` fields) and `TARGET_ANALYZER_VERSION` bumps
`0.1.0` -> `0.1.1` (new `environmentRequirements` field). `static-v1`/
`static-v2`/`BuildPlan`, `core/preview/buildAdapters.ts`'s registry (still
only `static-html-v1`/`vite-react-npm-v1`), the Preview API, and the
worker/gVisor pipeline are all unchanged. A `BackendCandidate` is never
selectable as a preview target and never gains a build/run control. Backend
execution, frontend/backend routing, ephemeral secret/env provisioning, and
temporary database support (roadmap stages 8-11) remain untouched and
unstarted by this decision.

**Update:** the first implementation of `detectBackendCandidate` returned a
degraded-but-present candidate (`framework: "unknown"`) for a
malformed-but-present package.json, mirroring
`repositoryStructureDetector.ts`'s treatment of the same case for frontend
structure. This was a false-positive: it let a single unparseable
package.json alone produce "Backend detected, framework: Unrecognized
framework" with zero actual evidence. Fixed so `detectBackendCandidate`
never fabricates a candidate for a parse failure -- it receives
`packageJson: null` for both "absent" and "malformed" input and returns
`null` either way; the caller records `backendPackageJsonParseWarning` in
`BackendDetection.warnings` and sets `complete: false` instead, while
sibling candidates are still probed and reported normally, and a real,
successfully-parsed database/server-only dependency still yields a valid
`framework: "unknown"` candidate exactly as before.

**Second update:** `BackendCandidateLoader`'s env-template read caught a
non-abort error and silently discarded it -- the candidate was still
reported (correct), but nothing recorded that a bounded read had failed, so
`BackendDetection.complete` could stay `true` even though
`backend/.env.example` (say) failed with a rate limit. This broke
`complete`'s contract: a bounded read failing must always be reflected, not
just a package.json read failing. Fixed so an env-template request failure
(not a parse issue -- there is no env-template "parse", only a raw text
read) now also pushes a warning naming the exact path
(`{sourceRoot}/{templateName} could not be inspected: <message>`) and sets
`complete: false`, while the candidate itself is kept with whatever env
evidence it did manage to read, sibling candidates are still probed, and an
abort still propagates instead of being caught. `truncated` is untouched by
this -- a read failure and a bound being reached remain distinct signals,
exactly as elsewhere in this codebase.

## D-030 - Backend runtime (`backend-v1`) is a wholly separate, narrow, ingress-only execution contract -- never an extension of the static build pipeline

**Status:** Accepted

Section 13 of `docs/PREVIEW_RUNTIME.md` warned against extending the static
worker "by simply leaving the build container running." This decision is
that separate contract. `backend-v1` (`types/backendRuntime.ts`) has its own
version namespace, its own control plane (`services/backend-runtime-api/`,
a `POST/GET/DELETE /v1/backend-runtimes` resource, never the existing
`PreviewJob`/`BuildPlan` resource), its own worker orchestration
(`services/backend-runtime-worker/BackendRuntimeSupervisor`, a FETCH ->
INSTALL -> START -> monitor -> STOP sequence, never
`PreviewJobWorker.runPipeline`), and its own lifecycle state machine
(`queued/fetching/installing/starting/running/stopping` plus the terminal
`stopped/failed/cancelled/expired`). `static-v1`/`static-v2`/`BuildPlan`, the
static artifact cache, artifact publication, and M7's own backend
detection/environment classification are untouched.

The only implemented adapter, `express-node-npm-v1`
(`core/analyzer/backendRuntimeAdapter.ts`), is deliberately as narrow as the
static adapters were at v0.1: Express only, npm with a required
`package-lock.json`, zero database dependencies, and every environment
requirement classified `auto-configurable` (`PORT`/`HOST`/`NODE_ENV` only --
M7's own classifier already scopes this exactly). It never executes `npm
start`, a shell, or any client-supplied command: the analyzer extracts a
safe, structurally-derived entrypoint and the runtime always executes `node
<entrypoint>` directly, restricted further than M7's own detector to
`.js`/`.mjs`/`.cjs` (rejecting `.ts`/`.mts`/`.cts`, since nothing here ever
runs `ts-node`/`tsx`). A client may request only repository identity, the
exact commit, and an optional `sourceRoot` hint; `GitHubBackendRuntimePlanResolver`
independently re-fetches package.json/lockfile/env-templates at that exact
commit and reconstructs the entire plan itself, mirroring
`GitHubPreviewPlanResolver`'s exact-commit revalidation shape for the static
contract. `BackendRuntimeSupervisor` re-validates the queued plan a second
time (`core/preview/backendRuntimePlanValidator.ts`) against an exact
allowlist before ever executing anything, independent of whether the queue
or store can be trusted.

**The runtime process primitive is new, not a repurposed
`RunscCommandRunner`.** `runsc run` is a foreground, blocking CLI invocation
with no "start in the background" flag; `RunscCommandRunner` is explicitly a
"fire one command, wait for exit, delete the container" primitive used by
`npm ci`/`npm run build`, and stays exactly that. `GVisorBackendRuntimeProcess`
(`services/preview-worker/gvisor/backendRuntimeProcess.ts`) fires the same
`runsc run` invocation without awaiting its completion, exposes
`start()/waitUntilReady()/waitForExit()/stop()`, and stops a running
container the same sanctioned way `RunscCommandRunner`'s own disk-quota
watcher and `GVisorSandboxProvisioner.destroy()` already do -- a separate
`runsc kill` then `runsc delete`, never an OS-level signal to the local
`runsc run` process. Readiness is a bare TCP connect to the sandbox's
internal port from the host's own root network namespace, polled with
bounded exponential backoff; an application route such as `/health` is
never a generic contract requirement (the fixture happens to have one, used
only in an environment-gated real-host test, never exposed as an API).

**Network policy is the core security boundary of this stage, and it
surfaced a real conflict with existing crash-safety code.**
`NetworkOrphanReaper.expectedRules()` hardcoded one firewall-rule shape
(DNS-accept + blocklist-drop + default-accept egress, NAT/MASQUERADE) and
`validateSnapshot()` throws on any lease whose actual rules don't match it
-- during both normal cleanup and startup reconciliation. A differently
configured "ingress-only" lease would have made that validator fail-close on
exactly the lease it should clean up. The fix is additive: `NetworkLease`/
`NetworkLeaseMarker` (`subnetAllocator.ts`) gained an immutable `policy:
"egress-nat" | "ingress-only"` field, set once at `allocate()` time and
never mutated in place (a lease's policy cannot transition mid-lifetime --
install and runtime phases get two independent leases, each with a distinct,
randomly generated allocation id, so they can coexist without colliding in
`NetworkAllocationRegistry`'s per-id activation guard); every existing
egress-nat call site passes `policy: "egress-nat"` explicitly, byte-for-byte
unchanged. Pre-backend version-1 markers without `policy` remain accepted only
as the old `egress-nat` shape; newly written markers always persist policy,
and an unknown value remains invalid. `VethNatNetworkProvisioner.createIngressOnly()` is a new, separate
method (not a branch inside the existing `create()`) that configures no
NAT/MASQUERADE and no default route, an egress chain that unconditionally
`DROP`s, an input chain that accepts only `ESTABLISHED,RELATED` replies
(the trusted readiness/proxy probe's return traffic) before dropping
everything else, and a return chain that unconditionally `DROP`s (nothing
should ever be forwarded into this namespace from elsewhere). The FORWARD/
INPUT hook shape into the root namespace's chains is identical to the
egress-nat policy, so `NetworkOrphanReaper`'s cleanup/reconciliation code
needed no change beyond making `expectedRules()` branch on `lease.policy`
for the chain *contents*.

A host-side trusted process (the readiness probe today; a future ingress
proxy) can already reach the sandbox's assigned port with **zero** firewall
exceptions: a connection from a process in the host's root network namespace
to the sandbox's directly-connected veth-peer address is locally generated
`OUTPUT` traffic delivered straight over the veth link, not `FORWARD`ed
traffic -- it never touches either namespace's `FORWARD` chain regardless of
policy. Only the sandbox's own *outbound* traffic needed new policy work.
This is why "ingress allowed, egress denied" was achievable without any
`network=host`, wildcard proxy, or public hostname.

**Explicitly not implemented in this change**, all deferred to their own
future roadmap stages: any public backend URL/hostname/proxy (the API and
UI can only ever say "Running", never a location), frontend-to-backend
routing or rewriting, ephemeral env/secret provisioning beyond the fixed
`PORT`/`HOST`/`NODE_ENV`, and temporary/provisioned application databases
(a `backend_runtime_jobs`-shaped table in Peephole's own control-plane
Postgres is permitted infrastructure for this stage's persistence, but is
unrelated to and must never be confused with future *repository*
database provisioning).

**Known limitations, disclosed rather than worked around:** persistence in
this change is in-memory only (`InMemoryBackendRuntimeStore`/
`InMemoryBackendRuntimeQueue`); a durable Postgres-backed store is future
work, same shape as the static path's. The ingress-only network policy has
full unit coverage (rule generation, reconciliation, and cleanup, all
against a fake process runner) but has not been exercised against a real
gVisor/Linux host -- this session has no such host available. Nothing in
this stage is wired into `services/production/server.ts`'s `main()`; a
`composeProductionBackendRuntime` composition function exists but is
intentionally not called from production startup until the network policy
is verified against a real host. A live disk-quota watcher during the
*running* phase (as opposed to install) is not implemented; the sandbox's
own hard ext4 quota remains the non-bypassable backstop, matching how disk
limits are already enforced everywhere else in this codebase.

## D-031 - Full-stack preview orchestration uses a durable parent and a unique same-origin route

**Status:** Accepted

`fullstack-v1` owns a durable parent row and queue delivery that coordinate,
but do not merge, the existing static preview and `backend-v1` lifecycles.
Public admission spends the existing preview quota exactly once while the
real requester IP is present. Only the requester subject is persisted. The
worker uses private subject-owned child operations: static child creation
revalidates the build plan and uses the normal cache/store/queue/signing path
without spending quota again; backend child creation revalidates its plan and
uses the parent full-stack id as a private orchestration identity, preventing
two parents from sharing one runtime. Child ids are persisted immediately so
cancellation and reclaimed-lease cleanup never depend on process memory.

A published artifact and running backend advance the parent to
`awaiting_activation`, with expiry tightened to both child expiries. The
portable Phase 3A routing activator can then re-check the parent, live artifact
authorization, running requester-owned backend, and current process-local
runtime route before atomically moving the parent to `ready`. It generates
only `https://fullstack-<uuid>.<base-domain>/`; no client supplies a URL or
backend target. The final expiry is the minimum of parent, artifact, and
runtime expiries.

Phase 3A also defines the portable serving boundary. A narrow routing store
exposes only id, status, artifact id, backend runtime id, and expiry. The
unique `fullstack-*` origin serves the referenced shared artifact while only
case-sensitive `/api` and `/api/*` use that preview's process-local live
runtime route. The proxy accepts bodyless GET/HEAD, strictly validates the raw
origin-form target, forwards only `accept` and `accept-language`, creates a
fresh upstream connection, buffers at most 256 KiB for at most five seconds,
rejects redirects, and returns only `content-type` plus host-owned security
headers. Full-stack responses use `connect-src 'self'`; shared `artifact-*`
origins remain static-only with `connect-src 'none'`. TLS ask authorization
for a full-stack name requires a ready, unexpired routing row and live
referenced artifact metadata.

This foundation is deliberately optional in `ProductionArtifactHost` and is
not composed by `services/production/server.ts`. The supervisor does not call
the activator automatically; Caddy/deployment changes and real-host gVisor E2E
also remain Phase 3B work. Before automatic activation, Phase 3B must assign
durable ownership after `ready`: user cancellation, full-stack expiry, backend
crash, `ready -> stopping -> stopped`, backend cancellation, and queue
acknowledgement/cleanup cannot be left to a worker that disappears after
activation. UI, M10, and M11 remain out of scope.
