# Peephole v0.2.0 release-candidate record

Peephole v0.2.0 is a **release candidate**. It has **not** been submitted to
or published on the Chrome Web Store. The Web Store currently publishes v0.1.0
under the unchanged extension ID `fieofkhijgngfoflgpkbghbkaidhdgel`. No
`v0.2.0` tag or GitHub Release exists yet. The v0.1.0 record is kept unchanged
in [RELEASE_V0.1.0.md](RELEASE_V0.1.0.md).

Status meanings:
- **PASS:** the named fact was directly verified for this candidate.
- **MANUAL:** requires the owner or the live Developer Dashboard.
- **PENDING:** not yet done.
- **N/A:** does not apply before publication.

## Scope

v0.1.0 (`f146cb772db2a5168608bdba7463198ea7e8a6a0`) to the release-candidate
base `main` (`6d0da48b7095a519a10748cb83bd2fbaf944ef12`) is 38 commits and 280
changed files. Of those, 63 changed files are in the packaged extension
(reachable from `entrypoints/`); the rest are server/runtime, tests, docs, and
tooling.

A minor version is used because the extension gained user-facing
functionality.

### User-facing extension changes (Store-claimable)

- Branch selection, resolved to an exact commit before analysis/preview.
- Side Panel synchronization with GitHub Light, Dark, and Dark Dimmed themes.
- Richer repository/application structure analysis, with bounded nested
  project detection.
- Explicit selection of a supported frontend target.
- Confirmed deployment evidence from GitHub Deployments.
- Richer backend detection and environment-requirement analysis (analysis
  only).
- Side Panel UX improvements.

### Not Store-claimable

The production service supports the narrow M9/M10/M11 `backend-v1`,
`fullstack-v1`, generated-secret, and temporary-PostgreSQL contracts, but the
extension offers no UI path to them. The `BackendRuntimeControl` component is
compiled into the Side Panel bundle, but it renders only when
`WXT_BACKEND_RUNTIME_ENABLED=true`. That variable is unset in this build, and
the package contains no backend-runtime or full-stack endpoint path.

## Build record

| Item | Status | Evidence |
| --- | --- | --- |
| Packaged extension source | PASS | Built from commit `4f546314a2ae1247b4a7d4fc8808af0cba2b9e20` (`release: prepare Peephole v0.2.0`) in a fresh detached `git worktree` with no `.env`/`.env.local`. The follow-up commit that adds this record changes only this file. |
| Package version | PASS | `package.json` and the `package-lock.json` root package are `0.2.0`. Analyzer, protocol, and contract versions are unchanged. |
| Manifest version | PASS | `wxt.config.ts` is `0.2.0`; the generated manifest has `"version":"0.2.0"` and `"manifest_version":3`. |
| Public build configuration | PASS | Only `WXT_PREVIEW_API_BASE_URL=https://api.3.34.33.24.sslip.io/` and `WXT_PREVIEW_ARTIFACT_BASE_DOMAIN=3.34.33.24.nip.io`, passed as process environment. No server secret is a `WXT_` value, and `WXT_BACKEND_RUNTIME_ENABLED` is unset. |
| Production API availability | PASS | Public `/healthz` and `/readyz` returned 200 on October 7, 2026. This is endpoint availability, not a release smoke. |
| Build environment | PASS | Windows 11 (MINGW64/Git Bash), Node `v24.12.0`, npm `11.6.2`. |
| `npm ci` | PASS | Exit 0; 307 packages. Dependencies are unchanged from v0.1.0; only the lockfile root version changed. |
| Dependency audit | PASS (prod) / NOTE (dev) | `npm audit --omit=dev`: 0 vulnerabilities. Full `npm audit` reports 3 high-severity advisories in transitive **dev/build** dependencies (`brace-expansion`, `source-map-js`, `undici`). None of these packages appears in the extension ZIP. Left for a separate dependency PR. |
| `npm run format:check` | PASS | All matched files use Prettier style. |
| `npm run lint` | PASS | Exit 0. |
| `npm run typecheck` | PASS | Exit 0. |
| `npm test` | PASS | 120 files passed / 12 skipped; 1,942 tests passed / 69 skipped. The skipped tests are the environment-gated real-gVisor/PostgreSQL suites. |
| `npm run build` | PASS | Exit 0; 589.86 kB unpacked. |
| Release ZIP | PASS | `npm run zip` produced `.output/peephole-0.2.0-chrome.zip`: 218,512 bytes, SHA-256 `16f3fae202aef28d9803e831fed359cee0f429df6ef0d5c49b5370884b7583b0`. Re-running `npm run zip` produced a byte-identical ZIP (same SHA-256). The ZIP is git-ignored and not committed. |

