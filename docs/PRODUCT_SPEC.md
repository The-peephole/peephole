# Product Specification

## 1. Product

Peephole is a Chrome extension and isolated preview service that lets a developer inspect and preview supported public GitHub frontend repositories before cloning them. For one narrow frontend-plus-backend shape it can also run a full-stack preview.

## 2. User Problem

A repository page rarely answers what an application looks like, how it builds, or why it cannot run. Verifying that manually creates local files, installs untrusted dependencies, consumes time, and often ends in a missing secret or backend requirement.

## 3. Primary User

A developer evaluating an unfamiliar public repository who wants a fast visual result and an honest explanation of its requirements.

## 4. Core Job To Be Done

> When I am viewing a GitHub repository, help me see a safe preview or quickly understand why one cannot be produced, without cloning or configuring the project locally.

## 5. Product Principles

### 5.1 Inspect before executing

Collect bounded evidence and decide eligibility before starting a build.

### 5.2 Safe fast path

Offer Peephole's isolated static builder only when the implemented runner
target resolves to exactly one registered Build Adapter and its compatibility
contract is satisfied. A normalized repository homepage and a confirmed
GitHub deployment are both shown as external links, opened in a new tab; a
declared homepage is never itself proof of a live deployment, and neither is
embedded as a Live Preview iframe.

### 5.3 Evidence over confidence theater

Show the dependency, script, lock file, config, or missing requirement behind every important conclusion.

### 5.4 Unsupported is useful

Do not guess commands, inject fake values, or hand the repository to a third party just to display something.

### 5.5 Zero local pollution

The user's machine and extension context never install or execute repository dependencies.

### 5.6 Treat public code as hostile

Popularity, stars, and GitHub visibility do not reduce the runtime threat model.

## 6. Current User Flow

1. The user opens a public GitHub repository.
2. On a verified repository overview page (`/owner/repo`), Peephole inserts
   one action next to GitHub's Watch/Star/Fork actions. It is omitted when
   that area is unavailable; repository subpages still supply Side Panel
   context.
3. Clicking it opens the Peephole side panel for that tab and repository.
4. Peephole resolves repository identity and an immutable commit SHA.
5. Bounded static analysis reports framework, package manager, commands, environment declarations, deployment evidence, repository structure, and blockers.
6. A separate, bounded GitHub Deployments API lookup reports the repository's
   current Live Deployment, if any, alongside its declared homepage; both are
   external links opened in a new tab, never probed further or embedded.
7. If the native static contract resolves to exactly one current Build Adapter,
   the user starts an isolated preview job.
8. The panel shows job phases and then the static artifact from a dedicated
   origin. A ready frame can be closed and shown again without a new job;
   **Build again** starts a new one.
9. If unsupported or failed, the panel shows a specific reason and never
   attempts hidden fallback execution.

### Full-stack flow (feature-gated)

When the extension is built with `WXT_FULLSTACK_PREVIEW_ENABLED=true` (the
v0.3.0 candidate build), a separate **Full-stack preview** section is shown
beside Build Preview; it never replaces it:

1. The user selects a frontend target whose static analysis is eligible.
   When the frontend and backend live in separate directories, candidates
   can also be discovered from the repository root.
2. The user chooses one detected backend. Candidates outside the narrow
   `fullstack-v1` shape are listed as not eligible.
3. The **Environment variables** list shows each declared name with its
   source: Peephole (platform, generated secret, temporary database), the
   user, or unsupported.
4. With `WXT_USER_ENVIRONMENT_ENABLED=true`, text inputs appear only for
   M12 user-configurable names. Every value plus an explicit acknowledgement
   ("not kept secret from the preview") is required before Run.
5. **Run full-stack preview** creates the preview. The server re-derives
   both plans at the exact commit and remains authoritative for admission.
6. The panel shows progress, then the full-stack preview from its own HTTPS
   origin, with **Stop full-stack preview**.

