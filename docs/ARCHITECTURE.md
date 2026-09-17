# Architecture

## 1. Overview

Peephole has four trust-separated layers:

```text
GitHub page
    |
    v
Chrome extension ----------------------------+
    |                                        |
    | analysis / preview requests            | presentation only
    v                                        |
Preview control plane                        |
    |                                        |
    | immutable build plan                   |
    v                                        |
Isolated execution plane                     |
    |                                        |
    | static artifacts                       |
    v                                        |
Dedicated preview origin --------------------+
```

The extension integrates with GitHub and presents results. The control plane validates and schedules. The execution plane handles hostile repository code. The delivery plane serves only published artifacts.

This architecture is implemented for commit-pinned static previews. The
current execution targets are package-free root static HTML and root or
explicitly selected, independently installable nested Vite + React with npm.
Full-stack execution is a future architecture extension, not a property of the
current system.

## 2. Primary Design Rules

1. GitHub DOM integration is an adapter, not business logic.
2. Repository analysis does not import browser DOM code.
3. Preview eligibility is separate from evidence collection.
4. The extension and control API never execute repository source.
5. Every build is commit-pinned, short-lived, isolated, and reproducible enough to cache.
6. Unsupported is a first-class result, not an exception to bypass.

## 3. Extension Layer

### GitHub adapter

Responsible for:

- extracting `owner/repo` from the current URL,
- verifying that the page is a real repository context,
- locating the current visible repository action area,
- inserting and removing exactly one Peephole action,
- observing GitHub client-side navigation,
- resetting view state when repository identity changes, and
- reading validated computed Primer theme colors through a separate root-theme
  observer.

It must not analyze `package.json`, call runner infrastructure directly, or infer preview compatibility from DOM text.

### Application and UI

The application layer owns selected repository state, analysis requests, preview job state, cancellation, and stale-result protection. The compact GitHub action opens a Chrome side panel for the complete experience.

Content scripts do not perform cross-origin GitHub API fetches. They send typed repository operations to the background service worker. The background validates owner/repository input, performs only fixed GitHub API operations, owns the metadata cache, and forwards cancellation. It never accepts an arbitrary URL from a content script.

The side panel shows:

- repository identity,
- detected evidence and blockers,
- a read-only repository structure summary (layout and bounded project
  candidate paths),
- preview eligibility,
- build progress,
- the resulting preview or a clear unsupported/failure state.

