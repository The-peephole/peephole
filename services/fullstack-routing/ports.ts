import type { IncomingMessage, ServerResponse } from "node:http"

import type { FullStackPreviewStatus } from "../../types/fullstackPreview"
import type { BackendRuntimeDialTarget } from "../backend-runtime-worker/ports"

/** The serving plane's intentionally narrow durable view. */
export interface FullStackRoutingRecord {
  id: string
  status: FullStackPreviewStatus
  artifactId: string | null
  backendRuntimeId: string | null
  expiresAt: Date
}

export interface FullStackRoutingStore {
  get(id: string): Promise<FullStackRoutingRecord | null>
}

export interface FullStackBackendProxy {
  proxy(
    request: IncomingMessage,
    response: ServerResponse,
    target: BackendRuntimeDialTarget,
    requestTarget: string,
  ): Promise<void>
}