An admitted full-stack preview's controls are kept per tab in
`browser.storage.session`, so a panel or page reload can restore status and
Stop. Navigating away hides the panel without creating, stopping or
reopening anything (see [Side Panel navigation lifecycle](sidepanel-navigation-lifecycle.md)).

The Side Panel initially selects the repository's default branch. The user may
choose another branch from a bounded list; Peephole resolves the selection to
its current HEAD commit SHA before analysis, and every completed analysis and
job remains pinned to that resolved full commit SHA rather than the mutable
branch name.

## 7. Current Capabilities

### Implemented

- reliable GitHub repository detection and client-side navigation handling
- owner/repository/commit identity
- bounded repository metadata and file analysis
- evidence-based framework, package manager, command, environment, deployment,
  and workspace detection
- preview eligibility with blockers
- asynchronous, persisted preview jobs
- isolated static builds for package-free root repositories and root or
  explicitly selected nested Vite + React applications using npm and a
  target-local `package-lock.json`
- progress, cancellation, expiry, and clear failure states
- cached artifacts for identical immutable build inputs
- native Peephole Side Panel preview
- normalized repository-homepage presentation as an external link
- no StackBlitz dependency
- branch selection from a bounded list, resolved to an exact commit SHA before
  analysis, build plan, and preview job creation
- read-only repository/application structure detection: layout
  (single-project, workspace, multi-project, or unknown) and a bounded list
  of project candidate paths; detected frontend candidates can be explicitly
  selected for a separate exact-SHA build analysis
- existing deployed-site Live Preview: a bounded GitHub Deployments API
  lookup surfaces a repository's current confirmed live deployment (if any),
  its comparison against the selected preview commit, local deployment
  evidence (declared homepage or provider configuration), and the repository
  homepage -- entirely separate from Build Preview, opened only as external
  links, never embedded or proxied
- read-only backend detection: bounded, evidence-graded candidates
  (Express/NestJS/Fastify/Koa/Hapi framework evidence, database/server
  dependency evidence, a textually-derived and network-unverified
  entrypoint) for the repository root and a bounded set of nested
  structure candidates; never offered as a static Build Preview target; a
  backend can only be chosen as the backend half of a full-stack preview
- read-only environment requirement analysis: declared `.env.example`-family
  variable *names* (never values) classified as auto-configurable,
  preview-generated-secret-candidate, database-requirement,
  external-routing-candidate, user-required, or unknown, each tagged with
  its source root; analysis itself never generates, injects, or requests a
  value -- generation for the preview-generated-secret-candidate class
  happens later and separately, at `backend-v1`/`fullstack-v1` runtime
  creation (see the M10 bullet below)
- narrow backend execution (`backend-v1`, one adapter,
  `express-node-npm-v1`): a detected candidate that is Express, uses npm
  with a committed `package-lock.json`, has zero database dependencies, and
  needs no environment beyond `PORT`/`HOST`/`NODE_ENV` (its fixed
  `platformEnvironment`) plus, optionally, the four M10 canonical
  generated-secret names below may be started and stopped as a supervised,
  isolated process inside gVisor; every other candidate stays
  detected-but-not-executable exactly as before
- frontend ↔ backend routing (`fullstack-v1`, production-verified M9): a
  separate resource pairs one `backend-v1` runtime with one static build
  behind a single same-origin HTTPS preview, routing only `/api`/`/api/*`;
  not the same resource as Build Preview. At M9 it had no extension UI; the
  feature-gated Full-stack preview section (above) is the user path in the
  v0.3.0 candidate build
- ephemeral generated-secret injection (M10, production-verified
  2026-09-28): within the same narrow `backend-v1`/`fullstack-v1` contract,
  Peephole may *generate* and inject values for exactly four server-only
  names (`JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET`/`CSRF_SECRET`)
  outside the OCI `process.env`/`config.json` path, via a tmpfs-backed bind
  mount and trusted bootstrap; never user-supplied credentials or arbitrary
  environment names
