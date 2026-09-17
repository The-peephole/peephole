# Product Specification

## 1. Product

Peephole is a Chrome extension and isolated preview service that lets a developer inspect and preview supported public GitHub frontend repositories before cloning them.

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
2. Peephole inserts one action in the current repository header.
3. Clicking it opens the Peephole side panel.
4. Peephole resolves repository identity and an immutable commit SHA.
5. Bounded static analysis reports framework, package manager, commands, environment declarations, deployment evidence, repository structure, and blockers.
6. A separate, bounded GitHub Deployments API lookup reports the repository's
   current Live Deployment, if any, alongside its declared homepage; both are
   external links opened in a new tab, never probed further or embedded.
7. If the native static contract resolves to exactly one current Build Adapter,
   the user starts an isolated preview job.
8. The panel shows job phases and then the static artifact from a dedicated
   origin.
9. If unsupported or failed, the panel shows a specific reason and never
   attempts hidden fallback execution.

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
  structure candidates; detected, never executed, started, or offered as a
  preview target
- read-only environment requirement analysis: declared `.env.example`-family
  variable *names* (never values) classified as auto-configurable,
  preview-generated-secret-candidate, database-requirement,
  external-routing-candidate, user-required, or unknown, each tagged with
  its source root; no value is ever generated, injected, or requested

### Recognized but not executable

- Vue and Svelte Vite evidence
- pnpm, yarn, and bun lockfile/package-manager evidence
- hosted-service hints (Supabase, Firebase, AWS Amplify) as external, not
  local backend, evidence
- workspace and monorepo ambiguity
- Next.js, WXT, and non-Vite React blockers

### Not implemented

- shared-root npm/pnpm/yarn workspace orchestration
- embedded remote deployed-site iframe or a proxy/fetch of a deployment URL
- backend or persistent server execution
- frontend/backend routing
- ephemeral environment or secret injection
- temporary database provisioning
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
is reserved for future roadmap work and is not a supported product path; it is
now also a verification target for repository structure detection (its
`frontend`/`backend` layout resolves to two project candidates), which is
evidence of detection only, not of full-stack support.

## 11. Product Boundary

Peephole is not a universal cloud IDE. It is currently an analyzer plus a
constrained static preview system. Broader execution is allowed only through
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
8. backend execution
9. frontend ↔ backend routing
10. ephemeral env / secrets
11. temporary database support

Stages 8-11 describe future full-stack work. They must not be inferred from
the prepared full-stack fixture, from stage 7's detection-only evidence, or
documented as current capability. "Backend detected" and "environment
requirement detected" are not "backend execution supported" or "environment
configured."

Build Adapter generalization is an internal capability boundary. The
implemented adapters cover package-free root static HTML and root or
independently installable selected nested React + Vite + npm targets.
Shared-root workspaces remain unsupported.
