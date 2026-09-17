import { describe, expect, it } from "vitest"

import { GitHubClient } from "../core/github/client"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { GitHubPreviewPlanResolver } from "../services/preview-api/githubPlanResolver"

const repository = {
  repositoryId: 1_371_618_449,
  owner: "The-peephole",
  name: "peephole-fixture-fullstack",
  commitSha: "eae411a288b212201933cebb206126dd5bb0d93e",
}

describe.skipIf(!process.env.PEEPHOLE_REAL_NETWORK_TESTS)(
  "real full-stack fixture Build Adapter boundary (network)",
  () => {
    it("reanalyzes the pinned commit without selecting a nested build target", async () => {
      const github = new GitHubClient()
      const resolver = new GitHubPreviewPlanResolver(
        github,
        new KnownRepositoryFilesLoader(github),
      )

      await expect(
        resolver.resolve(repository, "static-v1"),
      ).resolves.toBeNull()
    }, 30_000)
  },
)
