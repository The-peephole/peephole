# GitHub API Request Optimization

## Scope and authentication boundary

The Chrome extension's background service worker creates `new GitHubClient()`
without `getToken`. Repository metadata, content, branches, and deployment
requests are therefore public, unauthenticated GitHub REST API requests. The
GitHub App OAuth flow identifies a Peephole user only: its access token is
discarded by the server and must not be reused as a repository-data token.

GitHub currently associates unauthenticated requests with the originating IP
address and documents a primary limit of 60 requests per hour. The extension
does not place a GitHub token in its bundle, logs, extension storage, or local
storage. See GitHub's [REST API rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [authentication guidance](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).

## Call-path audit

The side panel starts repository analysis, branch discovery, and live
deployment discovery independently. Before this change, the first two paths
both fetched repository details. Repository structure discovery then fetched
each nested `package.json`; backend discovery fetched the same files again.
Target analysis also repeated root or nested directory/file reads that were
already pinned to the same commit.

| User action | Mutable/freshness requests | Immutable commit requests | Classification |
| --- | --- | --- | --- |
| First repository entry | Repository details, default branch HEAD, branch list, deployments | Root listing, known root text, candidate package files, bounded backend evidence | Required for current UI, except deployment discovery is independent/optional to repository analysis |
| Same repository re-entry | Ref and branch data only after their TTL; deployment data after its own TTL | None while analysis/content entries remain in memory | Warm-cache reuse |
| Repository-root target analysis | None | Root listing and known files | Duplicate of repository analysis and now reused |
| Nested frontend selection | None | Target directory listing and target-only known files | Required; previously read candidate `package.json` is reused |
| Branch change | Repository details (if expired) and selected branch HEAD | Full analysis for the newly resolved SHA | Required and isolated from every other SHA |

The Chrome background explicitly enables this optimization; production and
local server `GitHubClient` instances retain their previous uncached behavior.
Live deployment lists and statuses remain short-lived mutable data and are not
stored in the immutable content cache. Likewise, branch/repository responses
have a 60-second TTL. Content URLs pinned to an exact 40-character commit SHA
have no time TTL, but live only in a bounded process-local LRU.

## Mock request-count measurement

The same full-stack fixture was replayed with mocked HTTP responses against
baseline `b2768aa7723e577acc8cb20f1efb966dc49b7475` and this change. The fixture
contains a root workspace, one Vite frontend, one Express/PostgreSQL backend,
an environment template, and no GitHub deployment records.

| Scenario | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Cold initial load (analysis + branches + deployments) | 17 | 14 | 3 (18%) |
| Warm repeat of the same initial load | 2 | 0 | 2 (100%) |
| Root → Frontend → Root target analysis | 5 | 2 | 3 (60%) |
| Change to a different branch/SHA | 14 | 11 | 3 (21%) |
| Same file, two concurrent callers | 2 | 1 | 1 (50%) |

The regression test asserts the after counts. The baseline counts were
obtained by running that same first scenario against the detached baseline
commit and adjusting only the expected cumulative counters. No live GitHub
API quota was consumed.

Counts vary with the repository's bounded set of known files, workspace
candidates, backend candidates, and deployment records. The invariant is that
an exact repository/commit/path response is fetched at most once while cached,
and simultaneous callers share one network operation.

## Cache and cancellation rules

- Mutable repository/branch responses use a short TTL. Immutable content is
  keyed by the full REST path, including exact commit SHA.
- The response cache is capped at 256 entries and 4 MiB. Repository analysis,
  target analysis, metadata, and deployment caches also have entry caps.
- File-size and aggregate loader budgets are still evaluated by their original
  callers. A cached raw file response is decoded and checked against each
  caller's `maxBytes`, so caching cannot bypass a stricter later limit.
- Successful responses are cached. A content 404 is distinct from an empty
  file and is retained for only 15 seconds. Network, validation, 403, and 429
  failures are not cached.
- Concurrent callers receive independent cancellation. The shared fetch is
  aborted only when every subscriber has cancelled. A pre-aborted caller is
  rejected before cache lookup or loader start, and a cancelled shared
  request's late completion is never cached or allowed to replace a newer
  request for the same key.
