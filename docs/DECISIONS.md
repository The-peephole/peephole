# Technical Decisions

This document records decisions that constrain implementation. Superseded entries remain for context.

## D-001 - Extension framework: WXT

**Status:** Accepted

Use WXT with React, TypeScript, and Manifest V3 for extension entrypoints and builds.

## D-002 - v0.1 is an analyzer/router, not a runtime

**Status:** Superseded by D-011

The original plan routed unsupported repositories to StackBlitz. The product direction now requires a Peephole-owned preview for a limited compatibility set.

## D-003 - No repository execution in extension context

**Status:** Accepted

Repository source and dependency scripts must never execute in content scripts, extension pages, background workers, or the preview control API process.

## D-004 - Minimal repository fetch for analysis

**Status:** Accepted

Initial analysis fetches only known metadata and small text files. A full commit archive is downloaded only by an isolated runner after explicit user action.

## D-005 - Evidence-based status

**Status:** Accepted

Distinguish confirmed deployments, configuration evidence, inferred compatibility, and unknown states. Every eligibility result includes evidence and blockers.

## D-006 - No numeric previewability score in v0.1

**Status:** Accepted

Use concrete facts and blockers rather than an unexplained number.

## D-007 - Existing deployments may open in a new tab

**Status:** Accepted

Many deployments prohibit framing. Peephole may show a confirmed deployment in-panel only when policy allows; otherwise it opens in a new tab.

## D-008 - StackBlitz as fallback

**Status:** Superseded by D-012

The first extension shell used StackBlitz as a temporary demonstrator. It is not part of the target architecture or v0.1 definition of done.

## D-009 - GitHub SPA navigation is P0

**Status:** Accepted

Repository identity, action insertion, panel state, and preview-job attachment must remain correct across client-side navigation.

## D-010 - Detector functions are pure where possible

**Status:** Accepted

Data fetching, parsing, evidence detection, and eligibility resolution remain separate and independently testable.

## D-011 - Peephole owns the supported preview experience

**Status:** Accepted

v0.1 builds and serves supported static frontend repositories through Peephole-controlled infrastructure. This is a compatibility contract, not a promise to run arbitrary repositories.

## D-012 - No StackBlitz dependency in the target flow

**Status:** Accepted

Unsupported repositories show evidence and blockers. They are not silently handed to StackBlitz or another online IDE.

## D-013 - Execution plane is isolated from extension and control plane

**Status:** Accepted

Untrusted builds run asynchronously in disposable, restricted workers. The API only validates, schedules, and reports jobs.

## D-014 - Static-build-first v0.1 contract

**Status:** Accepted

v0.1 supports static repositories and root-level Vite React/Vue/Svelte applications that build without secrets. Persistent SSR, backends, Docker, and ambiguous monorepos are deferred.

## D-015 - Every preview is pinned to a commit SHA

**Status:** Accepted

Analysis, jobs, cache entries, displayed identity, and artifacts reference an immutable commit SHA. A moving branch is resolved before work starts.

## D-016 - Untrusted previews use a separate registrable domain

**Status:** Accepted

Preview artifacts must not share a cookie or origin boundary with the control UI. Prefer per-job origins under a domain such as `peephole.run`.

## D-017 - Chrome Side Panel is the primary full-preview surface

**Status:** Accepted

GitHub DOM receives only a compact action. Analysis, progress, and previews live in a stable side panel, avoiding fragile large DOM injection and GitHub page CSP constraints.
