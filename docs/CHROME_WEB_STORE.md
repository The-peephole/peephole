# Chrome Web Store listing and release operations

This document is the operator source of truth for the Peephole Chrome Web
Store listing. The listing is public at
[`fieofkhijgngfoflgpkbghbkaidhdgel`](https://chromewebstore.google.com/detail/peephole/fieofkhijgngfoflgpkbghbkaidhdgel).

- **Chrome Web Store public version:** still 0.1.0, updated September 14,
  2026.
- **GitHub release:** v0.2.0 is published. See
  [GitHub Release v0.2.0](https://github.com/The-peephole/peephole/releases/tag/v0.2.0)
  and [RELEASE_V0.2.0.md](RELEASE_V0.2.0.md).
- **Chrome Web Store submission:** v0.2.0 is submitted and under review,
  with automatic publication after approval enabled. It is not yet confirmed
  published.
- The extension ID stays the same.

Public listing fields can be checked without Dashboard access. Permissions,
privacy answers, distribution, account, and policy prompts are Dashboard-only.
The owner completed them for the v0.2.0 submission; the exact answers are not
recorded in this repository. Official references:

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

Category names can change. **NEEDS DASHBOARD VERIFICATION** before a listing
update.

**Full English description (proposed for v0.2.0; the exact text submitted in the Dashboard is not recorded here)**

> Peephole lets you inspect a public GitHub repository before you clone it.
>
> Open a public repository on GitHub and select Peephole from the repository
> header. Peephole analyzes the repository's public metadata and selected
> project files, then shows its detected framework, package manager, runtime,
> repository structure, backend and environment requirements, confirmed
> deployments, and preview compatibility in a Chrome Side Panel that follows
> GitHub's Light, Dark, and Dark Dimmed themes.
>
> Choose any public branch: Peephole resolves it to one exact commit before
> analyzing or previewing it. When a repository contains more than one
> frontend project, Peephole lists the detected candidates so you can select a
> supported target.
>
> For supported projects, connect GitHub and choose Build preview. Peephole
> verifies your GitHub identity, sends the exact public commit (and the target
> you selected) to its preview service, builds it in an isolated,
> resource-limited gVisor sandbox, and displays the resulting static site from
> a separate HTTPS artifact origin.
>
> Peephole supports public repositories only. The production-verified build
> paths are static HTML and root or selected nested Vite + React projects
> using npm with a target-local lockfile. Peephole can recognize additional
> project shapes, including backends, but it previews only supported static
> frontends; Vue and Svelte do not currently produce an executable runner
> plan. A repository may be unsupported or fail to build if it requires a
> backend, private dependency, secret, unsupported package manager, native
> service, or other capability outside that contract.
>
> Peephole does not ask you to create a GitHub personal access token. GitHub App
> OAuth is used only to verify the requester identity for preview jobs; public
> repository analysis uses GitHub's public API path. No analytics or advertising
> SDK is included.
>
> Source code and security documentation:
> https://github.com/The-peephole/peephole

**Published v0.1.0 description (historical; kept for comparison)**

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
> are static HTML and root or selected nested Vite + React projects using npm
> with a target-local lockfile. Peephole can
> recognize additional project shapes, but Vue and Svelte do not currently
> produce an executable runner plan. A repository may be
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

Because this URL tracks `main`, a policy change goes live for every installed
version as soon as it merges. The October 7, 2026 revision is therefore
written version-neutrally: it covers the published v0.1.0 behavior and the
additional v0.2.0 behavior, and it marks the newer behaviors as applying only
to newer versions.

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
| `storage` | Stores the short-lived Peephole session in `browser.storage.session`. Stores a per-tab GitHub theme snapshot (light/dark scheme plus a fixed set of color values) in `browser.storage.session` so the Side Panel matches the page. Removes the legacy PAT key from local storage. | `core/preview/sessionStorage.ts`, `core/sidepanel/themeStorage.ts`, and `core/github/tokenStorage.ts`. | The Storage API permission covers session storage. Persistent GitHub credentials are not stored, and the theme snapshot is UI state that is never sent to a server. Removing it would break login/session handling, theme matching, and legacy cleanup. |
| `https://api.github.com/*` | Fetches public repository metadata, the selected branch's exact commit, a bounded public branch list (up to 100), bounded public Deployments and status records (up to 10 deployments, up to 5 status lookups), root and bounded nested directory listings, and bounded selected public text files for analysis. | `core/github/client.ts`, `core/github/knownFiles.ts`, `core/github/repositoryStructureLoader.ts`, `core/github/backendCandidateLoader.ts`, and `core/github/repositoryDeploymentsLoader.ts`. The extension client is constructed without an OAuth token in `entrypoints/background.ts`. | The exact GitHub API origin is already narrower than GitHub-wide or `<all_urls>` access. Background cross-origin requests require host access. |
| `https://api.3.34.33.24.sslip.io/*` | Starts GitHub sign-in, exchanges the OAuth result for a Peephole session, and creates/reads/cancels preview jobs on the production API. | `core/preview/githubConnection.ts`, `core/preview/apiClient.ts`, and the generated manifest. | Exact HTTPS production API host; no wildcard domain, localhost API host, or `<all_urls>` is requested. |
| Content script `https://github.com/*/*` | Adds the Peephole control only on GitHub owner/repository paths, observes GitHub SPA navigation, reads the current repository identity, and reads a bounded snapshot of the page's computed GitHub/Primer theme colors. | `entrypoints/github.content/index.tsx`, `entrypoints/github.content/githubDom.ts`, and `entrypoints/github.content/githubTheme.ts`. Runtime DOM checks reject non-repository pages. | Chrome match patterns cannot precisely express “exactly a valid GitHub repository route” beyond the two path segments; runtime validation supplies the remaining restriction. |
| Web-accessible `icons/peephole-32.png` on `https://github.com/*` | Lets the GitHub content-script UI display the packaged Peephole icon. | `entrypoints/github.content/mountPeepholeUi.tsx` resolves the packaged icon; `wxt.config.ts` exposes only that icon. | Only one static icon is exposed and only to GitHub pages. |

The generated v0.1.0 manifest has no `activeTab`, `tabs`, `scripting`,
`webRequest`, native messaging, downloads, cookies, or `<all_urls>` permission.
The released v0.2.0 manifest has exactly the same permissions, host
permissions, content-script scope, web-accessible resources, and CSP as
v0.1.0; only `version` differs. See RELEASE_V0.2.0.md for the field-by-field
comparison.

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
| Website content | Yes | Peephole reads the GitHub repository identity from the page. It fetches public repository metadata, branch names/commits, Deployments evidence, root and bounded nested directory listings, and selected public file contents. In v0.2.0 it also reads a bounded snapshot of the page's computed theme colors, which stays local. `entrypoints/github.content/githubDom.ts`, `entrypoints/github.content/githubTheme.ts`, `core/github/client.ts`, `core/github/knownFiles.ts`, `core/github/repositoryStructureLoader.ts`. |
| Web history / browsing activity | Yes, conservatively | The extension processes the current GitHub repository URL for its visible user-facing feature. It does not collect general browser history. `entrypoints/github.content/index.tsx` and `utils/githubUrl.ts`. If the Dashboard distinguishes current-page website content from history, use its definitions and keep the public explanation explicit. |
| User activity | Likely no | No clickstream, analytics, ad measurement, or behavioral profile is sent or stored. Preview button actions necessarily create requested jobs, but no separate activity analytics exists. **NEEDS DASHBOARD VERIFICATION** because the label definition may encompass service interactions. |
| Location | Yes in the published listing, conservatively | No geolocation API or location-inference feature exists. The service processes a requester IP for abuse quotas, so the published listing discloses location conservatively even though Peephole does not derive or store a location. `services/preview-api/requesterIp.ts`, `services/preview-api/postgres/quota.ts`. |
| Financial, health, communications, or form data | No | Peephole has no such feature or permission. Public repositories could contain arbitrary public text, but the extension reads only the bounded analysis files and a requested build processes the public commit. |

**v0.2.0 working conclusion (not Dashboard certification):** the five
behaviors added since v0.1.0 introduce no new user-data category. Branch,
Deployments, and nested-file data are public GitHub repository / website
content. The selected `sourceRoot` is public repository target metadata.
Theme colors are local session UI state. None is financial, health,
communications, form, advertising, tracking, or persistent-credential data.
Every checkbox, the User activity and Location answers, the remote-code
declaration, category, certifications, 2FA/account state, and distribution
settings are **MANUAL** Dashboard items. The owner completed them when
submitting v0.2.0 for review; the exact answers are not recorded in this
repository. Re-check them against this recommendation before any later
submission.

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
| Public repository ID, default branch, commit, homepage, root entries, and selected text files | GitHub API to extension | Background memory caches only. |
| Public branch names and their commits (v0.2.0; up to 100) | GitHub API to extension; a selected branch is resolved to one exact commit before analysis/preview | Background memory only; never persisted or sent to Peephole except as the resolved commit SHA of a requested preview. |
| Deployment evidence (v0.2.0; up to 10 deployments, up to 5 status lookups) | GitHub API to extension; keeps only deployment ID, ref, commit SHA, environment name/production flag, status state, environment URL, and timestamps | Background memory only. The environment URL is shown as an external link, never fetched, crawled, or embedded (`core/github/externalUrlPolicy.ts`). |
| Bounded nested project paths and files (v0.2.0) | GitHub API to extension: up to 8 directory listings of up to 200 entries each, up to 20 candidate probes, and bounded nested `package.json`/lockfile/env-template reads within fixed byte budgets | Background memory only. Env templates yield variable names only; real `.env` files are never requested. |
| GitHub theme snapshot (v0.2.0) | Page computed styles to content script, then background, then Side Panel | `browser.storage.session`, keyed by tab (`peepholeGitHubTheme:<tabId>`). Light/dark scheme plus a fixed set of color values; never sent to a server. |
| Preview request | Extension to Peephole: repository ID/owner/name, commit SHA, preview contract version and, when a target is explicitly selected (v0.2.0), that target's `sourceRoot` | The server independently validates the requested target and resolves the build plan from GitHub; the extension never sends a plan or command. Repository, target, and the server-resolved build plan are stored in the preview job row. No automated deletion schedule for the row is implemented. |
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

Official CWS guidance requires the following assets. It was rechecked on
October 7, 2026 against <https://developer.chrome.com/docs/webstore/images>,
whose page reports a last update of June 11, 2018.

- a PNG 128×128 icon;
- at least one (up to five) square-cornered, full-bleed 1280×800 or 640×400
  screenshot showing the actual user experience;
- a 440×280 small promotional tile that fills the region and avoids text;
- optionally, a 1400×560 marquee.

### v0.2.0 asset status

| Asset | v0.2.0 status |
| --- | --- |
| Icons 16/32/48/128 | **Reusable.** Unchanged since v0.1.0; packaged in the v0.2.0 ZIP. |
| `store-assets/peephole-promo-440x280.png` | **Reusable.** Derived only from the unchanged icon; no UI depicted. |
| `store-assets/peephole-screenshot-01-1280x800.png` | **Superseded for v0.2.0 (repository copy).** It shows the v0.1.0 Side Panel, captured before GitHub theme synchronization, Branch Preview, structure/target selection, and deployment evidence existed. |
| v0.2.0 listing screenshot(s) | **Managed in the Dashboard; which images accompany the v0.2.0 submission is not recorded in the repository.** The preferred candidate was the owner's October 7, 2026 Dark capture of the unpacked v0.2.0 build (frontend target selected, "Native preview compatible"). No v0.2.0 capture is committed under `store-assets/`, so no repository audit applies yet. If one is committed later, audit it as in v0.1.0 below (exactly 1280×800 or 640×400, full bleed, real UI, no session token, OAuth URL, DevTools, or personal data). |
| Other manual-smoke captures | **Not listing images.** The branch-blocked Dark capture (`feat/m10-generated-secret-fixture`, "Native preview blocked") and the Light capture showing the GitHub API rate-limit message are verification and error-handling evidence only; do not use the rate-limit capture as a listing image. |
| Additional Light / Dark Dimmed screenshots | **Optional follow-up**, not a v0.2.0 blocker unless the live Dashboard requires them. |
| Marquee 1400×560 | Optional; not present. |

The v0.1.0 audit below is kept as the historical record.

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

### Screenshot (v0.1.0 historical record)

`SCREENSHOT = PASS` for v0.1.0 only (see the v0.2.0 status above). The file was captured fresh by the user directly from a
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

The manifest permissions and the dimensions, byte sizes, and SHA-256 values of
the screenshot and promo tile above were rechecked against the local v0.1.0
release package and repository assets on September 16, 2026. The recorded
v0.1.0 screenshot remains a release snapshot. GitHub theme synchronization was
implemented afterward, so the next store release requires fresh Light, Dark,
and Dark Dimmed screenshot review before reusing or replacing listing assets.

## OAuth extension-ID release gate

The Peephole server accepts only redirect URIs of the exact form
`https://<allowed-extension-id>.chromiumapp.org/github`, where the extension ID
must be listed in server-side `PEEPHOLE_ALLOWED_EXTENSION_IDS`. The published
v0.1.0 ID is `fieofkhijgngfoflgpkbghbkaidhdgel`.

On September 16, 2026, the public production OAuth start endpoint accepted the
exact redirect URI for that ID and returned a GitHub authorization redirect
with signed state and an S256 PKCE challenge. This verifies the current start
endpoint allowlist only. It is not evidence that a user completed GitHub OAuth,
that the session exchange succeeded, or that a preview build passed from the
Web Store installation.

On October 7, 2026, during the M11-E4/E5/E6 production acceptance runs, the
**published v0.1.0** Web Store installation completed **Connect GitHub**
repeatedly. Each issued Peephole session authenticated against the production
API and was used for authenticated production previews. That is production
evidence for the v0.1.0 package and the shared extension ID, not a v0.2.0
package test. v0.2.0 keeps the same ID and is submitted for review, so its
own Connect GitHub check remains PENDING until the Store publishes v0.2.0
under that ID.

For a future extension-ID change:

1. Record and validate the new 32-letter Web Store ID.
2. Add it to production `PEEPHOLE_ALLOWED_EXTENSION_IDS` through a controlled
   configuration change without exposing the value.
3. Preserve existing approved IDs until migration is complete.
4. Restart only the Peephole service, then verify `/healthz` and `/readyz`.
5. Test **Connect GitHub** and session issuance end to end from the Web Store
   build.
6. Run the separately documented production smoke checks.

Do not remove an existing extension ID until its migration is complete.
