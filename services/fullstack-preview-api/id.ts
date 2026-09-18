/**
 * `fullstack-<uuid>` -- a distinct syntactic namespace from
 * `artifact-<uuid>` (services/artifactServing/staticFile.ts's
 * `ARTIFACT_ID_SOURCE`), deliberately never altered by this module. A
 * `FullStackPreview` id doubles as the future full-stack hostname identity
 * (M9 D-031); it must never be able to collide with, or be mistaken for, a
 * shared static artifact id. Same 8-then-27 hex/dash split as
 * `ARTIFACT_ID_SOURCE` -- it matches a canonical `crypto.randomUUID()`
 * output's exact 8-4-4-4-12 hexadecimal group layout.
 */
export const FULLSTACK_PREVIEW_ID_SOURCE =
  "fullstack-[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}"
export const FULLSTACK_PREVIEW_ID_PATTERN = new RegExp(
  `^${FULLSTACK_PREVIEW_ID_SOURCE}$`,
  "i",
)

export function createFullStackPreviewId(): string {
  return `fullstack-${crypto.randomUUID()}`
}
