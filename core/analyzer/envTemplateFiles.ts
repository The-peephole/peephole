/**
 * Known environment-template file names, in priority order. Shared by
 * `environmentDetector.ts` (legacy aggregate detection) and
 * `environmentRequirements.ts` (per-variable requirement classification) so
 * the two never drift on what counts as a template. Real `.env`/`.env.local`
 * files are never read.
 */
export const ENV_TEMPLATE_FILENAMES: readonly string[] = [
  ".env.example",
  ".env.local.example",
  ".env.sample",
  ".env.template",
]

export const ENV_TEMPLATE_PATHS: ReadonlySet<string> = new Set(
  ENV_TEMPLATE_FILENAMES,
)
