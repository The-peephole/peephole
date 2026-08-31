# Architecture

## 1. Overview

Peephole v0.1 is a browser extension with four primary layers:

```text
┌──────────────────────────────────────┐
│ GitHub Integration                   │
│ URL detection / DOM injection / SPA  │
└──────────────────┬───────────────────┘
                   │
                   v
┌──────────────────────────────────────┐
│ Application UI                       │
│ Button / panel / status / actions    │
└──────────────────┬───────────────────┘
                   │
                   v
┌──────────────────────────────────────┐
│ Repository Analysis Core             │
│ framework / env / runtime / deploy   │
└──────────────────┬───────────────────┘
                   │
                   v
┌──────────────────────────────────────┐
│ Repository Data Sources              │
│ GitHub REST / known text files       │
└──────────────────────────────────────┘
```

## 2. Primary Design Rule

The analyzer must be independent from GitHub DOM structure.

This is important because:

- GitHub DOM changes,
- GitHub navigation is client-side,
- future GitLab/Gitea support may be possible,
- analyzers should be unit-testable without a browser.

## 3. GitHub Integration

Responsibilities:

- determine whether the current URL represents a repository,
- extract owner/repository,
- observe navigation,
- mount Peephole UI,
- unmount stale UI,
- prevent duplicate mounts.

It must not contain framework detection logic.

## 4. UI Layer

Responsibilities:

- display loading/error/result states,
- render analysis evidence,
- expose preview actions,
- clearly differentiate confirmed vs inferred information.

Suggested states:

```ts
type PeepholeViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; analysis: RepositoryAnalysis }
  | { status: "error"; error: PeepholeError }
```

## 5. GitHub Client

The GitHub client should expose task-oriented functions instead of leaking raw API calls everywhere.

Example:

```ts
getRepository(owner, repo)
getTextFile(owner, repo, path, ref?)
getGitHubPages(owner, repo)
fileExists(owner, repo, path, ref?)
```

All API errors should be normalized.

## 6. Analyzer Pipeline

Recommended pipeline:

```text
Repository identity
        |
        v
Repository metadata
        |
        v
Target file discovery
        |
        +-- package.json
        +-- lock files
        +-- env templates
        +-- deployment config
        |
        v
Pure detectors
        |
        +-- frameworkDetector
        +-- packageManagerDetector
        +-- envDetector
        +-- runtimeDetector
        +-- deploymentDetector
        |
        v
RepositoryAnalysis
```

Prefer pure functions for detectors.

## 7. Preview Strategy

Preview resolution must be separate from detection.

Example:

```ts
type PreviewStrategy =
  | {
      type: "deployment"
      url: string
      label: "Open Preview"
    }
  | {
      type: "stackblitz"
      url: string
      label: "Open in StackBlitz"
    }
  | {
      type: "unavailable"
      reason: string
    }
```

Resolution logic should consume `RepositoryAnalysis`, not make arbitrary network requests itself.

## 8. Caching

v0.1 should implement at least in-memory caching.

Suggested key:

```text
owner/repo@ref
```

If a commit SHA is available:

```text
owner/repo@commitSHA
```

Cache:

- repository metadata,
- requested text files,
- completed analysis.

Avoid premature persistent caching.

## 9. GitHub SPA Navigation

Navigation handling is a first-class architectural concern.

Requirements:

- detect URL changes,
- distinguish repository root vs nested repository pages,
- update repository identity,
- clean up stale UI,
- avoid duplicate buttons,
- cancel or ignore stale analysis requests.

Possible technique:

- GitHub navigation event when available,
- URL comparison,
- `MutationObserver` as a defensive mechanism,
- request identity/token to prevent race conditions.

Do not rely solely on page load.

## 10. Security Boundary

The extension is a repository inspector, not a remote code executor.

Never execute repository source in:

- background service worker,
- content script,
- extension page,
- privileged extension context.

Do not use:

```ts
eval(...)
new Function(...)
```

for repository source.

Any future custom execution runtime must be isolated outside the privileged extension layer.

## 11. Future Runtime Boundary

A possible future architecture:

```text
Chrome Extension
      |
      v
Peephole Preview Web App
      |
      v
Isolated WebContainer / sandbox
```

The extension remains a controller.

The runtime remains a separate execution environment.

This is explicitly deferred from v0.1.

## 12. Suggested Directory Layout

```text
entrypoints/
components/
core/
  github/
  analyzer/
  preview/
types/
utils/
```

Keep domain logic in `core/`.

Avoid placing all logic inside React components.
