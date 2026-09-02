import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

import type { PreviewRequester } from "../../types/preview"
import type { PreviewControlPlane } from "./controlPlane"
import { createPreviewHttpHandler } from "./http"
import { NodePreviewApiServer } from "./nodeHttpServer"
import type { PreviewApiServerConfig } from "./serverConfig"

export interface StartNodePreviewApiOptions {
  controlPlane: PreviewControlPlane
  config: PreviewApiServerConfig
  resolveRequester: (
    request: IncomingMessage,
  ) => PreviewRequester | Promise<PreviewRequester>
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
