# Codex Implementation Guide

This document is the primary implementation brief for Codex.

Read all Markdown documents in this repository before writing production code.

## Mission

Implement **Peephole v0.1**, a Chrome extension that augments GitHub repository pages with a fast repository preview analysis panel.

The product goal is:

> Help a developer understand and preview a GitHub repository before cloning it.

Do not expand the product beyond the v0.1 scope without a clear technical reason.

## Required Technology

Use:

- WXT
- React
- TypeScript
- Manifest V3
- GitHub REST API where needed

Prefer simple browser-native APIs over additional dependencies.

## Architecture Constraints

Keep these boundaries explicit:

```text
GitHub DOM integration
        |
        v
UI / presentation
        |
        v
Repository analysis core
        |
        v
GitHub data access
```

The repository analyzer must not depend on GitHub page DOM structure.

The GitHub content script should only:

- detect repository navigation,
- parse repository identity from the current URL,
- inject/remove Peephole UI,
- invoke application-level analysis.

## First Implementation Milestone

Do not begin with the full analyzer.

The first working milestone must be:

1. create a WXT + React + TypeScript extension,
2. run on `https://github.com/*/*`,
3. detect valid GitHub repository pages,
4. inject a visible `Peephole` button,
5. open a Peephole panel when clicked,
6. show owner/repository information,
7. provide `Open in StackBlitz`,
8. survive GitHub client-side navigation without duplicate UI.

Only after that works should repository analysis be added.

## Implementation Order

### Phase 1 — Extension shell

Implement:

- WXT configuration
- GitHub content script
- URL parser
- Peephole button
- Peephole panel
- GitHub SPA navigation handling
- StackBlitz URL generator

Acceptance criteria:

- visiting a repository displays exactly one Peephole button,
- navigating between repositories updates the panel correctly,
- navigating to non-repository GitHub pages removes/hides the UI,
- no full reload is required,
- button injection is idempotent.

### Phase 2 — Repository metadata

Implement GitHub data access for:

- repository metadata,
- default branch,
- repository homepage,
- `package.json`.

Render:

- repository name,
- detected language hints,
- scripts,
- likely framework.

### Phase 3 — Static analysis

Implement detectors for:

- React
- Vite
- Next.js
- Vue
- Svelte
- TypeScript
- package manager
- environment variable templates
- common deployment configuration

Use explicit evidence instead of guesses.

For example:

```text
vite dependency + react dependency
=> React + Vite
```

Do not infer "deployed on Vercel" merely because `vercel.json` exists.

Use wording such as:

```text
Vercel configuration detected
```

unless a real deployment URL is known.

### Phase 4 — Preview resolution

Resolution priority:

1. confirmed live URL,
2. GitHub Pages URL,
3. repository/homepage URL that appears to be an application deployment,
4. StackBlitz fallback,
5. unavailable/analysis-only.

Keep preview resolution separate from repository analysis.

## Suggested Project Structure

```text
peephole/
├─ entrypoints/
│  ├─ github.content/
│  │  ├─ index.tsx
│  │  ├─ PeepholeButton.tsx
│  │  └─ PeepholePanel.tsx
│  ├─ background.ts
│  └─ popup/
│     └─ index.tsx
├─ components/
│  ├─ RepoSummary.tsx
│  ├─ TechBadge.tsx
│  ├─ PreviewStatus.tsx
│  ├─ EnvStatus.tsx
│  └─ ActionButtons.tsx
├─ core/
│  ├─ github/
│  │  ├─ client.ts
│  │  ├─ repository.ts
│  │  ├─ contents.ts
│  │  └─ pages.ts
│  ├─ analyzer/
│  │  ├─ analyzeRepository.ts
│  │  ├─ frameworkDetector.ts
│  │  ├─ envDetector.ts
│  │  ├─ deploymentDetector.ts
│  │  └─ packageManagerDetector.ts
│  └─ preview/
│     ├─ strategy.ts
│     └─ stackblitz.ts
├─ types/
│  └─ repository.ts
└─ utils/
   ├─ githubUrl.ts
   └─ urls.ts
```

Adjust structure only if the final separation of concerns remains equally clear.

## Domain Model

Aim for a result similar to:

```ts
export interface RepositoryAnalysis {
  repository: {
    owner: string
    name: string
    defaultBranch: string
  }

  technologies: {
    framework:
      | "react"
      | "react-vite"
      | "next"
      | "vue"
      | "svelte"
      | "unknown"
    typescript: boolean
  }

  packageManager:
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | "unknown"

  runtime: {
    devCommand: string | null
    buildCommand: string | null
  }

  environment: {
    templateFound: boolean
    variables: string[]
  }

  deployment: {
    status: "confirmed" | "configured" | "unknown"
    provider:
      | "github-pages"
      | "vercel"
      | "netlify"
      | "homepage"
      | null
    url: string | null
  }
}
```

Types can evolve, but avoid weak `Record<string, any>` application state.

## GitHub Navigation

GitHub uses client-side navigation in many flows.

The extension must correctly handle:

```text
owner/repo-a
→ owner/repo-b
→ owner/repo-b/issues
→ another repository
```

Do not rely exclusively on the content script's initial execution.

Use a robust navigation observer/event strategy and ensure UI injection remains idempotent.

## Performance Requirements

Peephole should feel significantly lighter than cloning a repository.

Therefore:

- do not fetch the entire repository during initial analysis,
- request only the files required for analysis,
- avoid repeated GitHub requests for the same repository/ref,
- cache analysis results in memory at minimum,
- design cache keys using repository + ref/commit when possible,
- analyze lazily after the user opens Peephole unless a request is extremely cheap.

## Security Requirements

Never:

- evaluate repository source code inside privileged extension context,
- inject arbitrary remote scripts,
- execute repository JavaScript with `eval`,
- collect secret values,
- print GitHub tokens to logs,
- store environment variable values found in sensitive files.

Peephole v0.1 only analyzes public repository metadata and known text files.

## UX Requirements

The panel should clearly distinguish:

- confirmed facts,
- configuration evidence,
- warnings,
- unsupported states.

Good:

```text
✓ GitHub Pages deployment found
⚠ 2 environment variables declared
Vercel configuration detected
```

Bad:

```text
✓ Vercel deployed
```

when only `vercel.json` exists.

## Error Handling

Failures must degrade gracefully.

Examples:

- GitHub API rate limit
- missing `package.json`
- malformed JSON
- private repository
- monorepo
- missing default branch
- StackBlitz unsupported
- network failure

The panel should remain usable and explain what could not be determined.

## Testing

At minimum, add unit tests for pure analyzer functions:

- GitHub URL parsing
- framework detection
- package manager detection
- env parsing
- preview strategy resolution

Do not make unit tests depend on live GitHub APIs.

See `docs/TEST_PLAN.md`.

## Explicit Non-goals

Do not implement these in v0.1:

- WebContainer
- server-side build infrastructure
- Docker
- arbitrary repository execution
- AI-generated repository analysis
- authentication flows unless API rate limits make them necessary
- numerical previewability scoring
- iframe embedding for every deployment
- support for every monorepo layout

## Completion Definition

Peephole v0.1 is complete when a user can:

1. install the unpacked extension,
2. open a supported public GitHub repository,
3. click Peephole,
4. see useful repository/runtime/environment analysis,
5. open an existing preview when one is confirmed,
6. otherwise open the repository in StackBlitz,
7. navigate between repositories without extension state breaking.

Prefer a small, reliable v0.1 over a broad but fragile implementation.
