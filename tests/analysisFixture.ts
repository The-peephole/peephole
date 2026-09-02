import type { RepositoryAnalysis } from "../types/analysis"

export const supportedAnalysis: RepositoryAnalysis = {
  repository: {
    repositoryId: 10270250,
    owner: "react",
    repo: "react-app",
    defaultBranch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    homepage: "https://example.com/",
  },
  analyzerVersion: "0.1.0",
  technologies: {
    framework: "react-vite",
    typescript: true,
    evidence: ["vite and react dependencies detected"],
  },
  packageManager: "npm",
  runtime: {
    installCommand: "npm ci",
    devCommand: "npm run dev",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    evidence: ["Build script detected: npm run build"],
    warnings: [],
  },
  environment: {
    templateFound: true,
    variables: ["VITE_API_URL"],
    publicClientVariables: ["VITE_API_URL"],
    secretLikeVariables: [],
  },
  deployment: {
    status: "configured",
    provider: "homepage",
    url: "https://example.com/",
    evidence: ["Repository homepage metadata detected"],
  },
  workspace: {
    monorepo: false,
    ambiguous: false,
    evidence: [],
  },
  preview: {
    contractVersion: "static-v1",
    mode: "native-static-build",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    evidence: [
      "vite and react dependencies detected",
      "package-lock.json selects npm",
      "Build script detected: npm run build",
    ],
    blockers: [],
  },
  inspectedFiles: [
    ".env.example",
    "index.html",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
  ],
  warnings: ["External service variables detected: VITE_API_URL."],
}
