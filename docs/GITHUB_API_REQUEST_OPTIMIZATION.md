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
  aborted only when every subscriber has cancelled.
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

## Authentication architecture options

| Option | Security and operations | Assessment |
| --- | --- | --- |
| Minimize unauthenticated client requests | No new secrets or server trust boundary; small implementation and operations cost. Still limited per originating IP and the cache disappears with the service worker. | Implemented here; appropriate immediate mitigation, not a scale guarantee. |
| Authenticated GitHub requests through Peephole | Keeps credentials server-side and raises the available authenticated quota. Requires a deliberate GitHub App installation/user-token model, least-privilege scopes, repository authorization, abuse controls, quota isolation, audit logging, and new API availability dependencies. | Best long-term path if E2E or user traffic regularly exhausts public quota; separate design/PR required. |
| Limited server cache for public repository data | Shares immutable commit objects across clients and shields browsers from repeat reads. Requires bounded storage, eviction/staleness policy for refs, tenant/abuse limits, observability, and careful cache keys. It can also concentrate all misses onto one server quota. | Useful with the authenticated proxy, but insufficient as an unbounded anonymous proxy; separate design/PR required. |

No authentication architecture, server endpoint, OAuth behavior, or
production configuration changes are included in this work.
