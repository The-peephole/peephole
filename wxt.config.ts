import { defineConfig } from "wxt"

import {
  getPreviewApiHostPermission,
  parsePreviewApiBaseUrl,
} from "./core/preview/config"

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: () => {
    const previewApiBaseUrl = parsePreviewApiBaseUrl(
      import.meta.env.WXT_PREVIEW_API_BASE_URL,
    )

    return {
      name: "Peephole",
      description: "Preview a GitHub repository before you clone it.",
      version: "0.1.0",
      minimum_chrome_version: "116",
      permissions: ["sidePanel"],
      host_permissions: [
        "https://api.github.com/*",
        ...(previewApiBaseUrl
          ? [getPreviewApiHostPermission(previewApiBaseUrl)]
          : []),
      ],
    }
  },
})
