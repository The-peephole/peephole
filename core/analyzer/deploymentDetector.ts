import type { RepositoryMetadata } from "../../types/repository"

export interface DeploymentDetection {
  status: "confirmed" | "configured" | "unknown"
  provider: "homepage" | "vercel" | "netlify" | null
  url: string | null
  evidence: string[]
}

export function detectDeployment(
  repository: RepositoryMetadata,
  presentPaths: readonly string[],
): DeploymentDetection {
  const evidence: string[] = []
  let provider: DeploymentDetection["provider"] = null

  if (repository.homepage) {
    return {
      status: "confirmed",
      provider: "homepage",
      url: repository.homepage,
      evidence: ["Safe repository homepage metadata detected"],
    }
  }

  if (presentPaths.includes("vercel.json")) {
    provider = "vercel"
    evidence.push("Vercel configuration detected")
  } else if (presentPaths.includes("netlify.toml")) {
    provider = "netlify"
    evidence.push("Netlify configuration detected")
  }

  if (evidence.length === 0) {
    return {
      status: "unknown",
      provider: null,
      url: null,
      evidence: [],
    }
  }

  return {
    status: "configured",
    provider,
    url: null,
    evidence,
  }
}
