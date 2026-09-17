import { describe, expect, it } from "vitest"

import { BackendCandidateLoader } from "../core/github/backendCandidateLoader"
import { GitHubClient } from "../core/github/client"

const repository = {
  repositoryId: 1_371_618_449,
  owner: "The-peephole",
  repo: "peephole-fixture-fullstack",
  defaultBranch: "main",
  commitSha: "eae411a288b212201933cebb206126dd5bb0d93e",
  homepage: null,
}

describe.skipIf(!process.env.PEEPHOLE_REAL_NETWORK_TESTS)(
  "real full-stack fixture backend detection (network, detection-only)",
  () => {
    it("detects the fixture's Express backend without executing anything", async () => {
      const github = new GitHubClient()
      const loader = new BackendCandidateLoader(github)

      const result = await loader.load(repository, ["backend", "frontend"])

      expect(result.status).toBe("detected")
      const backend = result.candidates.find(
        (candidate) => candidate.sourceRoot === "backend",
      )
      expect(backend).toMatchObject({
        sourceRoot: "backend",
        framework: "express",
        runtime: "node",
      })
      // The fixture's "frontend" directory has no backend framework or
      // database dependency, so it must not appear as a backend candidate.
      expect(
        result.candidates.some(
          (candidate) => candidate.sourceRoot === "frontend",
        ),
      ).toBe(false)
    }, 30_000)
  },
)