- temporary PostgreSQL (M11, production-verified 2026-10-07): for a trusted
  `fullstack-v1` preview whose backend declares exactly a `pg` dependency and
  `DATABASE_URL`, Peephole provisions one temporary database and role in a
  separate host-local tenant cluster and delivers `DATABASE_URL` through a
  dedicated tmpfs file; never for standalone `backend-v1`, other engines or
  clients, or user-supplied database credentials
- user-provided non-sensitive configuration (M12-A/B, D-035): for a trusted
  `fullstack-v1` backend, values for declared names that pass the M12 policy
  (not secret-like, database, endpoint, client-public or reserved), at most
  16 names and 6,144 bytes; treated as public configuration because the
  repository code and preview visitors may see them. Implemented behind
  default-off flags (`PEEPHOLE_USER_ENVIRONMENT`,
  `WXT_USER_ENVIRONMENT_ENABLED`); a limited Production Canary succeeded on
  2026-10-16 and was rolled back. Not generally enabled in Production
- static preview Close/Show, per-tab Side Panel context across navigation,
  and overview-only repository action placement

### Recognized but not executable

- Vue and Svelte Vite evidence
- pnpm, yarn, and bun lockfile/package-manager evidence
- hosted-service hints (Supabase, Firebase, AWS Amplify) as external, not
  local backend, evidence
