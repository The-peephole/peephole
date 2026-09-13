# Production smoke verification

## Purpose

This gate verifies an already-deployed Peephole production instance. It does
not deploy code, restart services, bypass authentication, repair resources, or
mutate the database outside normal authenticated Preview API job creation.

The verifier is deliberately split across two trust levels:

1. `npm run smoke:production` performs non-privileged public API, preview,
   artifact, and cache checks.
2. `npm run smoke:production:host` runs on the production Linux host and uses
   read-only database and host inspection to prove the worker became quiescent.

Neither command is part of normal PR CI. Production credentials and EC2-local
visibility make this an operator-run post-deployment gate; a future
`workflow_dispatch` release workflow can invoke the same commands without
changing their security model.

## Pinned fixture

The gate uses the first-party public golden fixture already exercised by the
real Vite and gVisor suites:

```text
repository: ppsssj/peephole-fixture-vite-react
repository id: 1354475085
commit: d1ac2e71550484b5072de243b4dbf754367ed045
contract: static-v1
```

The commit is immutable and was verified to exist. No branch tip is consulted.
The server still resolves the repository identity and derives the Vite/npm
build plan independently; the smoke client does not submit or trust a build
plan.

## API smoke

### Authentication and configuration

Required environment variables:

- `PEEPHOLE_SMOKE_API_BASE_URL`: the expected production HTTPS API origin,
  without credentials, path, query, or fragment;
- `PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN`: the configured production artifact
  base domain, without a scheme or wildcard;
- `PEEPHOLE_SMOKE_SESSION_TOKEN`: a currently valid short-lived Peephole
  session obtained through the normal **Connect GitHub** flow.

The token is not a GitHub credential. Keep it only in the invoking process
environment and do not commit it, put it in a `WXT_` variable, save it in an
environment file, or paste it into logs. The verifier reads the embedded
expiry and fails before making authenticated requests unless the session can
remain valid throughout the configured polling and request window. Reconnect
GitHub to obtain another session.

Example:

```bash
export PEEPHOLE_SMOKE_API_BASE_URL="https://api.example.com"
export PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN="preview.example.net"
export PEEPHOLE_SMOKE_SESSION_TOKEN="<short-lived Peephole session>"
npm run smoke:production
unset PEEPHOLE_SMOKE_SESSION_TOKEN
```

Optional bounded controls:

| Variable | Default | Allowed range |
| --- | ---: | ---: |
| `PEEPHOLE_SMOKE_POLL_INTERVAL_MS` | 2,000 ms | 250–10,000 ms |
| `PEEPHOLE_SMOKE_POLL_TIMEOUT_MS` | 10 minutes | 30 seconds–15 minutes |
| `PEEPHOLE_SMOKE_REQUEST_TIMEOUT_MS` | 15 seconds | 1–60 seconds |
| `PEEPHOLE_SMOKE_ARTIFACT_MAX_BYTES` | 1 MiB | 16 KiB–4 MiB |

### Checks

The API mode:

1. requires exact HTTP 200 JSON from public `/healthz` and `/readyz` with
   redirects disabled and bounded bodies;
2. creates a preview for the pinned commit using the existing authenticated
   Preview API and a fresh idempotency key;
3. accepts only `queued`, `fetching`, `installing`, `building`, and
   `publishing` while polling, fails immediately on a terminal failure or an
   unexpected state, and stops at the configured timeout;
4. requires `status=ready`, `errorCode=null`, `errorMessage=null`, and a
   non-expired artifact reference;
5. applies the extension's existing production artifact-origin policy before
   fetching anything;
6. fetches only the approved HTTPS URL, follows no redirect, requires HTTP 200
   and `text/html`, reads at most the configured byte limit, and checks the
   stable fixture title;
7. submits the same exact commit again and requires a ready cache hit with the
   same cache key and artifact URL.

The first request may legitimately be either a cache miss or hit. A fresh
cache miss is a separate runner-version rollout check, not an invariant of a
normal production smoke. The follow-up request must be a hit.

## Host-local residue smoke

Run host mode immediately after API mode, on an otherwise idle production
worker. The ready response can precede the worker's final teardown by a small
interval, so host mode polls for up to 60 seconds by default rather than racing
normal cleanup.

