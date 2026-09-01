import { createRepositoryMetadataMessageLoader } from "../../core/github/messages"
import { GitHubPageController } from "./GitHubPageController"
import { mountPeepholeUi } from "./mountPeepholeUi"

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(context) {
    const loadRepositoryMetadata = createRepositoryMetadataMessageLoader({
      send: (message) => browser.runtime.sendMessage(message),
    })
    const controller = new GitHubPageController(
      document,
      window.location,
      (target, repository) =>
        mountPeepholeUi(target, repository, loadRepositoryMetadata),
    )

    controller.start()
    context.onInvalidated(() => controller.stop())
  },
})
