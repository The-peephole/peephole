# Peephole Roadmap

## Current Baseline

Peephole has a deployed, commit-pinned static-preview path:

```text
public GitHub repository
-> GitHub action and Chrome Side Panel
-> bounded analysis of the default-branch head commit
-> authenticated Preview Control Plane job
-> PostgreSQL queue/state
-> isolated gVisor build
-> static HTTPS artifact
-> Side Panel preview
```

The following foundation is implemented:

- GitHub repository injection and SPA navigation handling;
- repository metadata and bounded known-file analysis;
- evidence, warnings, blockers, and versioned eligibility;
- GitHub App authentication with short-lived Peephole sessions;
- commit-pinned asynchronous jobs, cancellation, expiry, quotas, caching, and
  PostgreSQL persistence;
- a real production worker using gVisor, non-root execution, resource limits,
  disk bounds, phased network controls, and recovery/reaping;
- isolated static artifact publication and Chrome Side Panel rendering;
- production deployment plus portable, live-network, PostgreSQL, and
  environment-gated gVisor verification paths.

This baseline does not imply arbitrary repository or full-stack support.

## Current Execution Contract

The production runner accepts only:

1. package-free static HTML/CSS/JS with a root `index.html`;
2. a root-level Vite + React application using npm, a root
   `package-lock.json`, `npm ci`, a `build` script, and a deterministic static
   output directory.

The analyzer recognizes more evidence than the worker can execute. Vue/Svelte
Vite, pnpm/yarn/bun, monorepos, backends, persistent servers, secrets, and
databases remain non-runnable. Repository homepage metadata may be shown as an
external link, but deployed-site Live Preview is not implemented.

## Completed Foundation Milestones

### Extension and analysis

- [x] WXT + React + TypeScript Manifest V3 extension
- [x] idempotent GitHub repository action and client-side navigation handling
- [x] Chrome Side Panel state synchronization
- [x] public repository id, default branch, and immutable head commit resolution
- [x] bounded known-file loading and metadata caching
- [x] framework, package-manager, runtime, environment, deployment, and
      workspace evidence
- [x] explicit blockers and runner-capability gating

### Control plane and persistence

- [x] create/status/cancel Preview API
- [x] server-side repository, commit, and build-plan revalidation
- [x] idempotency, cache lookup, quotas, expiry, and structured failures
- [x] PostgreSQL job, cache, quota, artifact, and leased-queue persistence
- [x] GitHub App OAuth/PKCE flow and authenticated preview sessions

### Production execution and delivery

- [x] commit archive fetch, bounded extraction, frozen npm install, static
      build, output validation, and artifact publication
- [x] real gVisor production composition and non-root execution
- [x] CPU, memory, PID, wall-clock, archive, workspace-disk, output-size, and
      file-count controls
- [x] install/build network phase separation and blocking for private,
      loopback, link-local, metadata, host, and inter-job destinations
- [x] startup and normal-path reconciliation for runsc, disk, and network state
- [x] artifact-specific HTTPS origins, restrictive headers, expiry, and cleanup
- [x] end-to-end Chrome extension -> production API -> PostgreSQL -> gVisor ->
      artifact -> Side Panel verification recorded

## Next Development Sequence

These stages are ordered. A later stage must not be presented as supported
because a fixture or interface for it exists.

1. [ ] GitHub theme synchronization
2. [ ] Branch Preview
3. [ ] Repository / application structure detection
4. [ ] Build Adapter generalization
5. [ ] frontend target selection / frontend monorepo support
6. [ ] existing deployed-site Live Preview
7. [ ] backend detection
8. [ ] backend execution
9. [ ] frontend ↔ backend routing
10. [ ] ephemeral env / secrets
11. [ ] temporary database support

The early stages establish repository selection and generalized build contracts
before full-stack execution is considered. Backend execution requires a new
reviewed runtime contract; it must not be implemented by extending the lifetime
or privileges of the static-build sandbox.

## Fixture Status

The official Vite + React golden-path fixture is:

```text
repository: The-peephole/peephole-fixture-vite-react
repository id: 1371620276
commit: 4a2c3b78e15d90865ed565c3d38c4045b5a5235f
```

PR #6 updated the shared fixture metadata on `main` at merge commit
`dba47191bdd3600b3f451945653efab2363028c2`. A manually dispatched
`Real golden-path build tests` run on that `main` revision succeeded. This is a
live-network workflow result, not a production smoke result.

The full-stack fixture is reserved for future roadmap work:

```text
repository: The-peephole/peephole-fixture-fullstack
commit: eae411a288b212201933cebb206126dd5bb0d93e
```

It is not connected to a supported full-stack runtime contract today.

## Cross-Cutting Work

These items remain important but do not reorder the product sequence above:

- [ ] complete keyboard, focus, contrast, and screen-reader review;
- [ ] add production-grade metrics, centralized logs, and alerts;
- [ ] automate production deployment smoke orchestration without conflating it
      with CI;
- [ ] replace broad public install egress with an authenticated package proxy
      or equivalently constrained service;
- [ ] run the dedicated malicious dependency-script suite on the
      production-like gVisor host;
- [ ] complete the supported/unsupported fixture matrix and external security
      review.

## Verification Gates

- Portable CI covers formatting, lint, typechecking, unit/integration tests, and
  extension build without requiring a production host.
- `Real golden-path build tests` exercises pinned public archives and the real
  package/build toolchain with live network access.
- Real gVisor suites require a suitable privileged Linux host and establish
  claims about that sandbox environment.
- Production smoke requires an already-deployed instance plus operator-held
  production credentials and host visibility. A green golden-path workflow
  does not satisfy this gate.
