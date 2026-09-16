# Peephole v0.1.0 release record and remaining checks

Peephole v0.1.0 is published on GitHub and the Chrome Web Store. This document
preserves the release-preparation evidence while tracking verification that is
still outstanding. **PASS** means the specifically named fact was directly
verified; **SNAPSHOT** is dated historical evidence that is not automatically
valid for the current revision; **MANUAL** requires an operator or Developer
Dashboard check; **PENDING** has no retained completion evidence.

## Build record

The following package evidence is the September 13, 2026 release-preparation
snapshot unless a later recheck is stated explicitly.

| Item | Status | Evidence |
| --- | --- | --- |
| Packaged extension source | SNAPSHOT | The release ZIP was recorded from `8f1fb5742291805c947d0427fd64921bf5e419e9`. The `v0.1.0` tag points to `f146cb772db2a5168608bdba7463198ea7e8a6a0`; the intervening tracked changes did not change packaged extension runtime source. |
| Package version | PASS | `package.json` is `0.1.0`. |
| Manifest version | PASS | `wxt.config.ts` is `0.1.0`; the generated release manifest uses Manifest V3. |
| Public build configuration | PASS | `WXT_PREVIEW_API_BASE_URL` and `WXT_PREVIEW_ARTIFACT_BASE_DOMAIN` only; no server secret is a `WXT_` value. |
| Production API | PASS | `https://api.3.34.33.24.sslip.io/`; public health and readiness returned success on September 16, 2026. This is endpoint availability, not a production preview smoke. |
| Production artifact domain | SNAPSHOT | `3.34.33.24.nip.io`; tracked configuration, DNS, and an earlier production artifact smoke were recorded during release preparation. They were not rerun by the documentation audit. |
| Node/npm | SNAPSHOT | Node `v24.12.0`; npm `11.6.2`. |
| Dependency install | SNAPSHOT | `npm ci`; 307 packages and 0 reported vulnerabilities at release preparation. This result was not reused as a current dependency audit. |
| Release ZIP | PASS | `.output/peephole-0.1.0-chrome.zip`; 196,720 bytes; SHA-256 `56979f685a97508605533285467b07439cd23b8a73bbea279508ffd6bbf42d7a`. Size and digest were rechecked locally and against the GitHub Release asset on September 16, 2026. |
| Generated manifest audit | PASS | Rechecked from the ZIP: MV3, version 0.1.0, minimum Chrome 116, expected permissions/hosts/content-script scope/CSP; no `<all_urls>` or unexpected permission. |
| Package secret scan | SNAPSHOT | The release-preparation scan found no credential, private key, database URL, server secret, `.env` file, `ghp_`, or `replace-me` value. See the preserved scan notes below. |

Generated output and ZIP are ignored by Git and must not be committed.

### Package scan notes

The complete extracted ZIP was scanned as binary-safe text during release
preparation. Expected harmless matches were:

- `127.0.0.1` in `manifest.json` as the local-development artifact-only
  `frame-src`, not a host permission or production API endpoint;
- `localhost` and `127.0.0.1` literals in bundled validation code that accepts
  local development URLs and rejects invalid production configuration; and
- `.env.example` and secret-like variable-name patterns in the repository
  analyzer, which inspects public example templates for declared requirements
  but contains no values from this repository's `.env.example`.

The release manifest's API host permission is production HTTPS only. The ZIP
contains no `.env` file. The loopback artifact CSP compatibility should be
explained to reviewers if flagged; it cannot authorize an API request and does
not expose extension privileges to a local page.

## Quality evidence

| Item | Status | Evidence/action |
| --- | --- | --- |
| Current `main` portable CI | PASS | CI succeeded at `dba47191bdd3600b3f451945653efab2363028c2`. |
| Current first-party golden path | PASS | The manually dispatched `Real golden-path build tests` workflow succeeded at the same revision using `The-peephole/peephole-fixture-vite-react@4a2c3b78e15d90865ed565c3d38c4045b5a5235f`. This is live-network CI, not production smoke or production-host gVisor verification. |
| Portable test totals | SNAPSHOT | Release preparation recorded 54 files passed / 6 skipped and 615 tests passed / 31 skipped. Exact counts are historical evidence, not a current acceptance requirement; use the current CI result for the revision under review. |
| Real gVisor/security suites | SNAPSHOT | Prior environment-specific results are retained in the runtime/security documents. Portable CI and the live-network golden workflow do not re-establish them. |
| Permission and privacy audit | PASS | Current source rationale is documented in `docs/CHROME_WEB_STORE.md` and `PRIVACY.md`. |

## Store and release gates

| Item | Status | Evidence/action |
| --- | --- | --- |
| Privacy policy content and public URL | PASS | Root `PRIVACY.md` is public at `https://github.com/The-peephole/peephole/blob/main/PRIVACY.md`. |
| Listing copy and repository assets | PASS | Current copy and rechecked asset dimensions/hashes are in `docs/CHROME_WEB_STORE.md`. |
| Dashboard privacy and remote-code answers | MANUAL | The public listing exposes the disclosure categories, but current checkbox labels, certifications, distribution settings, and policy prompts require owner Dashboard access. |
| CWS developer account and 2FA | MANUAL | Verify in the owner account; this audit did not access the Developer Dashboard. |
| Stable Web Store extension ID | PASS | Public listing ID: `fieofkhijgngfoflgpkbghbkaidhdgel`. |
| Public Chrome Web Store listing | PASS | Version 0.1.0 is publicly installable and reports an update date of September 14, 2026. |
| Production OAuth start allowlist | PASS | On September 16, 2026, the public OAuth start endpoint accepted the exact published-ID callback and returned a GitHub redirect with signed state and S256 PKCE. This status is limited to the start endpoint. |
| Web Store installation OAuth/session test | PENDING | No retained evidence shows a user completed **Connect GitHub**, session issuance, and an authenticated preview from the published installation. |
| Production smoke for this release | PENDING | No retained audit evidence shows both documented API and production-host smoke modes were run for the published Web Store build. CI and golden-path workflow success do not satisfy this gate. |
| GitHub tag `v0.1.0` | PASS | Tag resolves to `f146cb772db2a5168608bdba7463198ea7e8a6a0`. |
| GitHub Release | PASS | The public `v0.1.0` release contains `peephole-0.1.0-chrome.zip` with the verified size and digest above. |
| Post-release monitoring record | MANUAL | No retained owner/window record was found; monitor health, readiness, errors, jobs, artifacts, and user reports. |

## Remaining controlled checks

1. Verify the current Developer Dashboard settings in the owner account.
2. Install the public Web Store build and complete GitHub OAuth, Peephole
   session issuance, and an authenticated preview.
3. Run and retain the separately documented API and production-host smoke
   results. Do not substitute portable CI or the golden-path workflow.
4. Record the post-release monitoring owner and window.
5. If extension source or a packaged asset changes, rebuild and re-audit the
   ZIP; never reuse the recorded hash for a changed package.

Release state: **published**, with Web Store end-to-end OAuth, release-specific
production smoke, Dashboard-only settings, and monitoring evidence still
requiring operator verification.
