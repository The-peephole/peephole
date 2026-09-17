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

## 8. Roadmap Test Expansion

Add coverage in the same order as product development:

1. GitHub light/dark/dimmed theme synchronization and navigation changes (implemented)
2. branch selection, immutable resolution, stale branch movement, and cache keys (implemented)
3. repository/application structure fixtures (implemented)
4. generalized Build Adapter contract tests (implemented)
5. frontend target/monorepo selection and isolation
6. existing-site reachability, framing, navigation, and origin policy
7. backend detection evidence and false positives
8. backend process lifecycle and isolation
9. frontend/backend routing and cross-origin policy
10. ephemeral secret redaction, scope, and teardown
11. temporary database tenancy, credentials, lifecycle, and cleanup

The full-stack fixture becomes eligible for these tests only as each required
contract is actually implemented.
