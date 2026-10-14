import { GitHubGateway, type GitHubGatewayOptions } from "./githubGateway"

/** Server-only, dedicated credential; never fall back to the admission token.
 * The flag defaults off and the public-only credential guard remains in the gateway. */
export function createConfiguredGitHubGateway(
  environment: NodeJS.ProcessEnv,
  options: Omit<GitHubGatewayOptions, "token"> = {},
): GitHubGateway | null {
  const token = environment.PEEPHOLE_GITHUB_GATEWAY_TOKEN
  return environment.PEEPHOLE_GITHUB_GATEWAY_ENABLED === "true" && token
    ? new GitHubGateway({ ...options, token })
    : null
}