### Package contents

`manifest.json`, `background.js`, `content-scripts/github.js`,
`sidepanel.html`, `options.html`, `chunks/{jsx-runtime,options,sidepanel}-*.js`,
`assets/{options,sidepanel}-*.css`, and `icons/peephole-{16,32,48,128}.png`.
There are no `.env`, `.pem`, or `.key` files.

### Generated manifest comparison with v0.1.0

Compared directly from the extracted v0.2.0 ZIP and the retained
`peephole-0.1.0-chrome.zip` (SHA-256 `56979f68…42d7a`, rechecked).

| Field | v0.1.0 → v0.2.0 |
| --- | --- |
| `manifest_version` | 3 → 3 (same) |
| `name` / `description` / `icons` | same |
| `version` | `0.1.0` → `0.2.0` (**only difference**) |
| `minimum_chrome_version` | `116` (same; required by the Side Panel API usage) |
| `permissions` | `identity`, `sidePanel`, `storage` (same) |
| `host_permissions` | `https://api.github.com/*`, `https://api.3.34.33.24.sslip.io/*` (same; no `<all_urls>`) |
| `content_scripts` | `https://github.com/*/*`, `document_idle`, `content-scripts/github.js` (same) |
| `web_accessible_resources` | `icons/peephole-32.png` for `https://github.com/*` (same) |
| `content_security_policy.extension_pages` | `script-src 'self'; object-src 'self'; frame-src 'self' http://127.0.0.1:* https://*.3.34.33.24.nip.io;` (same) |
| `background` / `options_ui` / `side_panel` | same |

No new permission or host was added. As in v0.1.0, the loopback `frame-src`
is the local-development artifact frame only. It is not a host permission and
cannot authorize an API request.

### Package secret scan

The extracted ZIP was scanned as binary-safe text (`grep -a`), file by file.
Every pattern had **0** matches:
- `.env` file references at a path boundary;
- PEM private keys;
- GitHub token formats (`github_pat_…`, `gh[pousr]_…`);
- Peephole session-token shape;
- `postgres(ql)://…@` credentials;
- SCRAM verifier material (`SCRAM-SHA-256$…`);
- AWS key IDs and secret names;
- `CLIENT_SECRET`/`SIGNING_SECRET`/`STATE_SECRET` with a value;
- `replace-me`/`replace-with-` example values;
- server-only `PEEPHOLE_*` secret variable names;
- the tenant DB address and provisioning socket path.

Expected harmless content:
- `WXT_PREVIEW_API_BASE_URL`/`WXT_PREVIEW_ARTIFACT_BASE_DOMAIN` as names
  inside configuration-error messages;
- the public production API and artifact domain;
- analyzer filename lists such as `.env.example` and secret-like
  variable-name patterns, which carry no values.

The local development API `127.0.0.1:8787` does not appear.

## Privacy and policy audit

| Item | Status | Evidence/action |
| --- | --- | --- |
| Manifest V3, no remote code | PASS | All extension JavaScript is in the ZIP, and the CSP allows scripts only from `'self'`. Packaged source has no `eval`, `new Function`, `executeScript`, or `innerHTML`. Network targets in packaged code are `api.github.com`, `github.com`, and the production API. Preview artifacts load in a cross-origin HTTPS iframe with no extension privileges. |
| Permissions minimal | PASS | Unchanged from v0.1.0 (see the comparison above). |
| Privacy disclosures | PASS (repository) | `PRIVACY.md`, effective October 7, 2026, was rewritten version-neutrally (it stays accurate for the published v0.1.0) and adds the five behaviors introduced since v0.1.0: branch discovery, Deployments/status evidence, bounded nested structure/candidate files, the per-tab theme snapshot in `browser.storage.session` (never sent to a server; verified in source), and the selected `sourceRoot` in preview requests. `docs/CHROME_WEB_STORE.md` justifications, disclosures, and data-flow table were updated to match. The privacy URL tracks `main`, so the revision goes live when this PR merges. |
| Connect GitHub / session flow vs `PRIVACY.md` | PASS (source) | Unchanged GitHub App OAuth with signed state and PKCE; a 30-minute session in `browser.storage.session`. |
| New Dashboard data category | MANUAL | Working conclusion: none required. This is not certification. |
| Dashboard privacy checkboxes, User activity, Location, remote-code declaration, category, certifications | MANUAL / PENDING | The owner must check the live Developer Dashboard immediately before submission. Stop if its wording conflicts with `docs/CHROME_WEB_STORE.md`. |
| CWS account 2FA, distribution settings | MANUAL / PENDING | Owner-only. |

