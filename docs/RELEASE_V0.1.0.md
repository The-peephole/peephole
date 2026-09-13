# Peephole v0.1.0 release checklist

Status values: **PASS** is directly verified; **BLOCKED** prevents submission;
**MANUAL** requires a human/Dashboard action; **PENDING** has not yet run.

## Build record

| Item | Status | Evidence |
| --- | --- | --- |
| Extension source | PASS | `8f1fb5742291805c947d0427fd64921bf5e419e9` (release-preparation changes are documentation only) |
| Package version | PASS | `package.json` is `0.1.0` |
| Manifest version | PASS | `wxt.config.ts` is `0.1.0`; generated manifest uses Manifest V3 |
| Public build configuration | PASS | `WXT_PREVIEW_API_BASE_URL` and `WXT_PREVIEW_ARTIFACT_BASE_DOMAIN` only; no server secret is a `WXT_` value |
| Production API | PASS | `https://api.3.34.33.24.sslip.io/`; public health/readiness and tracked production configuration verified |
| Production artifact domain | PASS | `3.34.33.24.nip.io`; tracked production configuration, production tests, DNS, and prior production artifact smoke verified |
| Node/npm | PASS | Node `v24.12.0`; npm `11.6.2` |
| Dependency install | PASS | `npm ci`; 307 packages, 0 reported vulnerabilities |
| Release ZIP | PASS | `.output/peephole-0.1.0-chrome.zip`; 196,720 bytes; SHA-256 `56979f685a97508605533285467b07439cd23b8a73bbea279508ffd6bbf42d7a` |
| Generated manifest audit | PASS | MV3, name/version/icons/Chrome 116, expected permissions/hosts/content scope/CSP; no `<all_urls>` or unexpected permission |
| Package secret scan | PASS | No credential, private key, database URL, server secret, `.env` file, `ghp_`, or `replace-me` value found. See scan notes below. |

Generated output and ZIP are ignored by Git and must not be committed.

### Package scan notes

The complete extracted ZIP was scanned as binary-safe text. Expected harmless
matches are:

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

## Quality gates

| Item | Status | Evidence/action |
| --- | --- | --- |
| Main CI | PASS | Main `8f1fb5742291805c947d0427fd64921bf5e419e9`: CI and scheduled real golden-path workflow succeeded |
| `npm run format:check` | PASS | Prettier reports all matched files use the project code style |
| `npm run lint` | PASS | `eslint .` reports no errors or warnings |
| `npm run typecheck` | PASS | `wxt prepare && tsc --noEmit` succeeded |
| `npm test` | PASS | Vitest: 54 files passed / 6 skipped; 615 tests passed / 31 skipped; 0 failed. Real gVisor/SIGKILL tests remain out of scope for this portable suite |
| `npm run build` | PASS | Production-configured Chrome MV3 build succeeded |
| `git diff --check` | PASS | No whitespace errors in tracked or staged diff |
| Permission audit | PASS | Every generated permission and host scope maps to current source usage; see `docs/CHROME_WEB_STORE.md` |
| Privacy/data audit | PASS | `PRIVACY.md` and the source-rationale table in `docs/CHROME_WEB_STORE.md` |

## Store and release gates

| Item | Status | Evidence/action |
| --- | --- | --- |
| Privacy policy content | PASS | User-facing policy exists at root `PRIVACY.md` |
| Public privacy-policy URL | BLOCKED | Publish the policy at a stable public HTTPS URL and enter it in the Dashboard |
| English listing copy | PASS | Copy-ready canonical text in `docs/CHROME_WEB_STORE.md` |
| Privacy-tab disclosure | MANUAL | Apply the documented answers and verify current Dashboard checkbox names |
| Remote-code answer | MANUAL | Recommended **No**; disclose isolated cross-origin preview iframe architecture and verify against the live Dashboard |
| 128×128 store icon | PASS | Valid RGBA PNG is packaged; manually verify visual padding/readability |
| Required screenshot | BLOCKED | Existing 1905×911 PNG is not 1280×800 or 640×400 |
| Required 440×280 promo tile | BLOCKED | Not present |
| CWS developer account and 2FA | MANUAL | Verify in the owner account; not inspected by this task |
| Draft upload | PENDING | Upload ZIP only after reviewing this PR; do not submit for review yet |
| Stable Web Store extension ID | BLOCKED | Unknown until draft item/upload exists |
| Production OAuth allowlist | BLOCKED | Add the exact draft ID to server-side `PEEPHOLE_ALLOWED_EXTENSION_IDS` through a separate controlled production change |
| Trusted-tester Web Store build OAuth test | PENDING | Install the draft build and test **Connect GitHub** after allowlisting |
| Production smoke | PENDING | Run API and host modes after the store-build OAuth test |
| GitHub tag `v0.1.0` | PENDING | Do not create in this preparation task |
| GitHub Release | PENDING | Do not create in this preparation task |
| Chrome review submission | BLOCKED | Requires privacy URL, compliant assets, stable ID, OAuth verification, and smoke success |
| Post-release monitoring | MANUAL | Define owner/window and monitor health, readiness, errors, jobs, artifacts, and user reports |

## Final controlled sequence

1. Merge the reviewed release-preparation PR through repository rules.
2. Supply the compliant screenshot, small promo tile, and public privacy URL.
3. Rebuild and re-check the ZIP if any extension source or packaged asset
   changes; never reuse a hash after such a change.
4. Verify the Developer Dashboard account, 2FA, listing, permissions, privacy
   answers, distribution, and current policy prompts.
5. Upload as a draft and record the stable extension ID.
6. Follow the production OAuth allowlist sequence in
   `docs/CHROME_WEB_STORE.md`.
7. Pass trusted-tester GitHub OAuth and production smoke.
8. Create the approved tag/Release, then submit for review.

Release readiness: **BLOCKED** until the privacy URL, compliant store assets,
stable Web Store ID, production OAuth allowlist, store-build OAuth test, and
production smoke gates are complete.
