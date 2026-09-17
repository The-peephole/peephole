import type { RepositoryMetadata } from "../../types/repository"

/**
 * Local, per-commit deployment *evidence* only. "declared" means the
 * repository declares a homepage URL in its GitHub metadata -- it does not
 * mean that URL is an actual deployed application (it could equally be a
 * marketing site, documentation, or -- as with this very repository -- a
 * Chrome Web Store listing). "configured" means a provider config file was
 * found with no known URL. Neither value is proof of a live deployment;
 * that determination is made separately by the bounded GitHub Deployments
 * API lookup in `core/github/repositoryDeploymentsLoader.ts`, whose result
 * is mutable state kept out of this immutable, SHA-keyed analysis.
 */
export interface DeploymentDetection {
  status: "declared" | "configured" | "unknown"
  provider: "homepage" | "vercel" | "netlify" | null
  url: string | null
  evidence: string[]
}

export function detectDeployment(
  repository: RepositoryMetadata,
  presentPaths: readonly string[],
): DeploymentDetection {
  // Provider configuration is checked first so a declared homepage (a
  // separate repository-metadata/UI concern, always shown on its own) never
  // shadows genuine configuration evidence when both are present.
  if (presentPaths.includes("vercel.json")) {
    return {
      status: "configured",
      provider: "vercel",
      url: null,
      evidence: ["Vercel configuration detected"],
    }
  }

  if (presentPaths.includes("netlify.toml")) {
    return {
      status: "configured",
      provider: "netlify",
      url: null,
      evidence: ["Netlify configuration detected"],
    }
  }

  if (repository.homepage) {
    return {
      status: "declared",
      provider: "homepage",
      url: repository.homepage,
      evidence: [
        "Repository declares a homepage URL; this is not verified as a live deployment",
      ],
    }
  }

  return {
    status: "unknown",
    provider: null,
    url: null,
    evidence: [],
  }
}