- A GitHub file payload must contain decodable Base64 before it can enter the
  immutable cache. Per-caller `maxBytes` failures do not evict an otherwise
  valid shared response.
- This is an opportunistic MV3 service-worker memory cache, not persistence.
  Chrome may stop the worker and discard it at any time.

## Rate-limit behavior

`Retry-After` (seconds or HTTP-date) takes precedence over
`X-RateLimit-Reset`. A 403 with `X-RateLimit-Remaining: 0` and every 429 enter a
local cooldown. If GitHub supplies neither retry header for a secondary limit,
the client applies GitHub's documented minimum one-minute wait. Until the
deadline, uncached calls fail locally without another HTTP request; there is no
automatic retry loop. The error carries the absolute retry instant, and the
side panel renders it in the user's local time.

This follows GitHub's [rate-limit troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2026-03-10).

## Authenticated public-read gateway

Signed-in users can read public GitHub data through the Preview API instead of
the unauthenticated 60/hour-per-IP budget. The decision record is D-034 in
`docs/DECISIONS.md`.

### Data flow and trust boundary

```
extension GitHubClient (cache, validation, cooldown -- unchanged)
  └─ gatewayFetcher: signed in?
       no  → https://api.github.com (direct, unauthenticated, as before)
       yes → POST {preview API}/v1/github/rest  { "path": "/repos/..." }
               Authorization: Bearer <Peephole session>
                 └─ PreviewSessionAuth (401 for missing/expired/forged)
                 └─ GitHubGateway
                      parse fixed operation → caller limits → credential
                      guard → public visibility → shared cache → upstream
                        https://api.github.com, Authorization: server token
```

- **Credential ownership:** the server-owned `PEEPHOLE_GITHUB_TOKEN` is used
  only inside `GitHubGateway` (and, separately, by preview admission). It is
  never placed in a response, header, or log. The extension holds only its
  Peephole session; GitHub App user tokens are still discarded after `/user`.
- **Operations:** exactly the extension's reads -- repository, one branch,
  the bounded branch list, contents (directory or file) at an exact 40-hex
  commit SHA, the bounded deployment list, and one deployment's statuses.
  The raw path is parsed by hand (no `URL` dot-segment normalization),
  each owner/repository/branch/path/SHA/id is re-validated, extra query
  parameters or body keys are rejected, and the upstream URL is rebuilt from
  the validated fields against the fixed `https://api.github.com` origin.
  Redirects are never followed (`redirect: "manual"`, any 3xx → 502).
- **Responses:** GitHub's own shape, reduced to the fields `GitHubClient`
  reads, so its validators, cache, and error mapping apply unchanged. Every
  gateway answer carries `x-peephole-github-gateway: 1` (or `disabled`).

### Public-only enforcement

1. **Per request:** every operation first loads `/repos/{owner}/{repo}` and
   proceeds only when `private === false` and `visibility === "public"`.
   Private, internal, missing-visibility, or absent repositories all answer
   404 with no repository data. CORS is not part of access control.
2. **Credential guard:** the gateway serves only with a classic personal
   access token (`ghp_`) whose grant it can read back. Before serving, and
   every 10 minutes, it calls `GET /user/repos?visibility=private&per_page=1`
   and stays enabled only if the response carries `X-OAuth-Scopes`, every
   listed scope is `public_repo`, `read:user`, or `user:email`, and the body
   is `[]`. GitHub documents that `X-OAuth-Scopes` "lists the scopes your
   token has authorized" and that a scope-less token has "read-only access to
   public information"; `repo`, `repo:status`, and `repo_deployment` reach
   private repositories and are refused.
   - **Fine-grained PATs (`github_pat_`) are refused.** They return no
     `X-OAuth-Scopes`, and their repository grant cannot be read back through
     the API; an empty private-repository list is evidence, not proof (an
     "all repositories" grant also covers repositories made private later).
   - **GitHub App / OAuth credentials** (`gho_`, `ghu_`, `ghs_`, `ghr_`) and
     unrecognized values are refused without being sent anywhere.
   - A failed check or an upstream 401 also disables the gateway
     (fail-closed, re-checked after one minute).

   Operators must therefore configure a **scope-less classic token** for the
   gateway. Preview admission works with either token type.

### Cache policy (server)

