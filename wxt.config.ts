import { defineConfig } from "wxt"

import {
  getPreviewApiHostPermission,
  getPreviewFrameSrc,
  parsePreviewArtifactBaseDomain,
  parsePreviewApiBaseUrl,
} from "./core/preview/config"

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: () => {
    const previewApiBaseUrl = parsePreviewApiBaseUrl(
      import.meta.env.WXT_PREVIEW_API_BASE_URL,
    )

    const previewArtifactBaseDomain = parsePreviewArtifactBaseDomain(
      import.meta.env.WXT_PREVIEW_ARTIFACT_BASE_DOMAIN,
    )

    return {
      name: "Peephole",
      description: "Preview a GitHub repository before you clone it.",
      version: "0.1.0",
      icons: {
        16: "icons/peephole-16.png",
        32: "icons/peephole-32.png",
        48: "icons/peephole-48.png",
        128: "icons/peephole-128.png",
      },
      minimum_chrome_version: "116",
      permissions: ["identity", "sidePanel", "storage"],
      host_permissions: [
        "https://api.github.com/*",
        ...(previewApiBaseUrl
          ? [getPreviewApiHostPermission(previewApiBaseUrl)]
          : []),
      ],
      web_accessible_resources: [
        {
          resources: ["icons/peephole-32.png"],
          matches: ["https://github.com/*"],
        },
      ],
      content_security_policy: {
        // Artifacts need framing permission only, never host_permissions.
        // Chrome's MV3 manifest CSP parser rejects an IPv6 host combined
        // with a wildcard port (`http://[::1]:*`), so only IPv4 loopback is
        // listed here; LocalArtifactHost defaults to 127.0.0.1 anyway.
        extension_pages:
          "script-src 'self'; object-src 'self'; " +
          getPreviewFrameSrc(previewArtifactBaseDomain),
      },
    }
  },
})
