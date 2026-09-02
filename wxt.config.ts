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
      permissions: ["sidePanel", "storage"],
      host_permissions: [
        "https://api.github.com/*",
        ...(previewApiBaseUrl
          ? [getPreviewApiHostPermission(previewApiBaseUrl)]
          : []),
      ],
      content_security_policy: {
        // No production preview domain is provisioned yet (see
        // IMPLEMENTATION_CHECKLIST.md, "Preview Delivery"), so only the
        // loopback-only local development artifact host may be framed.
        // Chrome's MV3 manifest CSP parser rejects an IPv6 host combined
        // with a wildcard port (`http://[::1]:*`), so only IPv4 loopback is
        // listed here; LocalArtifactHost defaults to 127.0.0.1 anyway.
        extension_pages:
          "script-src 'self'; object-src 'self'; " +
          "frame-src 'self' http://127.0.0.1:*;",
      },
    }
  },
})