Prerequisites:

- Linux production host;
- UID 0, or an equivalent operator invocation that results in UID 0;
- production `PEEPHOLE_DATABASE_URL` and, when used, the matching
  `PEEPHOLE_DATABASE_SSL_CA` available only in the process environment;
- `systemctl`, `journalctl`, `runsc`, `ip`, `iptables`, `ip6tables`, and
  `losetup` on `PATH`;
- the same `PEEPHOLE_API_PORT`, `PEEPHOLE_GVISOR_BUNDLES_DIR`, and
  `PEEPHOLE_GVISOR_RUNSC_ROOT` values used by production when they differ from
  defaults.

The script never invokes `sudo`. An operator may use an approved root shell or
preserve only the required environment variable names, without placing secret
values in the command itself:

```bash
sudo --preserve-env=PATH,PEEPHOLE_DATABASE_URL,PEEPHOLE_DATABASE_SSL_CA,PEEPHOLE_API_PORT,PEEPHOLE_GVISOR_BUNDLES_DIR,PEEPHOLE_GVISOR_RUNSC_ROOT \
  npm run smoke:production:host
```

Optional host controls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PEEPHOLE_SMOKE_NETWORK_LEASE_DIR` | `/var/run/peephole/net-leases` | Dedicated network lease root |
| `PEEPHOLE_SMOKE_HOST_POLL_INTERVAL_MS` | 2,000 ms | Quiescence poll interval |
| `PEEPHOLE_SMOKE_HOST_TIMEOUT_MS` | 60 seconds | Maximum cleanup wait, bounded to five minutes |
| `PEEPHOLE_SMOKE_LOG_SINCE` | `15 minutes ago` | Journal window for known worker/cleanup errors |

Host mode first checks `peephole` and `caddy` service activity and the local
loopback health/readiness endpoints. It then uses a PostgreSQL transaction with
`SET TRANSACTION READ ONLY` and fixed `SELECT` statements to require:

- zero active build jobs;
- zero rows in the preview queue.

It reports only Peephole-shaped resources under configured or dedicated roots:

- containers in the dedicated Peephole runsc root;
- exact final, transactional, releasing, and lock names in the network lease
  root;
- `peephole-<slot>` network namespaces and `veph`/`vpph` interfaces;
- `ppe`/`ppi`/`ppr` chains, veth hooks, and Peephole comments in IPv4, NAT, and
  IPv6 rules;
- exact cryptographic bundle, allocation, and allocation-lock names under the
  configured bundles root;
- mount targets and loop backing files matching an exact Peephole bundle and
  `workspace`/`workspace.img` path;
- known production worker, cleanup, and startup error messages in the selected
  journal window.

Unrelated directories, interfaces, and firewall rules are ignored. Malformed
command output, missing privileges, failed commands, unreadable roots, or an
unavailable database fail closed instead of being interpreted as an empty
host.

## Output and safety

Successful checks are line-oriented for release records:

```text
[PASS] public health: HTTP 200
[PASS] public readiness: HTTP 200
[PASS] job ready: job <id>; initial cache hit
[PASS] artifact: trusted HTTPS HTML returned HTTP 200
[PASS] cache response: job <id>; hit and ready
PRODUCTION SMOKE PASS
```

A failure identifies the check, prints `PRODUCTION SMOKE FAIL`, and exits
non-zero. Tokens, database URLs, and secrets are never printed.

Both modes are inspection-only except for the two normal authenticated Preview
API create requests. They never restart a service, send a signal, cancel a
job, delete a database row, remove a namespace or firewall rule, detach a loop
device, unmount a filesystem, or remove a bundle. Residue is evidence: the
verifier reports it and fails so an operator can investigate through the
documented ownership-aware recovery path.

## Release operator sequence

1. Confirm the intended revision is already deployed and ordinary PR/deploy
   checks are green.
2. Ensure no unrelated preview is active.
3. Obtain a fresh Peephole session through **Connect GitHub**.
4. Run API mode and retain its PASS output and job IDs.
5. Run host mode on EC2 and retain its PASS output.
6. Treat either non-zero exit as a failed release smoke. Do not use this tool to
   repair the host or bypass authentication.