## Unpacked extension verification

| Item | Status | Evidence/action |
| --- | --- | --- |
| Load v0.2.0 unpacked from `.output/peephole-0.2.0-unpacked/` (extracted from the audited ZIP) | PENDING (manual) | Not performed in this session; no browser-automation tool was available. |
| GitHub action mount; Side Panel opens; analysis loads; default branch; alternate branch; rapid branch switching shows no stale result; SPA navigation resets; structure section; target selection; deployment presentation; Light / Dark / Dark Dimmed; theme switch with the panel open; no console/runtime errors | PENDING (manual) | Owner checklist. An unpacked load gets a different extension ID. |
| Connect GitHub / authenticated preview from the v0.2.0 package | PENDING (post-publication) | The production OAuth allowlist must not be widened for a random unpacked ID. This can be tested only once v0.2.0 is published under `fieofkhijgngfoflgpkbghbkaidhdgel`. |
| Historical: Connect GitHub from the published v0.1.0 | PASS (v0.1.0 only) | On October 7, 2026, the published v0.1.0 installation completed Connect GitHub, and its sessions drove the authenticated M11-E4/E5/E6 production previews. This is not evidence for the v0.2.0 package. |

## Store assets and listing

| Item | Status | Evidence/action |
| --- | --- | --- |
| Icons (16/32/48/128) | PASS (reuse) | Unchanged and packaged. CWS guidance suggests 96×96 artwork with 16 px transparent padding; the full-bleed 128 icon was accepted for v0.1.0 (optional future nicety). |
| Small promo tile 440×280 | PASS (reuse) | Icon-only and unchanged. |
| Screenshot `peephole-screenshot-01-1280x800.png` | MUST REFRESH | Shows the v0.1.0 UI, from before theme sync, Branch Preview, target selection, and deployment evidence. |
| Fresh v0.2.0 screenshots (Light, Dark, Dark Dimmed, Branch Preview, analysis/structure) | PENDING | Must be real 1280×800 full-bleed captures of the v0.2.0 build, audited before use. None exist yet. |
| Listing copy | PENDING (proposal only) | Proposed v0.2.0 description is in `docs/CHROME_WEB_STORE.md`; it has not been submitted. The single purpose is unchanged. |

## Publication gates

| Item | Status |
| --- | --- |
| Release-candidate PR | Opened, not merged |
| Git tag `v0.2.0` | PENDING (not created) |
| GitHub Release with ZIP | PENDING (not created) |
| Chrome Web Store upload/submission | PENDING (not done) |
| Chrome Web Store review/publication | PENDING |
| Published-installation checks (version 0.2.0 shown, Connect GitHub, authenticated static preview, production API and host smoke) | PENDING until published |
| Post-release monitoring owner/window | MANUAL |

## Remaining controlled steps

1. Review and merge the release-candidate PR. Merging publishes the revised
   `PRIVACY.md`.
2. Run the manual unpacked-extension checklist above and capture fresh v0.2.0
   screenshots, then audit them.
3. Verify every Dashboard-only item in the live Developer Dashboard. Stop on
   any conflict.
4. Rebuild from the merged commit if it differs in packaged inputs; never
   reuse this hash for a changed package. Then tag `v0.2.0` and create the
   GitHub Release with the audited ZIP.
5. Upload and submit. After approval, verify the published v0.2.0 install,
   Connect GitHub, an authenticated preview, and production smoke.

Release state: **release candidate — not published.**
