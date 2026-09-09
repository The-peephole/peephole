# GitHub App authentication

Peephole uses a GitHub App only to establish user identity. The browser
extension never receives or stores a GitHub user access token. Existing public
repository fetching, preview jobs, workers, gVisor isolation, artifact serving,
and caches are outside this authentication change.

## Current access-session flow

1. The extension creates a cryptographically random client nonce and PKCE
   verifier, derives the S256 challenge, and obtains its callback from
   `browser.identity.getRedirectURL("github")`.
2. `browser.identity.launchWebAuthFlow` opens
   `GET /v1/auth/github/start?redirect_uri=...&client_state=...&code_challenge=...`.
3. The Preview API accepts the redirect only when its extension ID is in
   `PEEPHOLE_ALLOWED_EXTENSION_IDS` and its exact form is
   `https://<allowed-extension-id>.chromiumapp.org/github`.
4. The API HMAC-signs a short-lived state value binding the approved redirect,
   client nonce, PKCE challenge, and expiry, then redirects to GitHub.
5. GitHub redirects to `GET /v1/auth/github/callback`. The API verifies the
   state before returning the one-time code, signed state, and nonce to the
   approved extension callback in the URL fragment.
6. The extension verifies the nonce and calls `POST /v1/auth/session` with the
   code, signed state, and in-memory PKCE verifier.
7. The API verifies state and PKCE, exchanges the code using the server-only
   GitHub App Client Secret, and calls GitHub `GET /user`.
8. The API derives requester subject `github:<id>`, discards the GitHub user
   access token, and uses the existing `PreviewSessionIssuer` to return a
   30-minute Peephole access session.
9. The extension stores only that Peephole session in
   `browser.storage.session`. `PreviewSessionAuth` protects all subsequent
   preview API calls.

The authorization code and PKCE verifier live only for the active flow. OAuth
errors and upstream responses are bounded and returned without secret details.
HMAC state expiry is ten minutes. A GitHub code is one-use, while nonce
comparison binds the browser completion to the flow the extension initiated.

## Production E2E verification

**Status:** Verified on 2026-09-09

The deployed production path has been exercised end to end with the real
Chrome Extension, GitHub, Preview API, production worker, and artifact origin:

- [x] GitHub App OAuth authorization and callback
- [x] PKCE S256 challenge and verifier
- [x] HMAC-signed state validation
- [x] allowlisted `chromiumapp.org` Extension redirect
- [x] GitHub identity resolution and Peephole session issuance
- [x] authenticated preview request and gVisor preview build
- [x] HTTPS artifact publication and SidePanel embedding

This records an actual production E2E run, not only unit, integration, or
local-development coverage. Private repository Installation Access Tokens and
refreshable Peephole sessions remain outside the verified scope.

## Expiry and reconnect MVP

The current access session deliberately keeps its existing 30-minute TTL. On
expiry or an API `401`, the client removes it from `browser.storage.session`,
shows **Connect GitHub**, and can resume the attempted preview after a new
login. Closing the browser session also drops the credential.

This means a user may need to authorize again after 30 minutes. Implementing a
long-lived bearer in `browser.storage.local` would undo the storage hardening,
so this milestone does not pretend that an unsigned or stateless token is a
safe refresh mechanism.

The refresh follow-up is isolated from preview execution by the current
boundaries: `GitHubAppOAuth` acquires identity, `PreviewSessionIssuer` creates
access sessions, `PreviewApiClient` consumes them, and `sessionStorage.ts`
owns browser persistence. A production refresh design should add:

- a separate opaque Peephole refresh credential with a distinct audience and
  longer, bounded TTL;
- server-side storage of only a hash of that credential, associated with the
  `github:<id>` subject and device/session metadata;
- rotation on every refresh, reuse detection, explicit revocation, and a
  bounded session family lifetime;
- a dedicated refresh endpoint that can mint only short-lived Peephole access
  sessions, never GitHub or preview-job credentials;
- an explicit product decision about persistent browser storage and sign-out
  semantics before the refresh credential is placed in
  `browser.storage.local`.

Until those controls exist, reconnect is the supported and safer MVP.

## Production environment

All entries below are server-side deployment secrets or configuration except
the already-public API base URL. None may use a `WXT_` prefix except
`WXT_PREVIEW_API_BASE_URL`.

| Variable | Secret | Purpose |
| --- | --- | --- |
| `PEEPHOLE_GITHUB_APP_CLIENT_ID` | No | GitHub App OAuth client identifier |
| `PEEPHOLE_GITHUB_APP_CLIENT_SECRET` | Yes | Server-side authorization-code exchange |
| `PEEPHOLE_GITHUB_APP_CALLBACK_URL` | No | Exact HTTPS Preview API callback ending in `/v1/auth/github/callback` |
| `PEEPHOLE_ALLOWED_EXTENSION_IDS` | No | Comma-separated production Chrome Extension ID allowlist |
| `PEEPHOLE_GITHUB_OAUTH_STATE_SECRET` | Yes | HMAC key for redirect, nonce, PKCE challenge, and expiry state |
| `PEEPHOLE_SESSION_SIGNING_SECRET` | Yes | HMAC key for short-lived Peephole access sessions |
| `WXT_PREVIEW_API_BASE_URL` | No | Public Preview API origin compiled into the extension |

The GitHub App Client Secret, any GitHub App private key, and both signing
secrets must live in the server secret manager. They must never be named with
`WXT_`, copied into `.env` files used by extension bundling, or exposed in
client responses.

## Explicit non-goals

- GitHub App Installation Access Tokens and private repository access
- changes to public repository resolution or archive fetching
- authentication, authorization, or credentials inside the preview sandbox
- changes to the preview queue, worker, gVisor, artifact, or cache pipelines
