# Peephole

> Preview a GitHub repository before you clone it.

Peephole is a browser extension that helps developers quickly understand whether a GitHub repository can be previewed, how it is likely to run, and what configuration it needs — before cloning it locally.

The first version does **not** try to become another StackBlitz. Instead, Peephole analyzes the repository, finds the fastest available preview path, and falls back to StackBlitz only when needed.

## Problem

When browsing GitHub, developers often want to answer a simple question:

> "What does this project actually look like?"

Today, that frequently requires:

1. cloning the repository,
2. installing dependencies,
3. checking environment variables,
4. finding the correct run command,
5. discovering that a backend or API key is required,
6. or waiting for an online IDE to import the entire repository.

That is excessive when the real intent is only to inspect the project quickly.

## Product Goal

Peephole should answer, as quickly as possible:

- What framework is this repository using?
- Is there already a live deployment?
- Does it require environment variables?
- Does it depend on an external backend/API?
- Which package manager does it use?
- What command is likely to start it?
- Can it be opened in StackBlitz?
- What is the fastest preview route?

## MVP

Peephole v0.1 targets public GitHub repositories and focuses on frontend-oriented JavaScript/TypeScript projects.

Initial framework targets:

- React
- Vite
- Next.js
- Vue
- Svelte
- generic `package.json` projects

Initial analysis targets:

- `package.json`
- lock files
- `.env.example`
- `.env.sample`
- `.env.template`
- `README.md`
- `vite.config.*`
- `next.config.*`
- `vercel.json`
- `netlify.toml`
- GitHub Pages
- repository homepage metadata

## Preview Strategy

Peephole does not immediately create an execution environment.

```text
GitHub Repository
        |
        v
Peephole Analyzer
        |
        +-- Existing live preview found --> Open Preview
        |
        +-- No live preview
                |
                +-- StackBlitz-compatible --> Open in StackBlitz
                |
                +-- Unsupported/uncertain --> Show analysis only
```

## Non-goals for v0.1

The first release will **not**:

- run arbitrary remote source code inside the extension,
- support every programming language,
- support every monorepo structure,
- automatically provision backend infrastructure,
- inject secret environment values,
- guarantee that every repository is runnable,
- implement a custom WebContainer runtime,
- calculate a misleading numeric "previewability score".

## Proposed Stack

- WXT
- React
- TypeScript
- Chrome Manifest V3
- GitHub REST API

## Planned UX

A GitHub repository page receives a Peephole action.

```text
┌──────────────────────────────────┐
│  ◉ Peephole                      │
│                                  │
│  React + Vite                    │
│  TypeScript                      │
│                                  │
│  PREVIEW                         │
│  ✓ Live deployment found        │
│                                  │
│  ENVIRONMENT                     │
│  ⚠ VITE_API_URL                 │
│                                  │
│  RUNTIME                         │
│  npm · npm run dev              │
│                                  │
│  [ Open Preview ]                │
│  [ Open in StackBlitz ]          │
└──────────────────────────────────┘
```

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Repository analysis specification](docs/REPOSITORY_ANALYSIS.md)
- [MVP roadmap](docs/MVP_ROADMAP.md)
- [Test plan](docs/TEST_PLAN.md)
- [Technical decisions](docs/DECISIONS.md)
- [Codex implementation guide](CODEX.md)

## Working Principle

Peephole should prefer **inspection before execution**.

A repository should only be executed when analysis cannot provide a faster route to a useful preview.
