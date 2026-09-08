import type { IncomingMessage } from "node:http"

import type { PreviewRequester } from "../../types/preview"
import { extractBearerToken } from "./bearerToken"
import { HttpIngressError } from "./nodeHttpServer"
import type { PreviewSessionIssuer } from "./previewSession"

/**
 * Resolves the requester for every preview API route except login
 * (`POST /v1/auth/session`, see devServer.ts) from a Peephole session
 * token instead of a raw credential -- see PreviewSessionIssuer's doc
 * comment for why. Its error messages point the caller back through the
 * login flow rather than at the extension's options page, since by this
 * point the problem is the session (missing/expired/tampered), not
 * necessarily the underlying GitHub token.
 */
export class PreviewSessionAuth {
  constructor(private readonly issuer: PreviewSessionIssuer) {}

  async resolve(request: IncomingMessage): Promise<PreviewRequester> {
    const ip = request.socket.remoteAddress ?? "127.0.0.1"
    const token = extractBearerToken(request.headers.authorization)

    if (!token) {
      throw new HttpIngressError(
        401,
        "A Peephole session is required. Sign in again.",
        "UNAUTHORIZED",
      )
    }

    const subject = await this.issuer.verify(token)

    if (!subject) {
      throw new HttpIngressError(
        401,
        "This session has expired or is invalid. Sign in again.",
        "UNAUTHORIZED",
      )
    }

    return { subject, ip }
  }
}
