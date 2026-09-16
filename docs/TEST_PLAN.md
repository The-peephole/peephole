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

### Repository analysis

Use bounded file-map fixtures for:

- static HTML and React/Vue/Svelte Vite evidence;
- Next.js, WXT, and non-Vite React blockers;
- TypeScript evidence;
- npm/pnpm/yarn/bun lockfiles and conflicts;
- malformed `package.json` and incomplete known-file reads;
- environment template parsing and secret-like names;
- normalized homepage versus provider-configuration evidence;
- workspace/monorepo ambiguity;
- current runner gating: static/none and React-Vite/npm accepted, recognized
  but unavailable targets blocked.

Analysis tests must not imply that every recognized framework or package
manager is executable.

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
  output resolution, and publication.

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
2. branch selection, immutable resolution, stale branch movement, and cache keys
3. repository/application structure fixtures
4. generalized Build Adapter contract tests
5. frontend target/monorepo selection and isolation
6. existing-site reachability, framing, navigation, and origin policy
7. backend detection evidence and false positives
8. backend process lifecycle and isolation
9. frontend/backend routing and cross-origin policy
10. ephemeral secret redaction, scope, and teardown
11. temporary database tenancy, credentials, lifecycle, and cleanup

The full-stack fixture becomes eligible for these tests only as each required
contract is actually implemented.
