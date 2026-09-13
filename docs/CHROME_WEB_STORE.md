# Chrome Web Store submission copy

This document is the operator source of truth for the Peephole v0.1.0 Chrome
Web Store listing. Copy values only after checking them against the final ZIP
and the current Developer Dashboard. Official references:

- [Privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User Data Policy](https://developer.chrome.com/docs/webstore/user_data)
- [Manifest V3 remote-code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [Store image requirements](https://developer.chrome.com/docs/webstore/images)

## Listing

**Product name**

> Peephole

**Short summary**

> Analyze public GitHub repositories and preview supported static frontends in an isolated Chrome Side Panel.

**Canonical language**

> English

**Recommended category**

> Developer Tools

Category names can change. **NEEDS DASHBOARD VERIFICATION** before submission.

**Full English description**

> Peephole lets you inspect a public GitHub repository before you clone it.
>
> Open a public repository on GitHub and select Peephole from the repository
> header. Peephole analyzes the repository's public metadata and selected
> project files, then shows its detected framework, package manager, runtime,
> environment requirements, deployment hints, and preview compatibility in a
> Chrome Side Panel.
>
> For supported projects, connect GitHub and choose Build preview. Peephole
> verifies your GitHub identity, sends the exact public commit to its preview
> service, builds it in an isolated, resource-limited gVisor sandbox, and
> displays the resulting static site from a separate HTTPS artifact origin.
>
> v0.1 supports public repositories only. The production-verified build paths
> are static HTML and root-level Vite + React projects using npm. Peephole can
> recognize additional project shapes, but Vue and Svelte do not yet have the
> same production golden-path and security verification. A repository may be
> unsupported or fail to build if it requires a backend, private dependency,
> secret, monorepo selection, unsupported package manager, native service, or
> other capability outside the static-v1 contract.
>
> Peephole does not ask you to create a GitHub personal access token. GitHub App
> OAuth is used only to verify the requester identity for preview jobs; public
> repository analysis uses GitHub's public API path. No analytics or advertising
> SDK is included.
>
> Source code and security documentation:
> https://github.com/The-peephole/peephole

**Homepage URL recommendation**

> https://github.com/The-peephole/peephole

**Support URL recommendation**

> https://github.com/The-peephole/peephole/issues

**Privacy policy URL**

> https://github.com/The-peephole/peephole/blob/main/PRIVACY.md

Verified as an unauthenticated HTTPS GET returning `200` and rendering the
actual Peephole Privacy Policy content (checked after PR #4 merged
`PRIVACY.md` to `main`). This GitHub-hosted URL is acceptable as the initial
v0.1.0 Chrome Web Store privacy-policy URL; a dedicated GitHub Pages site was
not set up for this task.

**Source URL**

> https://github.com/The-peephole/peephole

## Privacy tab

### Single purpose

> Peephole analyzes the public GitHub repository currently open by the user and, on explicit request, creates an isolated static preview of a supported public commit in the Chrome Side Panel.

### Permission justifications

| Permission or scope | Copy-ready justification | Source rationale | Narrower option |
| --- | --- | --- | --- |
| `identity` | Uses Chrome's identity API to launch GitHub App OAuth and receive the extension-specific `chromiumapp.org/github` callback. | `core/preview/githubConnection.ts` calls `browser.identity.getRedirectURL()` and `launchWebAuthFlow()`. | No narrower Chrome API provides this extension OAuth callback flow. It is used only after **Connect GitHub**. |
| `sidePanel` | Opens and updates Peephole's repository analysis and preview UI in Chrome's Side Panel. | `core/sidepanel/messages.ts` calls the Side Panel API; `sidepanel.html` is the declared panel. | Required for the user-facing Side Panel. No `tabs` or broad scripting permission is requested. |
| `storage` | Stores the short-lived Peephole session in `browser.storage.session` and removes the legacy PAT key from local storage. | `core/preview/sessionStorage.ts` and `core/github/tokenStorage.ts`. | The Storage API permission covers session storage; persistent GitHub credentials are not stored. Removing it would break login/session handling and legacy cleanup. |
| `https://api.github.com/*` | Fetches public repository metadata, the default-branch commit, root file entries, and bounded selected public text files for analysis. | `core/github/client.ts` and `core/github/knownFiles.ts`. The extension client is constructed without an OAuth token in `entrypoints/background.ts`. | The exact GitHub API origin is already narrower than GitHub-wide or `<all_urls>` access. Background cross-origin requests require host access. |
| `https://api.3.34.33.24.sslip.io/*` | Starts GitHub sign-in, exchanges the OAuth result for a Peephole session, and creates/reads/cancels preview jobs on the production API. | `core/preview/githubConnection.ts`, `core/preview/apiClient.ts`, and the generated manifest. | Exact HTTPS production API host; no wildcard domain, localhost API host, or `<all_urls>` is requested. |
| Content script `https://github.com/*/*` | Adds the Peephole control only on GitHub owner/repository paths, observes GitHub SPA navigation, and reads the current repository identity. | `entrypoints/github.content/index.tsx` and `entrypoints/github.content/githubDom.ts`. Runtime DOM checks reject non-repository pages. | Chrome match patterns cannot precisely express “exactly a valid GitHub repository route” beyond the two path segments; runtime validation supplies the remaining restriction. |
| Web-accessible `icons/peephole-32.png` on `https://github.com/*` | Lets the GitHub content-script UI display the packaged Peephole icon. | `entrypoints/github.content/mountPeepholeUi.tsx` resolves the packaged icon; `wxt.config.ts` exposes only that icon. | Only one static icon is exposed and only to GitHub pages. |

The generated v0.1.0 manifest has no `activeTab`, `tabs`, `scripting`,
`webRequest`, native messaging, downloads, cookies, or `<all_urls>` permission.

### Remote code

Recommended answer:

> No, I am not using remote code.

**NEEDS DASHBOARD VERIFICATION.** All extension-privileged JavaScript is
bundled in the release ZIP and the MV3 extension-page CSP permits scripts only
from `'self'`. GitHub and Peephole responses are treated as data, not evaluated
as extension code. A completed preview can contain JavaScript built from the
public repository, but it loads in a cross-origin HTTPS iframe with no extension
API access. Chrome's MV3 policy separately describes code in contexts isolated
from extension APIs, including iframes; the reviewer explanation must mention
this architecture rather than imply that artifact code is bundled extension
logic. Source: `components/PreviewJobPanel.tsx`, `core/preview/config.ts`,
`wxt.config.ts`, and the generated CSP.

### User-data disclosure recommendations

Dashboard labels can change, so every checkbox below is **NEEDS DASHBOARD
VERIFICATION** against the live form. Select all live categories that encompass
the behavior; do not optimize for fewer disclosures.

| Recommended disclosure | Answer | Exact Peephole behavior and source |
| --- | --- | --- |
| Authentication information | Yes | OAuth code, signed state and PKCE verifier are exchanged; the server transiently handles a GitHub access token and the extension stores a short-lived Peephole bearer session in session storage. `core/preview/githubConnection.ts`, `core/preview/sessionStorage.ts`, `services/preview-api/githubAppOAuth.ts`. |
| Personally identifiable information / user identifier | Yes | The GitHub numeric user ID is converted to `github:<id>` and persisted as the preview requester ID. `services/preview-api/githubAppOAuth.ts`, `services/preview-api/previewSession.ts`, `services/preview-api/postgres/migrations/001_initial.sql`. |
| Website content | Yes | Peephole reads the GitHub repository identity from the page and fetches public metadata, root entries, and selected public file contents. `entrypoints/github.content/githubDom.ts`, `core/github/client.ts`, `core/github/knownFiles.ts`. |
| Web history / browsing activity | Yes, conservatively | The extension processes the current GitHub repository URL for its visible user-facing feature. It does not collect general browser history. `entrypoints/github.content/index.tsx` and `utils/githubUrl.ts`. If the Dashboard distinguishes current-page website content from history, use its definitions and keep the public explanation explicit. |
| User activity | Likely no | No clickstream, analytics, ad measurement, or behavioral profile is sent or stored. Preview button actions necessarily create requested jobs, but no separate activity analytics exists. **NEEDS DASHBOARD VERIFICATION** because the label definition may encompass service interactions. |
| Location | No | No geolocation API or location inference feature exists. A requester IP is used for abuse quotas, not location. `services/preview-api/requesterIp.ts`, `services/preview-api/postgres/quota.ts`. |
| Financial, health, communications, or form data | No | Peephole has no such feature or permission. Public repositories could contain arbitrary public text, but the extension reads only the bounded analysis files and a requested build processes the public commit. |

Certification statements should be accepted only while the implementation and
published `PRIVACY.md` remain accurate:

- data is used only to provide or improve the single purpose and related
  security/operations;
- data is not sold or transferred except as necessary to provide the feature,
  for security, legal compliance, or another Limited Use exception;
- data is not used for personalized advertising, lending, or credit decisions;
  and
- humans do not read user data except with specific consent, for security, when
  required by law, or as permitted for aggregated/anonymized internal use.

## Data-flow audit supporting the disclosure

| Data | Where it goes | Storage and expiry proved by code |
| --- | --- | --- |
| GitHub repository URL/owner/name | Page to content script/background; public requests to GitHub | Background memory caches only; current-ref cache is 60 seconds and commit analysis lasts for the background process. |
| Public repository ID, branch, commit, homepage, root entries, and selected text files | GitHub API to extension; for requested previews, only the repository ID/owner/name/commit SHA and preview contract version go to Peephole — the server independently resolves and validates the build plan from GitHub, it is not sent by the extension | Repository and the server-resolved build plan are stored in the preview job row. No automated deletion schedule for the row is implemented. |
| OAuth code, signed state, PKCE verifier | Extension, Peephole API, GitHub | Signed state expires in 10 minutes. No server database persistence was found for these values. |
| GitHub OAuth access token | GitHub to Peephole API and back to GitHub `/user` | Held transiently in `GitHubAppOAuth.issueSession()`; no persistence path was found and it is never returned to the extension. |
| Numeric GitHub user ID | GitHub to Peephole API | Encoded as the signed session subject and persisted as `requester_id` in preview jobs; hashed forms participate in quotas. Historical job-row deletion is not implemented. |
| Peephole session token | Peephole API to extension and on later preview API requests | Stateless HMAC token, normally 30 minutes; stored only in `browser.storage.session`, cleared on disconnect/401/expiry. |
| Requester IP | Reverse proxy/API to quota logic | Plain IP is processed in memory. PostgreSQL stores SHA-256 scope hashes; quota-row deletion is not implemented. Proxy/infrastructure logs are deployment-dependent. |
| Job, queue, cache, error, and artifact metadata | Peephole API/worker to PostgreSQL | Job execution expiry starts at 15 minutes; a successful artifact is normally valid for 60 minutes. Expiry does not delete all job/cache/quota/cancelled-queue rows. |
| Static preview artifact | Sandbox to production artifact disk and isolated artifact host | Normally authorized for 60 minutes; maintenance runs every 60 seconds. Unsigned orphan directories have a two-hour grace period. |
| Server logs | Application errors/startup events to stdout/stderr and production journal | No application-level per-request access logger was found. Journal, Caddy/access-log, backup, and infrastructure retention is not established in this repository. |

Third parties are GitHub for OAuth/public source, public package registries and
package hosts used by the repository during `npm ci`, and production
hosting/network infrastructure (currently AWS). Install-stage repository code
can contact public Internet endpoints from inside the sandbox; private,
link-local, metadata, host, and peer-sandbox destinations are blocked.

## Asset checklist

Official CWS guidance requires a PNG 128×128 icon, at least one full-bleed
1280×800 or 640×400 screenshot, and a 440×280 PNG/JPEG small promotional tile.

| Asset | Audit result | Status/action |
| --- | --- | --- |
| `public/icons/peephole-16.png` | Valid RGBA PNG, 16×16 | PASS for manifest use |
| `public/icons/peephole-32.png` | Valid RGBA PNG, 32×32 | PASS for manifest/content UI use |
| `public/icons/peephole-48.png` | Valid RGBA PNG, 48×48 | PASS for manifest use |
| `public/icons/peephole-128.png` | Valid RGBA PNG, 128×128; artwork fills the full canvas (alpha never drops below 222/255, so there is no dedicated transparent margin) | PASS. Composited onto white, dark-gray (#202020), and black test backgrounds: readable on all three, because the photo's own dark vignette ring supplies its contrast rather than the page background. No redesign made in this task; a slightly larger transparent margin is an optional future nicety, not a blocker. |
| `store-assets/peephole-promo-440x280.png` | Generated in this task: exactly 440×280 RGB PNG, 70,565 bytes, SHA-256 `cd54a96fced9af48daf53852d76435904d230eeceeb038e7f5d9716d68717a55` | PASS. Built deterministically from `public/icons/peephole-128.png` only (Pillow, no new npm dependency): the icon is centered at 224×224 on a solid background sampled from the icon's own corner/vignette color (~RGB 5,4,3), so the fill is derived from the real asset rather than an invented brand color. No text, no fake browser/GitHub/Chrome UI, not a stretched screenshot. Verified to open, verify as a valid PNG, and stay legible when downscaled to 220×140. |
| `image/peephole_demo_img.png` | Valid opaque PNG, 1905×911 (aspect 2.091) | BLOCKED as a direct screenshot source. Measured pixel-for-pixel: the Peephole side panel occupies x=1231–1905 (674px) and GitHub's own breadcrumb/file-listing content occupies roughly x=0–447 of every row. Reaching the required 1.6 aspect (1280×800 or 640×400) from 1905×911 needs a 447px-narrower crop; taking it from the left truncates file/folder names and the repository breadcrumb on every row, and taking it from the right cuts through the Peephole panel's stat-card grid and chart. Either direction materially misrepresents the UI, so no crop of this file is used. See "Screenshot" below for the required fresh capture. |
| `image/peephole-demo.gif` | Valid 960×510 animated GIF, 296 frames | README demo only; not a compliant store screenshot or promo tile. |
| Marquee tile | Not present | OPTIONAL: 1400×560 PNG/JPEG. |
| `store-assets/peephole-screenshot-01-1280x800.png` | Real user-supplied capture in this task: exactly 1280×800 RGB PNG, 287,076 bytes, SHA-256 `1085d62ff0d5c5cbb10067a3a6e69cafdf1e91f3e58eac0ee21e6908f3423119` | PASS. See "Screenshot" below. |

### Screenshot

`SCREENSHOT = PASS`. The file was captured fresh by the user directly from a
real Chrome window running the extension against the `peephole-complex-fixture`
GitHub repository — it was supplied natively at 1280×800, so no crop, resize,
or other transformation was applied; the bytes committed are exactly the
bytes supplied.

Verified before use:

- Format/dimensions: PNG, RGB, exactly 1280×800 (`PIL.Image.open(...).size`).
- No letterboxing: sampled every edge row/column and found real, non-uniform
  content reaching all four edges of the frame — full-bleed, no padding bars.
- Actual product capture, not a mockup: shows the real GitHub file listing
  (`peephole-complex-fixture`, commit `50af2a2`, "8 Commits", Languages bar,
  Contributors, Suggested workflows) alongside the real Peephole Side Panel
  (`Peephole` header, `Commit 50af2a2`, `Native preview compatible`,
  `Preview ready`, and an actual rendered preview result). The GitHub side is
  recognizable via the file table, Code button, About/Releases/Packages/
  Languages/Contributors sidebar, and Suggested workflows widget; the specific
  top breadcrumb/repo title happened to be scrolled above the captured
  viewport, which is an honest consequence of the real window's scroll
  position, not a crop.
- No DevTools panel, no visible browser chrome/address bar/bookmarks, no
  session token, no OAuth callback URL, no API key or secret string visible
  anywhere in the frame.
- Avatars in frame are generic placeholder icons from the fixture repository,
  not a real person's photo or other personal information.

This replaces the earlier `image/peephole_demo_img.png` (1905×911) candidate
audited above, which was rejected because no truthful 1.6:1 crop of it existed
without cutting file-list text or the Peephole panel.

The duplicate PNG icons under `image/` have the same dimensions and byte sizes
as the packaged icons. Store upload should use the audited 128×128 PNG; the ZIP
already contains `icons/peephole-128.png`.

## OAuth extension-ID release gate

The Peephole server accepts only redirect URIs of the exact form
`https://<allowed-extension-id>.chromiumapp.org/github`, where the extension ID
must be listed in server-side `PEEPHOLE_ALLOWED_EXTENSION_IDS`. The Web Store
item gets its own stable ID, so the draft ID is a hard gate:

1. Upload the v0.1.0 ZIP as a Chrome Web Store draft.
2. Record the exact Web Store extension ID.
3. Verify it is exactly 32 lowercase letters in Chrome's `a`–`p` alphabet.
4. Add that ID to production `PEEPHOLE_ALLOWED_EXTENSION_IDS` without exposing
   the config value.
5. Preserve existing approved IDs until migration is complete.
6. Perform a controlled `peephole` service restart; do not restart Caddy unless
   an unrelated approved change requires it.
7. Verify `/healthz` and `/readyz`.
8. Install and test the Web Store trusted-tester build.
9. Test **Connect GitHub** end to end.
10. Run the documented production smoke checks.
11. Submit for public review only after every gate succeeds.

Do not remove an existing extension ID during release preparation.
