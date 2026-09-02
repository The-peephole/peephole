# Test Plan

## 1. Testing Strategy

Peephole spans three trust zones, so tests are grouped accordingly:

1. pure analysis and eligibility,
2. extension/GitHub integration and preview API contracts,
3. hostile execution and preview-origin isolation.

Unit tests use fixtures and never depend on live GitHub APIs. Production isolation claims require integration tests in the actual runner environment, not mocks alone.

## 2. Unit Tests

### GitHub URL parser

Cover repository roots and subpaths, `.git` normalization where supported, reserved routes, malformed paths, non-GitHub hosts, and organization/user pages.

### GitHub reconciliation

Verify:

- exactly one action after repeated reconciliation,
- current visible action target selection,
- removal on non-repository pages,
- repository state reset after navigation,
- stale async response rejection,
- no unsupported `attachShadow` path.

### Analyzer detectors

Use small file-map fixtures for:

- static HTML,
- React/Vue/Svelte Vite,
- Next.js,
- TypeScript,
- every recognized lock file,
- conflicting lock files,
- malformed `package.json`,
- environment comments, quotes, duplicates, and secret-like names,
- configured versus confirmed deployment evidence,
- workspace and monorepo ambiguity.

### Preview eligibility

Required cases:

```text
confirmed safe deployment       -> existing-deployment
root static repository          -> native-static-build
root Vite app + lock + build    -> native-static-build
secret environment required     -> unsupported
Next.js SSR                     -> unsupported
ambiguous monorepo              -> unsupported
unknown package manager         -> unsupported
missing output directory        -> unsupported
```

Every case asserts evidence and stable blocker codes, not only the mode.

### Preview job state machine

Test allowed and rejected transitions among:

```text
queued -> fetching -> installing -> building -> publishing -> ready
                                      |             |
                                      +--> failed <--+
queued/running -> cancelled
ready/failed/cancelled -> expired
```

Also cover idempotent create requests, duplicate worker completion, retry policy, cache hits, cancellation races, expiry, and repository/commit mismatch.

## 3. Extension Integration Tests

With static GitHub-like DOM fixtures, verify action insertion, click handling, side-panel messages, repository switches, subpage navigation, history transitions, Turbo/PJAX-style replacements, and target disappearance/reappearance.

An active job for `owner/repo-a@sha-a` must never render after navigation to `owner/repo-b@sha-b`.

## 4. API Integration Tests

Use a fake GitHub client, queue, artifact store, and runner to verify:

- commit resolution and server-side build-plan validation,
- create/status/cancel behavior,
- authorization boundaries,
- job and artifact ownership,
- structured failure responses,
- cache-key composition,
- signed URL expiry,
- API inability to invoke a shell directly.

Database adapter tests verify parameter binding, transaction boundaries,
idempotency conflicts, row-locked state transitions, quota rollback, and queue
lease/acknowledgement/retry SQL. Before deployment, run the same lifecycle
against a real PostgreSQL instance, including two concurrent workers, expired
lease recovery, cancellation races, and a database restart.

## 5. Runner Golden Paths

Maintain commit-pinned local fixtures for:

- static HTML with nested routes/assets,
- Vite React,
- Vite Vue,
- Vite Svelte.

For each supported fixture, assert frozen installation, successful build, expected output root, correct MIME types, asset loading, SPA fallback behavior when configured, and workspace cleanup.

React/Vue/Svelte additions are gated independently; the v0.1 release can start with static HTML and Vite React if documented honestly.

## 6. Failure Tests

Cover:

- missing or conflicting lock files,
- install failure,
- build failure,
- oversized archive or expanded tree,
- too many files,
- missing/oversized output,
- symlink and path traversal attempts,
- timeout and cancellation,
- worker crash and duplicate delivery,
- artifact-store failure,
- expired preview,
- GitHub rate limiting and network failure.

The user-facing result must preserve safe diagnostics without leaking tokens, internal paths, or infrastructure details.

## 7. Security Tests

Use intentionally malicious fixtures to verify:

- dependency lifecycle scripts cannot access host files or sockets,
- builds cannot reach loopback, RFC1918/private, link-local, or cloud metadata endpoints,
- non-allowlisted egress is denied,
- fork bombs and process floods hit PID limits,
- CPU, memory, disk, output, and wall-time limits terminate the job,
- one job cannot read another job's workspace or artifacts,
- runner credentials are absent from the job environment,
- preview HTML receives no control-plane cookies or tokens,
- preview content cannot call privileged extension APIs,
- artifact paths cannot escape their job prefix,
- logs redact authorization headers and secret-like values.

Do not declare a container image alone to be a passed isolation test. Validate the deployed boundary and host policy.

## 8. Performance and Cost Checks

Measure cold and cached analysis, queue wait, install, build, publish, and time-to-interactive preview separately. Track cache hit rate, artifact bytes, worker CPU/memory seconds, cancellations, timeouts, and orphan cleanup latency.

Set explicit service budgets before public release. A job exceeding a limit must fail predictably rather than degrade shared capacity.

## 9. Manual GitHub Navigation Matrix

Test at least:

- repository root,
- code subdirectory,
- issues and pull-request subpages,
- user and organization pages,
- search, settings, marketplace, and gist-like reserved routes,
- repository A -> repository B,
- repository -> non-repository -> repository,
- navigation while analysis or a preview job is active.

At all times, verify one action at most, correct owner/repository identity, correct panel state, and no stale result.

## 10. Release Smoke Test

From a clean Chrome profile:

1. load the production extension unpacked,
2. visit a pinned supported static fixture and build a preview,
3. reload and verify the cached result,
4. visit a pinned Vite fixture and verify assets and interaction,
5. visit an unsupported SSR or monorepo fixture and verify blockers without a job,
6. navigate between all fixtures without reload,
7. cancel an active build and verify cleanup,
8. allow an artifact to expire and verify the expired state,
9. confirm there is no StackBlitz action or network request,
10. run the security gate against the deployed runner configuration.
