import type {
  BuildPlan,
  CreatePreviewJobRequest,
  PreviewRepositoryRef,
} from "../../types/preview"

/** First-party public fixture shared by the real golden paths and the
 * post-deployment smoke verifier. The immutable commit exists in GitHub
 * repository id 1371620276; never replace this with a branch name. */
export const PRODUCTION_SMOKE_REPOSITORY: PreviewRepositoryRef = {
  repositoryId: 1_371_620_276,
  owner: "The-peephole",
  name: "peephole-fixture-vite-react",
  commitSha: "4a2c3b78e15d90865ed565c3d38c4045b5a5235f",
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
