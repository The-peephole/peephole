import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

import type { PreviewRequester } from "../../types/preview"
import type { PreviewControlPlane } from "./controlPlane"
import { createPreviewHttpHandler } from "./http"
import { NodePreviewApiServer } from "./nodeHttpServer"
import type { IssuedPreviewSession } from "./previewSession"
import type { PreviewApiServerConfig } from "./serverConfig"

export interface StartNodePreviewApiOptions {
  controlPlane: PreviewControlPlane
  config: PreviewApiServerConfig
  resolveRequester: (
    request: IncomingMessage,
  ) => PreviewRequester | Promise<PreviewRequester>
  beginGitHubAuth?: (request: IncomingMessage) => Promise<string>
  completeGitHubAuth?: (request: IncomingMessage) => Promise<string>
  issueSession?: (
    request: IncomingMessage,
    body: unknown,
  ) => Promise<IssuedPreviewSession>
  isReady: () => boolean | Promise<boolean>
}

export interface RunningNodePreviewApi {
  address: AddressInfo
  stop(): Promise<void>
}

export async function startNodePreviewApi(
  options: StartNodePreviewApiOptions,
): Promise<RunningNodePreviewApi> {
  const server = new NodePreviewApiServer({
    handlePreviewRequest: createPreviewHttpHandler(options.controlPlane),
    resolveRequester: options.resolveRequester,
    beginGitHubAuth: options.beginGitHubAuth,
    completeGitHubAuth: options.completeGitHubAuth,
    issueSession: options.issueSession,
    isReady: options.isReady,
    maxBodyBytes: options.config.maxBodyBytes,
    requestTimeoutMs: options.config.requestTimeoutMs,
  })
  const address = await server.listen({
    host: options.config.host,
    port: options.config.port,
  })

  return {
    address,
    stop: () => server.close(),
  }
}
