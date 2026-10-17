# Sidepanel navigation lifecycle (R3)

## Policy and Chrome constraints

- Disable Peephole's global default. Repository content scripts configure a tab-specific path containing its repository and source tab ID. Passive discovery never calls `open()` and never changes an existing bound path. Clicking Peephole explicitly chooses a repository; job controls always name their owning repository/commit.
- `tabs.onUpdated` with `status: loading` observes full navigation without reading `Tab.url`, `pendingUrl`, title or page content. No `tabs`, `webNavigation`, `activeTab`, GitHub host or `<all_urls>` permission is added. Disable only Peephole in that tab; omit `path` to preserve its repository. This also hides briefly during a full GitHub reload until the new document reports context.
- Same-repository SPA discovery leaves the path unchanged. A BFCache `pageshow.persisted` republishes context because content-script initialization does not rerun. Tab switching is left to Chrome's tab-specific visibility handling; there is no window/global open or close call.
- [Chrome's Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) requires a user action for `open()` (116+). The warm, already-bound click path invokes it synchronously with no preceding await. Cold worker state or a repository change first prepares the path safely and asks for a second click; **it never calls `open()` after asynchronous preparation**. Returning to GitHub or closing a panel does not create auto-open intent. Chrome may restore its own tab-specific visibility, but Peephole never requests an automatic reopening.
- `close()` is 141+; before Chrome 145, `close({tabId})` could fall back to the global panel. `onClosed` is 142+ and reports a path/tab/window, not a manual-versus-programmatic reason. Neither API is used. The existing minimum Chrome version remains 116.
- [Tabs API permission model](https://developer.chrome.com/docs/extensions/reference/api/tabs): the namespace and ordinary events are available without the broad `tabs` permission. Sensitive URL/title fields require `tabs` or matching host access; this implementation does not read them.

## Job ownership and safe hiding

The open panel handles a tab-addressed navigation preparation message. It defers its acknowledgement while Create is pending or a control snapshot is being saved. Only after the received job ID and metadata are acknowledged by session storage may navigation hide/rebind the panel. Returning context or an explicit newer click cancels an older delayed hide. Cached/prerendered and embedded document messages are ignored.

All per-tab option reads and writes share a queue, with intent versions checked before configuration and after it completes. Chrome documents that `setOptions()` resolves after options are set; it does not document ordering between overlapping calls. Serialization prevents an old enable/rebind from applying after a newer hide/context, and invalidated requests do not report success. Other tabs have independent queues. Passive discovery still retains the bound job UI; only explicit Open may change its repository. A click during an outstanding option operation takes the preparation/second-click path because the previously cached repository may no longer match the path being applied. An idle warm click still invokes `open()` synchronously. Neither a failed API call nor a stale callback triggers an automatic open or retry.

An ambiguous/lost Create response keeps the existing idempotent retry controls visible. A storage error keeps Stop accessible and refuses programmatic hiding/rebinding. There is no automatic Create retry, Stop, deletion or forced cleanup. Explicit Chrome close, tab destruction, extension reload or browser shutdown cannot be delayed by this protocol; it does not claim recovery of a Create response whose job ID was never received/saved.

Admitted Fullstack controls are stored under one key per source tab in `storage.session`, with versioned, explicitly selected analysis/preview fields. Create requests, authentication sessions and M12 input values are not included. Writes are ordered; hydration checks preview shape and repository/commit/frontend identity. Failure to load controls disables new Fullstack admission instead of silently overwriting the snapshot. A saved Ready iframe stays unmounted until a fresh Get status succeeds; Stop remains available while checking or after polling failure.

[Session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session) survives service-worker suspension/restart and page/panel reload. It clears on extension reload/disable/update and browser restart. React branch/target selections, static preview UI state and iframe document state are not persisted. No cross-restart durability beyond this Chrome contract is claimed.

## Verification boundary

| Scenario | Automated coverage | Native Chrome extension UI |
|---|---|---|
| Repository button open, synchronous gesture path | Unit/mock API | Manual QA required |
| External navigation, return and no auto-open | Unit/mock API | Manual QA required |
| Same-repository SPA, BFCache restore | Controller/DOM tests | Manual QA required |
| Tab A/B isolation and explicit manual close | No auto-open calls; separate keys/options | Chrome visibility/close needs manual QA |
| Worker restart and cold second-click recovery | Recreated controller over retained options | Manual QA required |
| Panel/page reload with admitted Fullstack job | React unmount/hydrate, fresh status, original-ID Stop | Manual QA required |
| Navigation during Create / unacknowledged save | Deferred hide and fail-closed tests | Manual QA required |
| No unnecessary Create | API spies during all navigation/recovery tests | Production Create is prohibited |

Browser automation in this environment blocks extension-internal URLs. A normal Chrome page with local injected API/storage fixtures can verify React/policy behavior; it cannot certify native Side Panel chrome, native close gestures, service-worker suspension, or actual `open()` gesture acceptance. Those scenarios must not be labelled native PASS.
