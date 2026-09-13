import type {
  BuildPlan,
  CreatePreviewJobRequest,
  PreviewRepositoryRef,
} from "../../types/preview"

/** First-party public fixture shared by the real golden paths and the
 * post-deployment smoke verifier. The immutable commit exists in GitHub
 * repository id 1354475085; never replace this with a branch name. */
export const PRODUCTION_SMOKE_REPOSITORY: PreviewRepositoryRef = {
  repositoryId: 1_354_475_085,
  owner: "ppsssj",
  name: "peephole-fixture-vite-react",
  commitSha: "d1ac2e71550484b5072de243b4dbf754367ed045",
}

export const PRODUCTION_SMOKE_REQUEST: CreatePreviewJobRequest = {
  repository: PRODUCTION_SMOKE_REPOSITORY,
  contractVersion: "static-v1",
}

export const PRODUCTION_SMOKE_BUILD_PLAN: BuildPlan = {
  contractVersion: "static-v1",
  repository: PRODUCTION_SMOKE_REPOSITORY,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

export const PRODUCTION_SMOKE_ARTIFACT_MARKER =
  "<title>Peephole Vite React Fixture</title>"
