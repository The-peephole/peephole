# MVP Roadmap

## Release Target

Peephole v0.1 should be a usable unpacked Chrome extension before advanced preview infrastructure is considered.

## Milestone 0 — Repository Setup

Deliverables:

- WXT + React + TypeScript setup
- linting
- formatting
- unit test runner
- basic README
- extension can build successfully

Exit criteria:

```text
npm install
npm run dev
npm run build
```

work from a fresh clone.

## Milestone 1 — GitHub Injection

Goal:

> Make Peephole visibly exist on GitHub.

Tasks:

- parse GitHub repository URL,
- detect valid repository context,
- inject Peephole button,
- open/close panel,
- support client-side GitHub navigation,
- prevent duplicate mounts.

Exit criteria:

- repository A shows Peephole,
- repository A → repository B updates correctly,
- Issues/PR navigation does not duplicate UI,
- non-repository pages do not show invalid repository state.

Suggested commit:

```text
feat: inject Peephole preview button into GitHub repository pages
```

## Milestone 2 — StackBlitz Fast Path

Tasks:

- generate `https://stackblitz.com/github/{owner}/{repo}`,
- add `Open in StackBlitz`,
- open safely in new tab.

Exit criteria:

- action works for arbitrary public owner/repo identity,
- URL encoding is correct.

## Milestone 3 — Repository Metadata

Tasks:

- GitHub REST client,
- repository metadata,
- default branch,
- homepage,
- `package.json`,
- normalized errors.

Exit criteria:

- panel can display repository identity and package scripts,
- missing package.json does not crash the extension.

## Milestone 4 — Analyzer

Tasks:

- framework detector,
- TypeScript detector,
- package manager detector,
- runtime command detector,
- env template parser,
- evidence model.

Exit criteria:

- detectors are independently unit-tested,
- analyzer is not coupled to React/DOM.

## Milestone 5 — Deployment Resolver

Tasks:

- GitHub Pages detection,
- homepage candidate,
- Vercel config detection,
- Netlify config detection,
- confirmed/configured/unknown states,
- preview strategy resolution.

Exit criteria:

- confirmed deployment is preferred,
- configuration-only evidence is not represented as confirmed deployment,
- StackBlitz remains fallback.

## Milestone 6 — UX Hardening

Tasks:

- loading state,
- API limit state,
- unsupported state,
- missing package file state,
- monorepo warning,
- stale request protection,
- lightweight caching.

Exit criteria:

- UI stays functional during failures,
- no stale analysis appears after navigating to another repo.

## v0.1 Definition of Done

A user can:

```text
install extension
→ open GitHub repo
→ click Peephole
→ see framework/runtime/env analysis
→ open confirmed preview OR StackBlitz
```

without cloning the repository.

## v0.2 Candidates

Only evaluate after v0.1 usage.

Candidates:

- embedded preview where CSP allows,
- private repository support,
- richer README demo-link extraction,
- monorepo package selection,
- persistent cache,
- custom preview service.

## v0.3+ Candidate

Possible isolated runtime:

```text
repository archive
→ isolated preview web app
→ WebContainer
→ install
→ run
→ cache
```

This is intentionally not part of v0.1.