Preview content is embedded only from the dedicated Peephole preview origin.
A repository's declared homepage and its current confirmed GitHub deployment
(a separate, bounded, mutable lookup -- see
[Repository analysis §15](REPOSITORY_ANALYSIS.md#15-live-deployment-discovery-mutable-separate-from-analysis))
are both displayed as external links opened in a new tab. Peephole does not
probe, proxy, or embed either as an iframe.

Branch selection is a mutable UI ref, kept separate from both repository
identity and the resolved immutable commit. The Side Panel lists a bounded set
of branches, and selecting one resolves its current HEAD to a full commit SHA
before analysis, build plan, or preview requests are made; nothing downstream
of that resolution ever receives the branch name itself. Selecting a branch
aborts any in-flight analysis for the previous selection using the same
cancellation contract as GitHub SPA navigation, and switching repositories
(not just branches) resets the selection to the new repository's default
branch.

Theme is not part of repository identity. The injected action consumes the
GitHub page's semantic CSS variables directly. A separate content-script
observer treats the current root theme attributes and system-scheme changes as
recomputation signals, reads a small computed color snapshot, and sends it to
the background. The background validates and stores that snapshot per sender
tab in `browser.storage.session`. An open Side Panel receives tab-filtered
runtime updates and changes only root Peephole CSS variables; it does not
rerender the React tree or reload the repository-specific Side Panel URL. The
cross-origin artifact iframe explicitly remains outside this theme contract.

## 4. Analysis Layer

Analysis fetches a bounded list of repository metadata and text files. It produces facts about framework, package manager, commands, environment declarations, deployment evidence, and monorepo shape.

It must be:

- deterministic for the same commit,
- evidence-based,
- resilient to missing or malformed files,
- independent from GitHub DOM selectors,
- free of repository-code execution.

Repository/application structure detection extends this with a bounded
`RepositoryStructure` describing the repository's layout
(`single-project`/`workspace`/`multi-project`/`unknown`) and a bounded list of
project candidates. Candidate discovery combines declared workspace patterns
with a small, fixed set of conventional root directory names; it performs at
most one level of additional directory listing beneath the repository root
(never a recursive crawl), and every read uses the same resolved commit SHA
as the rest of analysis. A candidate is labeled `project-candidate`,
`package-candidate`, or `unknown`, never asserted as an application or
library without supporting evidence, and detecting a candidate does not
select or build it -- that remains a later, separate roadmap stage.

Backend detection and environment requirement analysis extend this with
`RepositoryAnalysis.backend`/`environmentRequirements` -- bounded,
evidence-graded, detection-only additions with no execution or provisioning
behavior. The repository root's backend evidence comes from data already
fetched for the rest of analysis; a bounded set of nested candidates (from
paths structure detection already found, never a fresh crawl) is probed
independently and its failure never fails the rest of analysis. Environment
requirement classification reads only declared variable names from the same
bounded templates the existing environment detector reads, and never
generates, injects, or stores a value. See
[Repository analysis §16](REPOSITORY_ANALYSIS.md#16-backend-detection--environment-requirement-analysis-detection-only).

See [Repository analysis](REPOSITORY_ANALYSIS.md).

## 5. Preview Eligibility

Eligibility converts analysis into one of three modes:

```ts
type PreviewMode =
  | "existing-deployment"
  | "native-static-build"
  | "unsupported"
```

An eligibility result includes evidence, blockers, a package manager, a build command, and an output directory when known. A missing or ambiguous value must not be guessed in order to force a build.

Current behavior:

1. a native static build is offered whenever the implemented runner target
   resolves to exactly one registered Build Adapter and its compatibility
   contract matches -- this check runs first and always wins;
2. otherwise, if local deployment evidence exists (a declared homepage or
   provider configuration), `mode` falls back to `existing-deployment`;
3. otherwise the UI shows analysis and blockers only (`unsupported`).

Local deployment evidence (`declared`/`configured`) never overrides a
genuinely buildable target -- a declared homepage used to force
`existing-deployment` even for a buildable repository, incorrectly hiding
Build Preview; that is fixed. `existing-deployment` still does not mean
Peephole checked reachability or framing policy: it is local evidence only.
A separately loaded, mutable "Deployment" section (see
[Repository analysis §15](REPOSITORY_ANALYSIS.md#15-live-deployment-discovery-mutable-separate-from-analysis))
shows the repository's actual current live deployment, if a bounded GitHub
Deployments API lookup confirms one -- this is not folded into `preview.mode`
or the immutable analysis cache, and its failure never affects Build Preview.

### Build Adapter boundary

`core/preview/buildAdapters.ts` owns the production build-capability source of
truth. `BuildAdapterResolver` evaluates the explicit in-repository registry:

- no matches means unsupported;
- exactly one match creates and validates a deterministic `BuildPlan`;
- multiple matches fail explicitly as an adapter configuration error.

The registered adapters are `static-html-v1` and `vite-react-npm-v1`. Common
validation checks the wire shape, repository identity, full commit SHA,
contract-compatible safe source root, and safe output path. Each adapter checks its exact package
manager, install/build commands, and output semantics. The adapter id is not
serialized: the complete executable plan already identifies execution
semantics, and client and server independently resolve the same analysis.
`static-v1` remains root-only; `static-v2` enables target-aware React + Vite +
npm plans after independent server authorization. This does not generalize
framework, package-manager, backend, or workspace-orchestration capability.

StackBlitz is not a preview mode.

## 6. Preview Control Plane

The control plane exposes asynchronous, idempotent preview jobs. It:

- authenticates the Peephole client when needed,
- resolves repository id and commit SHA,
- independently reanalyzes the exact commit and reconstructs the build plan,
- returns a cached artifact when the cache key matches,
- queues a new job otherwise,
- exposes status, cancellation, expiry, and result metadata,
- never runs package installation or build commands in its own process.

Minimum API shape:

```text
POST   /v1/preview-jobs
GET    /v1/preview-jobs/{jobId}
DELETE /v1/preview-jobs/{jobId}
```

## 7. Execution Plane

The production runner performs a static build:

1. create a fresh isolated job sandbox,
2. download a public repository archive at the exact commit SHA,
3. verify size and file-count limits,
4. install dependencies when the plan requires it, using the selected lock
   file and frozen mode,
5. run the approved build command,
6. validate the configured output directory,
7. publish static artifacts,
8. destroy the writable job workspace.

The runner is described in [Preview runtime](PREVIEW_RUNTIME.md).

## 8. Delivery Plane and Origins

The deployed path uses different trust origins:

```text
API origin                 control API
{artifact-id}.preview.tld  untrusted preview content
```

The preview domain should be a separate registrable domain, not merely another subdomain of the control UI. It must not receive control-plane cookies, extension tokens, or infrastructure credentials.

Preview responses require restrictive headers and no privileged extension messaging bridge. Cross-job storage isolation should use a per-job origin where practical.

## 9. Caching

Analysis cache key:

```text
repository-id + commit-sha + analyzer-version
```

Build cache key:

```text
repository-id + commit-sha + normalized-build-plan + runner-version
```

Branch names alone are not valid cache keys. Failed builds may use a short negative-cache TTL to prevent rapid repeated abuse, but users need a retry path after configuration changes.

Live deployment cache key (deliberately separate, mutable, short-TTL --
45 seconds):

```text
repository-id (or owner/repo)
```

This is intentionally *not* combined with commit SHA or analyzer version: a
repository's live deployment can change independently of any particular
analyzed commit, so folding it into the immutable analysis cache above would
let a stale deployment state leak across commits. See
[Repository analysis §15](REPOSITORY_ANALYSIS.md#15-live-deployment-discovery-mutable-separate-from-analysis).

## 10. GitHub SPA Navigation

Navigation handling must combine GitHub navigation events with an idempotent reconciliation step. On every relevant transition:

1. parse the current URL,
2. validate repository context,
3. compare repository identity,
4. abort or detach requests for the old identity,
5. update, insert, or remove the action,
6. ensure no duplicate roots remain.

Async responses must carry their repository key and be discarded if it no longer matches current state.

## 11. Security Boundary

Assume repository files, dependency scripts, build tools, generated HTML, and network requests are malicious.

Required controls include:

- non-root execution,
- disposable per-job isolation,
- CPU, memory, process, disk, output-size, and wall-time limits,
- read-only base image and a bounded writable workspace,
- no access to arbitrary/sensitive host paths, the container socket, or sibling
  jobs; only owned job/runtime mounts are exposed,
- blocked private, loopback, link-local, and cloud-metadata networks,
- public IPv4 egress only during installation, with DNS-only resolver
  exceptions and private/link-local/host/inter-job destinations denied,
- no secret environment values,
- build and artifact TTLs,
- cancellation and orphan cleanup,
- audit logs without repository secrets.

A plain shared process or unrestricted container is not an acceptable production boundary for untrusted public builds.

## 12. Implemented Layout

```text
entrypoints/github.content/    GitHub selectors, injection, and navigation
entrypoints/background.ts      validated GitHub operations and side-panel sync
entrypoints/sidepanel/         full analysis and preview surface
components/                    presentation components
core/github/                   GitHub data client and bounded known files
core/analyzer/                 evidence detectors and eligibility inputs
core/preview/                  Build Adapter registry, build plan, API/auth clients
services/preview-api/          control plane and PostgreSQL adapters
services/preview-worker/local/ unsandboxed trusted-source development adapters
services/preview-worker/gvisor/ production sandbox/network/disk adapters
services/production/           deployed composition and artifact host
types/                         shared domain contracts
```

Deployable service boundaries may live in separate repositories later. Their contracts must remain explicit here.

## 13. Planned Architecture Expansion

GitHub theme synchronization, Branch Preview, repository/application structure
detection, Build Adapter generalization, bounded frontend target selection,
existing deployed-site Live Preview, and backend detection + environment
requirement analysis are implemented. A selected nested target is reanalyzed
at the exact commit, authorized again by the server, and executed with
target-local npm install, build, and output roots. Shared-root workspace
orchestration remains outside this contract. Live Preview surfaces a
repository's current confirmed GitHub deployment as a plain external link
next to Build Preview (no embedded iframe, no server-side fetch of the
deployment URL); it does not change the build contract. Backend detection
reports bounded, evidence-graded read-only candidates and environment
requirement classifications; neither executes anything, provisions anything,
or changes the build contract. The remaining expansion starts with backend
execution, then routing, ephemeral secrets, and databases.

The generalized Build Adapter boundary preserves the worker ports and adds no
fixture-specific production branches; it is unchanged by backend detection
(still only `static-html-v1`/`vite-react-npm-v1`, no `express-v1`/`nestjs-v1`/
etc.). Backend execution requires a separate reviewed runtime/lifecycle
contract rather than keeping the static build sandbox alive.
