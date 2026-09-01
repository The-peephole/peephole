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

Prefer a confirmed deployment. Otherwise use Peephole's isolated static builder only when the compatibility contract is satisfied.

### 5.3 Evidence over confidence theater

Show the dependency, script, lock file, config, or missing requirement behind every important conclusion.

### 5.4 Unsupported is useful

Do not guess commands, inject fake values, or hand the repository to a third party just to display something.

### 5.5 Zero local pollution

The user's machine and extension context never install or execute repository dependencies.

### 5.6 Treat public code as hostile

Popularity, stars, and GitHub visibility do not reduce the runtime threat model.

## 6. v0.1 User Flow

1. The user opens a public GitHub repository.
2. Peephole inserts one action in the current repository header.
3. Clicking it opens the Peephole side panel.
4. Peephole resolves repository identity and an immutable commit SHA.
5. Bounded static analysis reports framework, package manager, commands, environment declarations, deployment evidence, and blockers.
6. If a confirmed deployment exists, Peephole offers it.
7. If the native static contract matches, the user starts an isolated preview job.
8. The panel shows job phases and then the preview from a dedicated origin.
9. If unsupported or failed, the panel shows a specific reason and never attempts hidden fallback execution.

## 7. v0.1 Features

### P0

- reliable GitHub repository detection and client-side navigation handling
- owner/repository/commit identity
- bounded repository metadata and file analysis
- evidence-based framework, package manager, command, environment, and deployment detection
- preview eligibility with blockers
- asynchronous preview jobs
- isolated static builds for static and root-level Vite applications
- progress, cancellation, expiry, and clear failure states
- native Peephole side-panel preview
- no StackBlitz dependency

### P1

- React, Vue, and Svelte Vite fixtures
- cached results for identical commit/build-plan pairs
- confirmed external deployment presentation
- more actionable install and build diagnostics

### Deferred

- private repositories
- persistent Next.js SSR or arbitrary Node servers
- backend/database provisioning
- secret injection
- Docker and Docker Compose
- automatic monorepo application selection
- arbitrary language execution
- AI features

## 8. v0.1 Compatibility Contract

A native preview is eligible only when all applicable conditions are satisfied:

- the repository is public,
- the source is pinned to a commit SHA,
- the application is static or a recognized root-level Vite project,
- the package manager and frozen install command are deterministic,
- the build command and static output directory are known,
- required secret environment values are absent,
- no backend, database, native build, Docker, or ambiguous workspace blocker is detected,
- repository and output sizes fall within service limits.

This contract is versioned. Changing it requires new fixtures and security tests.

## 9. Supported Evidence

Framework evidence includes declared dependencies, scripts, and framework config files. Package-manager evidence prioritizes a single lock file and `packageManager` metadata. Environment evidence comes from templates and source references but never stores secret values. Deployment evidence distinguishes a reachable confirmed URL from provider configuration alone.

Analysis details live in [Repository analysis](REPOSITORY_ANALYSIS.md).

## 10. Success Criteria

Product success for v0.1 means:

- a supported fixture reaches an interactive preview without leaving Peephole,
- time to a cached preview is meaningfully shorter than a fresh build,
- unsupported decisions include actionable blockers,
- GitHub navigation never shows stale repository or job state,
- no repository code executes in the extension or control plane,
- malicious fixtures cannot escape resource, network, job, or origin boundaries.

## 11. Product Boundary

Peephole v0.1 is not a universal cloud IDE. It is an analyzer plus a constrained static preview system. Broader execution is allowed only through explicit later compatibility contracts, never by relaxing isolation or silently guessing how a repository should run.
