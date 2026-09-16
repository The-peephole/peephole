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
-> bounded repository analysis at the default-branch head commit
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
- root-level Vite + React with npm, a root `package-lock.json`, `npm ci`, the
  `build` script, and a deterministic static output directory.

Vue/Svelte Vite, other package managers, selected monorepo applications,
backends, persistent servers, secrets, and temporary databases are not current
runner capabilities. Existing deployment evidence currently exposes a
normalized repository-homepage link in a new tab; it is not yet an embedded
deployed-site Live Preview.

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
- `core/preview/runnerSupport.ts` is the current execution-capability gate.
- The client proposes a versioned build contract; the server independently
  verifies repository identity, the exact commit, analysis, and build plan.
- Branch names are not immutable job or cache identities. Branch Preview must
  resolve a selected branch to a full commit SHA before analysis or execution.

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

Each stage must expose a reviewed contract and preserve earlier security
boundaries. In particular, do not jump from a full-stack fixture to backend
execution, and do not keep the static build container alive as a server.

GitHub theme synchronization reads the current page's computed Primer semantic
colors, validates a small snapshot, and stores it per tab in
`browser.storage.session`. The injected action inherits Primer variables
directly. The Side Panel receives theme-only runtime updates and changes root
CSS custom properties without remounting repository analysis or preview state.
Theme names are event markers, not palette dispatch keys.

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
analysis, execution, routing, secrets, or database support.

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
