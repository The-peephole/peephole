# Requester IP trust model

Peephole uses `requester.ip` only as a quota dimension. In production the Node
Preview API listens on `127.0.0.1:8787` behind one public Caddy reverse proxy,
so the socket peer is Caddy rather than the browser.

## Application trust boundary

`resolveRequesterIp` applies these rules before `PreviewSessionAuth` creates a
requester:

1. Parse and canonicalize `request.socket.remoteAddress` as IPv4 or IPv6.
2. Trust `X-Forwarded-For` only when that direct peer is IPv4 or IPv6
   loopback, including IPv4-mapped loopback.
3. Reject the complete forwarded chain when it is empty, malformed, longer
   than 1,024 characters, or contains more than 32 hops, then fall back to the
   socket peer.
4. Canonicalize every forwarded IP. IPv4-mapped IPv6 is collapsed to IPv4 so
   equivalent spellings share a quota bucket.
5. Walk a valid chain right-to-left, skipping only trusted loopback hops. The
   nearest non-loopback hop is the requester IP. Values farther left of that
   untrusted boundary are not trusted.

Canonical output is at most 39 characters, below the existing 64-character
`PreviewControlPlane` requester limit. Missing or invalid synthetic socket
addresses retain the historical `127.0.0.1` fallback but cannot cause a
forwarding header to be trusted.

## Caddy configuration decision

For the current one-hop topology, a normal
`reverse_proxy 127.0.0.1:8787` needs no `header_up` override. Caddy sets
`X-Forwarded-For` for reverse-proxied requests by default and ignores incoming
client-supplied `X-Forwarded-*` values unless a trusted-proxy configuration
explicitly says otherwise. See Caddy's
[reverse_proxy header defaults](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

The repository does not currently track the deployed Caddyfile. A 2026-09-09
probe of the public `/healthz` and `/readyz` endpoints returned `Via: 1.1
Caddy`, confirming the live proxy path, but a response cannot prove the
absence of a custom header override. Deployment review should confirm that the
live Caddyfile does not copy an untrusted incoming `X-Forwarded-For` value.

Do not add a rule that copies an unvalidated incoming `X-Forwarded-For` value.
If a CDN, load balancer, container bridge, or remote proxy is later added, its
exact address ranges must be configured deliberately in both Caddy and the
application trust model. Until then, the application trusts loopback only.
