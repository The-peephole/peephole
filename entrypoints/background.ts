import { GitHubClient } from "../core/github/client"
import { createRepositoryMetadataMessageHandler } from "../core/github/messages"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"

export default defineBackground(() => {
  const metadataCache = new RepositoryMetadataCache(new GitHubClient())
  const handleMessage = createRepositoryMetadataMessageHandler(
    metadataCache.load,
  )

  browser.runtime.onMessage.addListener((message) => handleMessage(message))
})