| Data | Key | TTL |
| --- | --- | --- |
| Repository visibility + metadata | lowercase `owner/repo` | 30 s (404: 15 s) |
| Branch head, branch list | verified repository id + path | 30 s |
| Contents | verified repository id + exact commit SHA + path | immutable, LRU (404: 15 s) |
| Deployments, statuses | verified repository id + path | not cached; in-flight dedup only |

The cache reuses `GitHubRequestCache` (in-flight dedup, independent
cancellation, late-completion protection), bounded to 4,096 entries / 64 MiB.
The cache is process memory: a service restart empties it; there is no manual
invalidation. The extension cache (above) keeps its own role -- avoiding
repeat calls from one browser -- while the server cache shares immutable
reads across users.

### What a Public → Private change does (and does not) guarantee

Verified by `tests/githubGatewayFetcher.test.ts` ("Public -> Private
transition exposure"):

- **New recipients:** for up to the 30-second visibility TTL after the change
  (plus GitHub's own propagation), the gateway can still return that
  repository's data -- including content another user cached -- to any
  signed-in caller. After the TTL every operation answers 404.
- **Data already delivered stays delivered.** An extension that received a
  file keeps it in its background memory cache (immutable, no request) until
  the service worker is discarded; its next repository lookup is refused once
  its own 60-second metadata TTL lapses. This matches the direct
  unauthenticated path, and no server control can recall it.
- **Immediate enforcement is not guaranteed.** Re-checking visibility on
  every request (`visibilityTtlMs: 0`) narrows only the server window, still
  leaves a check-then-fetch gap, and costs measurably more of the shared
  token: in the fixture scenario upstream calls grow from 15 to 26 for one
  cold analysis and from 30 to 78 across the full multi-user scenario.
  Event-driven invalidation (GitHub `repository` "privatized" webhooks) would
  need the GitHub App installed on each repository, which arbitrary public
  repositories are not. The 30-second TTL is therefore kept and is the stated
  bound.

### Rate-limit and quota policy

- Per subject: 120 gateway requests/minute; per client IP: 240/minute.
- At most 8 concurrent upstream GitHub requests.
- GitHub 429, or 403 with exhausted quota / `Retry-After`, starts a gateway
  cooldown; callers get 429 with `Retry-After`/`X-RateLimit-Reset` and no
  further upstream call is made until it ends. The retry instant uses the
  client's own `getRetryAt` (`Retry-After` seconds or HTTP-date, then
  `X-RateLimit-Reset`, otherwise GitHub's one-minute minimum).
- The last 500 primary-quota calls (from `X-RateLimit-Remaining`) are held
  back for preview admission, which shares the server token.
- Upstream timeout 10 s; upstream bodies over 4 MiB are rejected.

### Failure behavior and compatibility

| Situation | Extension behavior |
| --- | --- |
| Signed out or session expired locally | Direct unauthenticated request (unchanged) |
| Session rejected (401) | Clears the session (as preview clients do), continues unauthenticated |
| Rate limit on one path | Cooldown applies to that path only (`rateLimitScope`: `direct` vs. `gateway`); signing in or out switches to the other path's own state |
| Gateway `disabled` or route missing (older server) | Direct unauthenticated request |
| GitHub 404 / 429 / upstream failure via gateway | Same `GitHubApiError` as a direct call; never silently retried directly |
| Preview API unreachable or infrastructure error | `network` / `unavailable` error |

### Configuration, rollout, and rollback

| Variable | Where | Default |
| --- | --- | --- |
| `PEEPHOLE_GITHUB_GATEWAY_ENABLED` | server | unset (route answers `disabled`) |
| `PEEPHOLE_GITHUB_TOKEN` | server secret | required for the gateway |
| `WXT_GITHUB_GATEWAY_ENABLED` | extension build | unset (direct path only) |

Before enabling in production: confirm the token is a scope-less classic PAT,
deploy the server with `PEEPHOLE_GITHUB_GATEWAY_ENABLED=true`, check the
journal has no `GitHub gateway disabled` line after a first signed-in
request, and then ship an extension built with `WXT_GITHUB_GATEWAY_ENABLED=true`.
Rollback: unset the server variable (extensions fall back immediately) or
ship an extension without the build flag.