- workspace and monorepo ambiguity
- Next.js, WXT, and non-Vite React blockers
- any backend candidate outside `express-node-npm-v1`'s narrow shape
  (a different framework, a missing lockfile, a database dependency other
  than M11's exact `pg` + `DATABASE_URL` shape, or an environment
  requirement beyond `PORT`/`HOST`/`NODE_ENV`, the four M10 canonical
  generated-secret names, and M11's `DATABASE_URL`)

### Not implemented

- shared-root npm/pnpm/yarn workspace orchestration
- embedded remote deployed-site iframe or a proxy/fetch of a deployment URL
- a public backend URL, hostname, or reverse proxy for the standalone
  `backend-v1` resource itself (routing is `fullstack-v1`'s job, above)
- arbitrary environment injection or user-supplied secrets/API keys (M12-C
  is design-only); users may supply only M12 non-sensitive configuration,
  and generated secrets are limited to the four M10 names
- temporary database provisioning beyond M11's narrow PostgreSQL + `pg` +
  `DATABASE_URL` trusted-FullStack slice above
- private repositories, Docker/Compose, or arbitrary language execution

## 8. Current Compatibility Contract

A native preview is eligible only when all applicable conditions are satisfied:

- the repository is public,
- the source is pinned to a commit SHA,
- the application is package-free root static HTML or root/selected nested Vite + React,
- package applications use npm and a root `package-lock.json` for `npm ci`,
- the build command and static output directory are known,
- required secret environment values are absent,
- no backend, database, native build, Docker, or ambiguous workspace blocker is detected,
- repository and output sizes fall within service limits.

This contract is versioned. Changing it requires new fixtures and security tests.

## 9. Supported Evidence

Framework evidence includes declared dependencies, scripts, and framework
config files. Package-manager evidence combines lock files with
`packageManager` metadata. Environment evidence comes from root templates and
never stores secret values. Local, per-commit deployment evidence
distinguishes a declared repository homepage from provider configuration
alone; neither is proof of a live deployment. A confirmed live deployment
comes only from a separate, bounded GitHub Deployments API lookup that
requires a successful status and a validated environment URL; it does not
perform a reachability or framing check of its own.

Analysis details live in [Repository analysis](REPOSITORY_ANALYSIS.md).

## 10. Success Criteria

The implemented static-preview path succeeds when:

- a supported fixture reaches an interactive preview without leaving Peephole,
- time to a cached preview is meaningfully shorter than a fresh build,
- unsupported decisions include actionable blockers,
- GitHub navigation never shows stale repository or job state,
- no repository code executes in the extension or control plane,
- the applicable portable, live-network, production-like sandbox, and
  production operator gates are reported separately.

The existence of a fixture does not satisfy these criteria by itself. The
official Vite + React fixture is
`The-peephole/peephole-fixture-vite-react` at
`4a2c3b78e15d90865ed565c3d38c4045b5a5235f`. The separate full-stack fixture at
`The-peephole/peephole-fixture-fullstack@eae411a288b212201933cebb206126dd5bb0d93e`
is not a supported *static-preview* product path -- under plain Build
Preview, its `frontend` directory builds and its `backend` directory is
never started or routed, by design; it is also a verification target for
repository structure detection (its `frontend`/`backend` layout resolves to
two project candidates), evidence of detection only, not of full-stack
support. Separately and outside the static-preview contract above, that
same `backend` directory is the pinned, production-verified fixture for the
`backend-v1`/`fullstack-v1` contract (M9; see docs/PREVIEW_RUNTIME.md), and
a separate, dedicated commit on the same repository,
`The-peephole/peephole-fixture-fullstack@e10b08153e49d94a05931820c5325892754db246`
(repository id `1371618449`, same as the M9 pin above), is the pinned
fixture for M10's generated-secret verification (declares `SESSION_SECRET`,
exposes `/api/secret-check`; see docs/EPHEMERAL_SECRETS.md).

## 11. Product Boundary

Peephole is not a universal cloud IDE. It is currently an analyzer plus a
constrained static preview system, with one narrow full-stack contract. Broader execution is allowed only through
explicit later compatibility contracts, never by relaxing isolation or
silently guessing how a repository should run.

## 12. Ordered Product Roadmap

1. GitHub theme synchronization (implemented)
2. Branch Preview (implemented)
3. Repository / application structure detection (implemented)
4. Build Adapter generalization (implemented)
5. frontend target selection / bounded frontend monorepo support (implemented)
6. existing deployed-site Live Preview (implemented)
7. backend detection + environment requirement analysis (implemented)
8. backend execution (implemented, narrow)
9. frontend ↔ backend routing (implemented, production-verified M9)
10. ephemeral env / secrets (implemented, production-verified M10-C4B,
    2026-09-28, narrow four-name allowlist)
11. temporary database support (implemented, production-verified M11,
    2026-10-07, narrow PostgreSQL + `pg` + `DATABASE_URL` slice)
12. user-provided preview configuration (M12-A/B implemented behind
    default-off flags; limited Production Canary 2026-10-16, then rollback;
    general rollout not complete; M12-C design-only)

Stage 8's "narrow"
qualifier is load-bearing: it supports exactly one backend shape (Express +
npm + a committed lockfile + zero database dependencies), whose fixed
`BackendRuntimePlan.platformEnvironment` was, at that stage alone, only
`PORT`/`HOST`/`NODE_ENV`; never arbitrary Node backends, and its own success
is "can safely start/stop/clean up that one process inside gVisor" -- not
"full-stack preview" by itself. Stage 9 adds exactly that: routing one
`backend-v1` runtime to one static build behind a single same-origin HTTPS
preview (`fullstack-v1`). Stage 10 adds, within that same narrow contract
and through a separate `generatedSecretNames` path (never
`platformEnvironment`, which today is still fixed to exactly
`PORT`/`HOST`/`NODE_ENV`), generation and injection of exactly
`JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET`/`CSRF_SECRET` -- never
user-supplied credentials, arbitrary environment names, external
credentials, or database variables/provisioning. Stage 11 adds, for trusted
`fullstack-v1` previews only, exactly one server-provisioned temporary
PostgreSQL database and role when the backend declares exactly `pg` and
`DATABASE_URL`. `DATABASE_URL` is delivered through its own tmpfs path
rather than `platformEnvironment` or M10's `generatedSecretNames` (D-033,
docs/TEMPORARY_DATABASES.md). None of stages 8-11 means "arbitrary Node
backends are supported" or "arbitrary databases are supported."

Build Adapter generalization is an internal capability boundary. The
implemented adapters cover package-free root static HTML and root or
independently installable selected nested React + Vite + npm targets.
Shared-root workspaces remain unsupported.
