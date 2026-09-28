# Temporary PostgreSQL Previews (M11) — Design

**Status: DESIGN ONLY. Not implemented. Not deployed. Not production-verified.**

M11 (`docs/MVP_ROADMAP.md` stage 11, "temporary database support") remains
`[ ]` / NOT STARTED. Nothing described in this document exists in the
codebase yet: no new types, no new services, no new migration, no new
network rule, no second PostgreSQL cluster. `services/production/server.ts`
is unchanged. `BackendRuntimePlan.platformEnvironment` is unchanged (still
exactly `PORT`/`HOST`/`NODE_ENV`). `PreviewGeneratedSecretName` is unchanged
(still exactly `JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET`/`CSRF_SECRET`).

This document is the output of a four-phase, code-and-production-grounded
architecture investigation (M11-A through M11-A4) conducted before any
implementation, mirroring the role `docs/EPHEMERAL_SECRETS.md` played for
M10:

- **M11-A** read the actual M8-M10 codebase (backend/fullstack lifecycle,
  the M10 generated-secret path, network isolation, existing PostgreSQL
  usage, the existing reaper/ownership model) and produced a first design.
- **M11-A2** independently reviewed M11-A and corrected several errors: a
  network-topology assumption that only holds for a remote database; added
  the real FullStack-only admission split (§2 below); propagated the
  durable FullStack ownership identity to the backend worker design (§3);
  corrected PostgreSQL role/`CREATEROLE`/`SET` semantics; closed the
  `PUBLIC` CONNECT race with `ALLOW_CONNECTIONS false`; replaced a
  raw-password `CREATE ROLE` design with a client-computed SCRAM verifier;
  expanded orphan reconciliation from a two-set (database + durable row)
  comparison to the current three-set (database + role + durable row)
  design (§14); narrowed teardown to `DROP DATABASE` + `DROP ROLE` with no
  automatic `DROP OWNED`; replaced an M10-secret-broker-shaped
  issue/take design with the current `TemporaryDatabaseProvisioner` shape;
  and replaced a generic `NAME=value` credential-file parser with the
  current single fixed `database-url` file.
- **M11-A3** performed a **read-only** audit of the actual production EC2
  host (`3.34.33.24`) — real CPU/RAM/disk, the real installed PostgreSQL
  version, the real control-plane database topology (sanitized only, no
  credential ever read into this document), the real network interfaces
  and routes — and used those facts to correct the network-topology design
  from an unverified assumption to an evidence-based one. **No production
  change was made during this audit.**
- **M11-A4** corrected the PostgreSQL role/privilege sequence against actual
  PostgreSQL 18 semantics (the production host runs 18.6, not 16), locked
  the final provisioning/teardown SQL sequence, and resolved the last open
  design question (Unix-socket administrative authentication) using
  evidence gathered in M11-A3 rather than an assumption.

The verdict at the end of M11-A4 was `READY_FOR_M11_DESIGN_DOCS`. This
document is that deliverable. It does not itself implement anything, and
this PR alone does not authorize starting implementation. After this
design-document PR is reviewed and merged, the planned next stage is
M11-C1.

### M11 stage sequence

Planning/status terminology only — this is not a new roadmap stage
numbering, and it does not change `docs/MVP_ROADMAP.md` stage 11, which
stays `[ ]` regardless of how many of these sub-stages complete.

| Stage | Scope | Status |
|---|---|---|
| M11-A | Architecture investigation / read-only production audit / final architecture lock | **COMPLETE** |
| M11-B | Design documentation (this document, D-033) | **CURRENT — PR #33** |
| M11-C1 | Portable types / admission / ownership foundation | NOT STARTED |
| M11-C2 | PostgreSQL provisioning + durable ownership / reconciliation | NOT STARTED |
| M11-C3 | Credential delivery + host-only sandbox network integration | NOT STARTED |
| M11-C4 | Integrated FullStack lifecycle | NOT STARTED |
| M11-D | Real Linux / real-gVisor verification | NOT STARTED |
| M11-E | Production infrastructure activation + production acceptance | NOT STARTED |

**The production host's RAM is a documented future prerequisite, not
something already done.** M11-A3 found the production host to be a tight
2 vCPU / ~1.9 GiB RAM instance with no swap, already running close to its
own documented per-sandbox ceiling before M11 exists at all. §18 locks the
requirement that production RAM be increased (or an equivalent,
separately-reviewed safe-headroom analysis be produced) **before M11
production activation** — this has **not** happened, and nothing in this
document should be read as claiming it has. That gate does not block
writing this document, portable implementation, PostgreSQL-18 integration
testing, or real-gVisor verification — only final production acceptance.

See `docs/DECISIONS.md` D-033 for the corresponding decision record
(**Proposed**, not Accepted).

---

## 1. First-slice scope (locked)

### Supported

- `fullstack-v1` only. Standalone/public `backend-v1` database admission is
  explicitly denied (§4).
- Backend adapter: `express-node-npm-v1` (Express, npm, a committed
  `package-lock.json`) — the same, only implemented backend-v1 adapter M8
  already established. No new adapter.
- Dependency evidence: exactly `pg` (node-postgres) present, and no other
  `DATABASE_DEPENDENCIES` member (`mysql2`, `mongoose`, `better-sqlite3`,
  `prisma`, `@prisma/client`) present.
- Environment requirement: exactly one `database-requirement`-classified
  name, and it must be exactly `DATABASE_URL`.
- Exactly one temporary PostgreSQL database per admitted FullStack preview.
- Exactly one application PostgreSQL role per temporary database.
- Automatic, server-owned provisioning — the client never requests, names,
  or configures any database property.
- Automatic `DATABASE_URL` injection into the backend's process environment,
  delivered outside the OCI `process.env`/`config.json` path (§16), never
  through `platformEnvironment`.
- Normal cleanup on `DELETE`/expiry/cancel.
- Crash/startup orphan reconciliation (§15).

### Not supported

- Standalone/public `backend-v1` database runtime (no durable FullStack
  anchor exists for it — see §5).
- Prisma / `@prisma/client` (would require unbounded `schema.prisma`
  parsing to confirm the provider is actually PostgreSQL).
- MySQL, MongoDB, Redis, SQLite provisioning of any kind.
- `POSTGRES_URL`, `POSTGRESQL_URL`, `PGHOST`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE`, or any other database-shaped environment name besides the
  exact string `DATABASE_URL`.
- A user-supplied `DATABASE_URL` value of any kind.
- An external or user-selected database (RDS the user names, a third-party
  connection string, etc.).
- A persistent (non-temporary) database.
- Database sharing between previews, in any form.
- Broad backend egress or NAT of any kind — the existing `backend-v1`
  ingress-only invariant (no default route, unconditional egress `DROP`
  except the one narrow exception in §8) is unchanged.
- Docker Compose or any other auxiliary-service orchestration.

**Ambiguity always fails closed.** A repository that declares `pg` plus a
second, unsupported database-shaped requirement; a repository that declares
`DATABASE_URL` without a `pg` dependency; a repository using Prisma even if
its underlying provider happens to be PostgreSQL — all remain
`UNSUPPORTED_BACKEND`, never partially admitted.

---

## 2. Admission boundary

Confirmed directly from `services/backend-runtime-api/controlPlane.ts`
(read in M11-A2): both the public path and the trusted orchestration path
converge on the same internal admission function and the same plan
resolver.

```text
BackendRuntimeControlPlane.create()              (public, client-facing)
             \
              -> createInternal()                (shared)
             /
createForOrchestration()                          (trusted, worker-only,
                                                     called only by
                                                     FullStackPreviewSupervisor)
```

`backendRuntimeAdapter.ts` is designed to stay **context-free** — it would
have no notion of who is asking. It would be extended to resolve a plan
that carries a new, proposed field:

```ts
databaseRequirement: { name: "DATABASE_URL" } | null
```

The split between "may admit a DB-requiring plan" and "may not" is designed
to belong entirely to `createInternal()` (an existing function), the one
place that already knows today whether the caller is the trusted
orchestration boundary (`orchestrationKey !== null`) or a public request
(`orchestrationKey === null`):

```text
databaseRequirement != null
AND
orchestrationKey == null
→ UNSUPPORTED_BACKEND
```

Under this design, only the trusted FullStack path — where
`orchestrationKey` is always `FullStackPreview.id`, minted server-side
inside `FullStackPreviewSupervisor`, never client input — would be able to
admit a DB-requiring plan.

The client, under this design, in every case:

- would not be able to supply `orchestrationKey`;
- would not be able to request "database capability";
- would not be able to provide a database identity, name, or role;
- would not be able to provide a database credential;
- would not be able to provide `DATABASE_URL` or any component of it.

The server would independently re-resolve every piece of database
evidence (framework, dependency, environment requirement classification)
from the exact pinned commit, the same way it already does today for
every other backend-v1 evidence class.

**No new public contract version planned.** `BackendRuntimePlan` would gain
one additional, optional, server-derived field — the same
backward-compatible pattern M10 used when it added `generatedSecretNames`
without bumping `BACKEND_RUNTIME_CONTRACT_VERSION` away from
`"backend-v1"`.

---

## 3. Ownership identity flow

The durable owner of a temporary database is the **FullStack preview**,
never the process-local backend runtime. Confirmed from
`services/fullstack-preview-worker/fullStackPreviewSupervisor.ts`:
`orchestrationKey` passed into `createForOrchestration()` is literally
`authoritative.id` — the FullStack preview's own durable id — so this
identity already exists server-side; M11 only needs to make it reach the
worker that actually provisions the database.

```text
FullStackPreview.id
  → BackendRuntimeControlPlane.createForOrchestration(..., orchestrationKey)
  → StoredBackendRuntime.orchestrationKey        (already exists; internal-only)
  → QueuedBackendRuntime.orchestrationKey         (M11 addition — the gap M11-A2
                                                    found: today's QueuedBackendRuntime
                                                    carries only {runtimeId,
                                                    repository, plan})
  → BackendRuntimeSupervisor (worker) would then know the durable
    FullStack owner without ever accepting anything from a client
```

**Invariant, to be re-checked at the worker boundary, not just trusted
from admission:**

```text
databaseRequirement != null → orchestrationKey != null
```

`BackendRuntimeSupervisor.run(queued)` (an existing method) would assert
this defensively before ever calling the provisioner, and would fail
closed if it were ever violated — the same "never trust upstream,
re-verify at each boundary" discipline this supervisor already applies
today by re-running `validateBackendRuntimePlan()` even though the control
plane validated the plan once already.

**`StoredFullStackPreview.databaseResourceId` is deliberately planned to
not be added.** The durable ownership table in §6 is designed to be the
sole durable source of DB-resource ownership, queried by `previewId`.
Adding a second, redundant pointer on `StoredFullStackPreview` would be
exactly the class of driftable coordinate that type's own existing doc
comment already forbids for network coordinates (`peerIp`/`dialTarget`-style
fields).

---

## 4. Durable ownership table (future — not created yet)

Proposed table name: `peephole_temporary_databases`, in the **control-plane**
PostgreSQL (`18-main`), alongside `peephole_fullstack_previews`. No
migration file exists yet; this section documents the target shape only.

Minimum logical fields:

```text
resource_id          text primary key
preview_id            text not null
backend_runtime_id    text
status                text not null
created_at            timestamptz not null
updated_at            timestamptz not null
```

`resource_id` is designed to be the canonical, server-minted,
Postgres-identifier-safe id (fixed-length, lowercase,
`[a-z][a-z0-9_]{7,30}`, never derived from repository/branch/client input)
that would be the **single** source both the database name and the role
name are derived from:

```text
database name = pv_<resource_id>
role name     = pv_<resource_id>
```

No redundant `database_name`/`role_name` columns are planned unless
implementation analysis later proves a concrete need (e.g. a future
requirement to decouple the two names) — until then those would be pure
duplication of `resource_id`.

**Never made durable, in this table or anywhere else:**

- the application password
- the SCRAM verifier
- the assembled `DATABASE_URL`
- the database host/port (fixed production config, not per-row state)
- the provisioning credential
- the credential tmpfs path
- any live network coordinate

Statuses:

```text
provisioning
provisioned
revoking
revoked
revoke_failed
```

Foreign key:

```text
preview_id
  REFERENCES peephole_fullstack_previews(id)
  ON DELETE RESTRICT
```

**Never `ON DELETE CASCADE`, and deliberately not `SET NULL` either** — see
the contrast below.

**Why `RESTRICT`, not `CASCADE` or `SET NULL`:** migration `003_fullstack_previews.sql`'s
existing FKs (`frontend_job_id`, `artifact_id`) both use `ON DELETE SET
NULL`, because those are **shared** resources — a static build artifact may
be a cache hit another, unrelated preview also references, so one preview's
lifecycle must never block that shared resource's own reaper. A temporary
database is the opposite: it is **exclusively owned** by exactly one
preview, never shared. `SET NULL` would be wrong here — it would silently
sever the ownership row's link to its preview while leaving the row (and,
worse, potentially the still-live physical database) in an orphaned,
harder-to-trace state. `CASCADE` is explicitly forbidden because it could
delete ownership evidence *before* physical DB/role cleanup has been
verified — exactly the failure mode this whole design exists to prevent.
`RESTRICT` (PostgreSQL's `NO ACTION` made explicit) would make it
*structurally impossible* to delete a `peephole_fullstack_previews` row
while any `peephole_temporary_databases` row still references it.

In practice this would be a pure safety net: nothing in the current
codebase ever issues a raw `DELETE FROM peephole_fullstack_previews`
(every existing lifecycle transition is a `status` `UPDATE`, confirmed by
reading `FullStackPreviewStartupReconciler` and the control plane) — rows
persist indefinitely as historical records today, and this design does not
change that. Ownership evidence would therefore survive, by construction,
until the row itself reaches `revoked` (§13), which would only happen
after physical DB+role cleanup has actually been verified.
**Terminal-row (`revoked`) retention or pruning for table-growth reasons is
a separate, later operational decision, out of scope for this design.**

---

## 5. FullStack/backend-v1 ownership scope

`fullstack-v1` only, for this entire first slice. Standalone `backend-v1`
(no frontend) is deliberately excluded: standalone backend-v1 runtime state
is *entirely* process-local/in-memory today (no FK, no durable row of any
kind — confirmed from `services/preview-api/postgres/migrations/003_fullstack_previews.sql`'s
own comment: `backend_runtime_id` has no FK because "backend-v1 runtime
state remains in-memory only... there is no durable table to reference").
Extending standalone `backend-v1` to also carry durable state, purely so a
temporary database would have somewhere durable to be owned from, is a
separate, larger project this slice does not take on.

---

## 6. PostgreSQL deployment topology

Two structurally, operationally, and credentially separate PostgreSQL
clusters. **PostgreSQL roles are cluster-global** — this is the load-bearing
fact behind the whole separation: if per-preview application roles lived in
the same cluster as the control-plane's own databases and roles, a
compromised repository's sandboxed backend receiving only its own tenant
`DATABASE_URL` would still be one PostgreSQL server away from every other
database name that happens to exist on that same cluster, and the M11
security proof would have to depend on correctly auditing and revoking
`PUBLIC` privileges on every unrelated database forever, not just the ones
M11 itself creates. A separate cluster removes that dependency entirely.

### Control plane (existing, unchanged by M11)

```text
PostgreSQL 18-main
127.0.0.1:5432
PEEPHOLE_DATABASE_URL
```

Confirmed live during the M11-A3 read-only audit: this is the actual,
already-running production cluster, hostname category `loopback`, port
`5432`, serving Peephole's queues, preview/fullstack durable state, cache
metadata, and — once implemented — the temporary-database **ownership
rows** from §4 (never credentials, never the temporary databases
themselves).

### Tenant temporary-database service (future — does not exist yet)

```text
PostgreSQL 18-tenant
192.168.253.1:5433
dedicated cluster, dedicated data directory, dedicated pg_hba.conf,
dedicated provisioning credential
```

Confirmed feasible without any new package install: the production host
already has `postgresql-18` and the standard Debian/Ubuntu multi-cluster
tooling (`postgresql-common`, providing `pg_createcluster`/`pg_ctlcluster`)
installed. Creating a second cluster (illustratively,
`pg_createcluster 18 tenant --port 5433`) is a supported, ordinary operation
on this exact host — **not performed by this document**.

The tenant cluster must never share cluster-global roles, catalogs,
`pg_hba.conf`, or credentials with `18-main`. A per-preview `pv_*`
application role must never exist in `18-main`.

---

## 7. Host-only network architecture

Confirmed against the actual production host's live interfaces and routes
during the M11-A3 read-only audit (`ens5` on `172.31.36.11/20`, VPC subnet
`172.31.32.0/20`; the existing job-lease pool fully reserves
`10.200.0.0/16` — `NETWORK_POOL_SIZE = 16,384` leases × 4 addresses each,
confirmed from `services/preview-worker/gvisor/subnetAllocator.ts`; no
dummy/bridge interface exists yet).

### Target (future, not configured yet)

```text
root namespace:
  dummy interface: pphdb0
  address:         192.168.253.1/32

tenant postgres:
  listen_addresses = 192.168.253.1
  port             = 5433

sandbox route (per lease, added alongside the existing directly-attached
lease subnet route -- never replacing it):
  192.168.253.1/32 via <lease.hostIp> dev peerVeth
```

`192.168.253.1/32` was chosen specifically because it collides with nothing
observed on the live host: it is outside the fully-reserved
`10.200.0.0/16` job-lease pool, and outside the entire `172.31.0.0/16` AWS
default VPC range this instance's ENI lives in (not just the specific `/20`
currently assigned to `ens5`, to guard against any future VPC subnet
appearing elsewhere in that same `/16`).

### Packet path

```text
sandbox
   ↓
peerVeth / hostVeth
   ↓
root namespace routing decision
   ↓
INPUT                              (NOT FORWARD -- 192.168.253.1 is bound
                                     to a root-namespace-owned interface,
                                     so the kernel resolves it as locally
                                     addressed the instant it crosses
                                     hostVeth)
   ↓
per-lease inputChain
   ↓
exact destination-IP + port ACCEPT
   ↓
192.168.253.1:5433
```

Future allow rule (inserted **before** the existing per-lease `inputChain`
deny, on the same chain the existing `ESTABLISHED,RELATED → ACCEPT, else
DROP` rules already live on):

```text
-i <hostVeth>
-d 192.168.253.1/32
-p tcp
--dport 5433
-j ACCEPT
```

**Why `FORWARD` is not used for this destination:** `FORWARD` is the chain
`ingress-only`'s existing `egressChain`/`returnChain` already hook into
(`FORWARD -i hostVeth -j egressChain`, `FORWARD -o hostVeth -j
returnChain`), and it is only ever consulted when the kernel's routing
decision determines traffic is being routed *through* the host toward a
third destination. A destination address that is itself bound to a
root-namespace-owned interface is never routed "through" anything — it
terminates at the host's own IP stack, which is exactly why this traffic is
evaluated by `INPUT` instead.

**Unchanged, explicitly:**

- `egressChain` — byte-for-byte the same unconditional `DROP` it is today.
- `returnChain` — unchanged.
- NAT / MASQUERADE — none added; nothing about this path crosses `ens5`
  (the VPC-facing interface) at all.
- The sandbox's absence of a default route.
- General backend internet egress — still categorically denied.

**Return path:** Postgres's reply is host-locally-generated traffic
addressed to the sandbox's own `peerIp` — the same class of traffic as the
already-existing readiness probe, which the codebase's own comments already
document as needing no firewall exception on the way out. It flows out via
`OUTPUT` (confirmed, on the live host, to carry no Peephole-managed rules
today — left at its default-permissive policy) and is delivered into the
sandbox's netns via the veth pair's already-existing directly-connected
route. No new `OUTPUT`, `FORWARD`, or `returnChain` rule is needed.

**This does not turn `192.168.0.0/16` into an allowed range.** Exactly one
`/32` address and exactly one TCP port are ever allowed, both named
explicitly in both the sandbox's added route and the firewall rule — never
a CIDR, never a range, never a wildcard port.

**No DNS requirement:** `DATABASE_URL` would be assembled with the fixed,
numeric `192.168.253.1` address directly, never a hostname — the sandbox
would need no DNS resolution capability for this path (and, per the
existing `ingress-only` policy, has none today).

---

## 8. Tenant PostgreSQL authentication

### Sandbox-facing TCP

```text
source: 10.200.0.0/16   (the full, exact job-lease pool boundary)
auth:   scram-sha-256
```

No `trust`. No `peer` for sandbox connections. No VPC CIDR. No public
address. No arbitrary source range.

### Provisioning (administrative) connection

Designed to use the local PostgreSQL **Unix-domain socket**, never the
sandbox-facing TCP endpoint. This would keep Peephole's own provisioning
traffic structurally separate from tenant application traffic
(distinguishable in `pg_hba.conf` and in any logging), and would mean the
provisioning path never depends on the `pphdb0` dummy interface at all.

**Authentication: password/SCRAM, not `peer`/`pg_ident` mapping.** This is
an evidence-based decision, not an assumption: the M11-A3 audit read the
actual, live `peephole.service` systemd unit file. It carries **no
`User=`/`Group=` directive**, meaning the service runs as **root** (the
default when no such directive is present, and independently corroborated
by the codebase's own repeated documentation that the production process
must be privileged for gVisor/runsc/loop-device/network-namespace
operations). A `peer`-mapped provisioning role would map to OS user `root`
— meaning *any* root-privileged process on the host, not specifically
Peephole, could authenticate as the provisioning role with no credential
check at all. That would be a strictly broader trust boundary than every
other privilege boundary in this design, all of which are designed as
explicit, narrow, provable grants. The provisioning role is therefore
designed to use a **static, operator-managed credential**, never generated
or rotated by Peephole itself — the same *kind* of credential
`PEEPHOLE_DATABASE_URL` already is today.

Future config concept (not created yet):

```text
PEEPHOLE_TENANT_DB_PROVISIONING_URL
```

- server-only;
- static, operator-managed, never generated at runtime;
- stored the same way `PEEPHOLE_DATABASE_URL` already is
  (`/etc/peephole/peephole.env`), as a **separate** variable;
- never passed to a sandbox, in any form;
- never written into `peephole_temporary_databases` or any other durable
  row.

No real credential value is invented or included anywhere in this document.

---

## 9. Provisioning role privilege boundary

**Never `SUPERUSER`**, at any point.

### Provisioning role (future)

```text
NOSUPERUSER
CREATEDB
CREATEROLE
NOREPLICATION
NOBYPASSRLS
```

### Application (`pv_*`) roles (future)

```text
LOGIN
NOSUPERUSER
NOCREATEDB
NOCREATEROLE
NOREPLICATION
NOBYPASSRLS
CONNECTION LIMIT 3
```

### PostgreSQL 18 semantics (precise, corrected in M11-A4)

- A `CREATEROLE` creator that is not itself a superuser receives the newly
  created role back with `ADMIN TRUE`, `SET FALSE`, `INHERIT FALSE`. Do not
  rely on `createrole_self_grant` to change this — the design assumes its
  default (no additional automatic self-grant).
- `ADMIN TRUE` alone is what lets the provisioning role later manage
  membership/drop the role it created; it does **not** by itself let the
  provisioning role act *as* that role.
- An explicit `GRANT pv_<id> TO <provisioning_role> WITH SET TRUE` is
  required before the provisioning role can `SET ROLE pv_<id>`. `INHERIT`
  is deliberately left `FALSE` on this membership.
- `CREATE DATABASE ... OWNER pv_<id>` is permitted by that `SET` privilege
  alone — the OWNER clause's check is "can this session assume `pv_<id>`,"
  not "is this session currently `pv_<id>`."
- **Because `INHERIT` stays `FALSE`, merely holding the `SET` grant does
  not mean the provisioning role automatically exercises `pv_<id>`'s
  privileges.** Every subsequent owner-scoped operation (revoking
  `PUBLIC`'s default grants, enabling connections) must run inside an
  explicit `SET ROLE pv_<id>` / `RESET ROLE` boundary — see §11.

Do not describe this design, anywhere, as "the provisioning role has the
owner's privileges once it holds `SET`." That claim is false under `INHERIT
FALSE` and was the specific error M11-A4 corrected from earlier drafts of
this design.

---

## 10. Password / SCRAM design

**PostgreSQL version requirement:** `18.x`, the current deployed patched
minor or later. The production host, audited read-only in M11-A3, already
runs `18.6`. (An earlier draft of this design assumed a PostgreSQL 16
version floor and a specific 16.15 patch requirement; the production host
does not run PostgreSQL 16 at all, and that reasoning does not transfer —
see D-033 for the correction record.)

For every preview:

1. generate a random raw application password, process-locally only
   (reusing the existing `generatePreviewSecretValue()` primitive's CSPRNG
   discipline — the same 256-bit entropy guarantee M10's generated secrets
   already have);
2. read `SHOW scram_iterations` from the tenant cluster (`18-tenant`);
3. generate a random salt;
4. compute the SCRAM-SHA-256 verifier locally, using that iteration count;
5. send **only** the verifier in `CREATE ROLE ... PASSWORD '<verifier>'` —
   PostgreSQL recognizes and stores the literal `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`
   format verbatim, without ever seeing or deriving it from a plaintext
   password (the same mechanism `pg_dump`/`pg_upgrade` already rely on to
   preserve passwords without knowing them);
6. assemble the raw-password `DATABASE_URL` only in process memory;
7. deliver it through the dedicated credential tmpfs path (§16).

A precomputed SCRAM verifier embeds its own iteration count. Reading the
tenant cluster's `scram_iterations` and matching it is a **consistency and
security policy** — keeping newly-provisioned roles aligned with whatever
iteration count the cluster is actually configured for — **not** a
syntactic requirement for PostgreSQL to accept a verifier computed with a
different count. Do not describe this step as required for correctness; it
is required for policy alignment.

The raw password must never appear in:

- SQL statement text (this is the entire reason for the verifier design);
- an HTTP response;
- any durable row (control-plane or otherwise);
- a log line;
- an error message;
- OCI `config.json` or `process.args`;
- an idempotency/fingerprint computation.

It is designed to exist only in Peephole process memory, the credential
tmpfs file (§16), the sandboxed child's own process environment, and
inside the PostgreSQL SCRAM client authentication handshake (a
cryptographic exchange, never a logged SQL statement).

**M11 implementation must integration-test the verifier round trip against
real PostgreSQL 18** — provision a role via a client-computed verifier,
then actually authenticate as that role with the known raw password. The
cryptographic correctness of the computation is a testable detail, not an
open architectural question.

---

## 11. Exact provisioning sequence (authoritative)

```text
1.  durable ownership row -> provisioning

2.  generate raw password + SCRAM verifier
    process-local only

3.  CREATE ROLE pv_<id>
      LOGIN
      PASSWORD '<SCRAM verifier>'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT 3
    -- provisioning role now holds pv_<id> with ADMIN TRUE / SET FALSE / INHERIT FALSE

4.  GRANT pv_<id>
      TO <provisioning_role>
      WITH SET TRUE
    -- does not touch INHERIT; stays FALSE

5.  CREATE DATABASE pv_<id>
      OWNER pv_<id>
      TEMPLATE template0
      ENCODING 'UTF8'
      ALLOW_CONNECTIONS false
    -- permitted by the SET privilege from step 4, without the session
    -- literally being SET ROLE'd yet. Nobody can connect at all yet.

6.  SET ROLE pv_<id>

7.  REVOKE CONNECT, TEMPORARY
      ON DATABASE pv_<id>
      FROM PUBLIC
    -- must run inside the SET ROLE boundary: INHERIT FALSE means holding
    -- SET alone is not enough to exercise the owner's REVOKE privilege

8.  ALTER DATABASE pv_<id>
      ALLOW_CONNECTIONS true
    -- also kept inside the SET ROLE boundary, so this is safe regardless
    -- of exactly which PostgreSQL 18 privilege rule governs this specific
    -- ALTER DATABASE form

9.  RESET ROLE

10. durable row -> provisioned

11. assemble DATABASE_URL process-locally

12. return DatabaseCredentialMaterial
```

This sequence is designed to close the well-known `PUBLIC`-connect race
exactly: the database would be either non-existent or connection-disabled
(`ALLOW_CONNECTIONS false`) for its entire existence through step 7; only
step 8 opens it, by which point `PUBLIC` has already been revoked.
`CREATE DATABASE`'s own inability to run inside a transaction block is
irrelevant here — `ALLOW_CONNECTIONS false`, not a transaction, is what
would close the window.

**Wording precision, locked:** do not describe this sequence as making
`pv_<id>`'s own ability to connect "impossible to revoke" or claim
ownership itself is what grants connect access after step 7. The precise,
correct statement is: **the owner role receives its own normal database
privileges at creation time** (as the `OWNER` of the database), and step 7
revokes only the separate, default grant PostgreSQL extends to `PUBLIC`.
Whether `pv_<id>` can still connect after this exact sequence, with no
additional explicit `GRANT CONNECT ... TO pv_<id>`, is exactly the kind of
claim that must be **proven by a real PostgreSQL 18 integration test**
(§21), not asserted here. **No explicit owner `GRANT CONNECT`/`GRANT
TEMPORARY` is added to this sequence unless that integration test
demonstrates one is actually required.**

---

## 12. Exact normal teardown (authoritative)

```text
1. durable row -> revoking

2. SET ROLE pv_<id>

3. DROP DATABASE pv_<id> WITH (FORCE)

4. RESET ROLE

5. DROP ROLE pv_<id>

6. durable row -> revoked
```

- `DROP DATABASE` requires database ownership; `SET ROLE pv_<id>` gives the
  current session exactly that identity for the duration of step 3.
- `WITH (FORCE)` terminates only sessions the caller has privileges of —
  satisfied by the `SET ROLE` boundary, requiring no `pg_signal_backend`
  grant.
- `RESET ROLE` (step 4) must precede `DROP ROLE` (step 5): PostgreSQL
  cannot drop the role a session is currently `SET ROLE`'d as.
- `DROP ROLE` succeeds via the `ADMIN TRUE` the provisioning role already
  held on `pv_<id>` since creation (step 3 of §11) — no further membership
  is needed for this step, since `pv_<id>` never did anything else in the
  cluster and owns nothing beyond the database just dropped.

**No automatic:**

- `DROP OWNED` / `REASSIGN OWNED` of any kind;
- privilege broadening of any kind;
- "repair" `GRANT`s to fix a missing `SET` membership during cleanup.

**If cleanup fails:** ownership evidence is kept (the durable row is not
deleted, and stays out of `revoked`); the row is marked `revoke_failed`
where the failure is specifically a `DROP ROLE` failure after a successful
`DROP DATABASE`; maintenance reconciliation (§14) retries **only** this
same narrow sequence on later ticks. An unexpected dependency preventing
`DROP ROLE` is an **invariant violation**, never authorization to broaden
cleanup to `DROP OWNED`/`REASSIGN OWNED` — those commands operate against
whatever database the provisioning role happens to be connected to at the
time, and running them reflexively risks touching unrelated objects if
ever invoked against the wrong connection context.

---

## 13. Crash-window table (authoritative)

| State | Durable row | Physical role | Physical DB | Live connection? | Cleanup action | Startup fail-closed? |
|---|---|---|---|---|---|---|
| A. Row only | present (`provisioning`) | absent | absent | no | Mark `revoked` — nothing to remove | No |
| B. Role created; `ADMIN TRUE`/`SET FALSE` automatic only; explicit `SET` grant not yet run | present | present | absent | no | `DROP ROLE` — sufficient; `ADMIN TRUE` alone permits this, no `SET ROLE` needed since no DB exists | No |
| C. Role + explicit `SET TRUE` grant; DB absent | present | present | absent | no | `DROP ROLE` — sufficient, same reasoning as B | No |
| D. Database exists, `ALLOW_CONNECTIONS=false` | present | present | present (disabled) | no (cannot be) | Full teardown (§12, steps 2-5) | No |
| E. `PUBLIC` revoked, database still disabled | present | present | present (disabled) | no | Full teardown | No |
| F. Database enabled, backend not started | present | present | present (enabled) | no | Full teardown | No |
| G. Backend process running | present | present | present | possibly | Full teardown — `FORCE` does real work here | No |
| H. FullStack preview `ready` | present | present | present | yes | Full teardown | No |
| I. Graceful `DELETE` | transitions `revoking` → `revoked` synchronously, in the same request/worker flow | dropped synchronously | dropped synchronously | terminated by `FORCE` if live | N/A — not a crash path | No |
| J. Peephole `MainPID` `SIGKILL` while in any of D-H | durable row **survives** (it lives in `18-main`, not process memory) | present | present, now orphaned | possibly, now orphaned | Startup reaper (§14) runs the identical full teardown, **before** `FullStackPreviewStartupReconciler` terminalizes the durable FullStack parent to `failed`/`ORCHESTRATION_UNAVAILABLE` | Yes, if the reaper itself cannot complete (see critical invariant below) |

**Critical invariant, locked in M11-A4:**

```text
DB exists
+ durable ownership row exists
+ expected SET membership on the recorded role is absent
→ invariant violation
→ fail closed
→ do NOT silently GRANT SET during startup/maintenance reconciliation
```

This state should be structurally unreachable given §11 always grants `SET
TRUE` before anything else touches the role. Observing it anyway indicates
either a bug or external tampering, and is treated with the same severity
as the "database exists without its owning role" unreachable shape in §14
— surfaced loudly for investigation, never silently repaired by expanding
the reaper's own privilege.

Row I (graceful `DELETE`) and row J (`MainPID` `SIGKILL`) are **never
conflated in any test, doc, or acceptance report** — one is synchronous,
attributable, in-request evidence; the other is asynchronous,
reconciliation-driven evidence discovered only at the next startup or
maintenance tick. This is the same discipline M10-C4B's own review already
enforced for the SIGKILL-vs-graceful-stop distinction.

---

## 14. Three-set reconciliation (startup and maintenance reaper)

The DB orphan reaper compares **three independent sets**, never trusting a
name prefix alone:

1. durable ownership rows (`peephole_temporary_databases`, non-terminal
   status) in `18-main`;
2. physical `pv_*` databases in `18-tenant`;
3. physical `pv_*` roles in `18-tenant`.

```text
durable row + no physical resources
  → mark row `revoked` directly (idempotent completion)

durable row + role only, no database
  → bounded cleanup: DROP ROLE only, mark `revoked`

durable row + role + database
  → run the authoritative narrow teardown (§12), mark `revoked`

database exists without its owning role
  → structurally impossible under the locked provisioning order (role is
    always created before the database that names it as OWNER)
  → fail closed: abort / raise a loud alarm, never attempt automatic
    remediation of a shape that contradicts the design's own invariant

pv_*-shaped database or role with NO matching durable row at all
  → audit failure: unowned Peephole-shaped object
  → fail closed, exactly mirroring NetworkOrphanReaper's existing
    "Unowned Peephole-shaped network namespace" handling — never silently
    dropped, never silently ignored

non-pv_*-shaped database or role
  → never touched, under any circumstance
```

**Name prefix alone never authorizes deletion** — only a `pv_`-shaped
object *combined with* a matching durable row does. The teardown body the
reaper runs for the "role + database" case is the *identical* `SET
ROLE`/`RESET ROLE`-bounded sequence from §12, not a bare `DROP`.

**Ordering:** the tenant-DB startup reaper is designed to run in the same
phase as the existing `GVisorOrphanReaper.reapAll()`/`NetworkOrphanReaper.reapAll()`/
`GeneratedSecretOrphanReaper.reapAll()` calls in `services/production/server.ts`
— **before** `FullStackPreviewStartupReconciler.reconcile()`, so that by
the time a durable FullStack parent is terminalized to `failed`, its
database would already be provably gone. A reaper that cannot even reach
the tenant cluster during startup would abort startup entirely (fail
closed), the same posture the existing network reaper already takes today
when it cannot prove a lease's liveness.

Periodic **maintenance** reaping (not `reapAll()`, the bounded `reap()`
variant) may use an age threshold to distinguish "actively provisioning
right now" from "actually stale," mirroring `GeneratedSecretOrphanReaper`'s
existing `maxAgeMs` distinction — `reapAll()` at startup has no such
threshold, since a fresh process has no knowledge of anything an earlier
process instance held.

---

## 15. Credential delivery

**M10's `PreviewGeneratedSecretName` allowlist is not widened.** It remains
exactly:

```text
JWT_SECRET
SESSION_SECRET
COOKIE_SECRET
CSRF_SECRET
```

`DATABASE_URL` is designed to use a structurally separate mechanism — not because the
underlying tmpfs-bind-mount-plus-trusted-bootstrap *pattern* is wrong for
it, but because M10's existing `GENERATED_VALUE_PATTERN`
(`/^[A-Za-z0-9_-]+$/`) would reject a real connection string outright (it
contains `:`, `/`, `@`), and because a database credential's *provisioning*
is an external, failable side effect, unlike M10's pure in-memory secret
generation — a different broker shape entirely (§16 in the earlier design
phases; reflected here only as the delivery-file consequence).

Future host path (not created yet):

```text
/run/peephole/db-credentials/<runtimeId>/database-url
```

Future sandbox path (read-only bind mount, single file — mirroring M10's
own single-file bind-mount pattern exactly):

```text
/run/secrets/database-url
```

Properties:

- a dedicated tmpfs root, entirely separate from M10's own
  `/run/peephole/secrets` root;
- a single fixed file — no generic `NAME=value` parsing of any kind, so
  there is no newline/`=`/env-name injection surface to defend against in
  the first place;
- the file's entire content would be the raw `DATABASE_URL` value, nothing
  else;
- the trusted bootstrap (to be extended) would read this second fixed path
  if present, trim exactly one trailing newline, and set
  `process.env.DATABASE_URL` to its full content verbatim — no parsing
  logic beyond that;
- would be removed on both normal teardown and startup/maintenance
  reconciliation, the same lifecycle discipline M10's own tmpfs secret
  file already has today.

`DATABASE_URL` would be assembled **only** from: the server-generated
`pv_<resource_id>` identifier (used identically as both database name and
role name), the server-generated password, the fixed configured host
(`192.168.253.1`), and the fixed configured port (`5433`). No repository
string, template value, or client input contributes any component of it.

---

## 16. Boot / service ordering (future)

```text
pphdb0 + 192.168.253.1 ready
        ↓
postgresql@18-tenant.service ready
        ↓
Peephole tenant-DB preflight / startup reaper
        ↓
FullStackPreviewStartupReconciler
        ↓
public listeners
```

**Both** a systemd ordering dependency and a Peephole fail-closed preflight
are required — not either alone. This is directly precedented: the
*already-live* production unit file (read during the M11-A3 audit) carries
exactly this two-layer pattern for the control-plane cluster today —
`After=network-online.target postgresql.service` / `Requires=postgresql.service`
at the systemd level, **and** `server.ts`'s own `applyPostgresMigrations()`
connection attempt at process startup, rather than trusting `Requires=`
alone. Extending the unit with `After=postgresql@18-tenant.service` /
`Requires=postgresql@18-tenant.service` would be a minimal, direct
extension of an existing, working pattern — not a new mechanism.

Systemd ordering alone would be insufficient: a unit reaching `active`
does not guarantee the postmaster has finished recovery and is actually
accepting connections at that instant. The tenant-DB startup reaper (§14)
is designed to be Peephole's own real, provable capability check, exactly
analogous to why `applyPostgresMigrations()` still runs against the
control-plane cluster today despite the existing `Requires=` already being
in place.

**If the tenant cluster is required for reconciliation (i.e. any
non-terminal ownership row exists) and is unavailable, Peephole startup is
designed to fail closed** — it would not proceed to open public listeners
with unproven database state.

---

## 17. Capacity gate

Recorded as production evidence from the M11-A3 read-only audit, not an
estimate:

| Fact | Value |
|---|---|
| CPU | 2 vCPU (1 physical core × 2 threads) |
| RAM | ~1.9 GiB total, **no swap configured** |
| Per-sandbox cgroup ceiling | 1 GiB (`core/runner/runnerLimits.ts`, `DEFAULT_SANDBOX_RESOURCE_LIMITS`) |
| Worker concurrency | Static: 1 (configurable 1-16, default 1); backend-v1: hard-coded 1; full-stack orchestration: hard-coded 1 — these are **independent, concurrent** loops |
| Existing code's own documentation | `services/production/config.ts` states the deployment target explicitly: "2 vCPU / 2GB RAM, which a single CPU/memory-quota'd sandbox can already consume most of on its own" |
| Expected tenant-cluster resident footprint (first slice, conservatively tuned: `shared_buffers=32MB`, `max_connections=25`, `CONNECTION LIMIT 3` per role) | Roughly **40-70 MiB**, extrapolated proportionally from the existing `18-main` cluster's measured ~112 MiB RSS at `shared_buffers=128MB` |

**Locked: before M11 production activation/acceptance, either:**

```text
A. host RAM increases to approximately 4 GiB or more   (default recommendation)

or

B. a separately-reviewed aggregate-memory/concurrency design proves
   equivalent safe headroom
```

**This has not happened.** Nothing in this document, or in M11-A/A2/A3/A4,
constitutes that upsize or that separate review — both remain future work.

**This gate does not block:** writing this document; portable
implementation; PostgreSQL-18 integration testing; real-gVisor development
and verification. It blocks only the final production
activation/acceptance milestone, mirroring exactly how M10's own production
activation was gated on its own dedicated real-host verification pass,
separate from the design and implementation phases that preceded it.

---

## 18. Fixture design (future — not committed yet)

Same repository, `The-peephole/peephole-fixture-fullstack` (id
`1371618449`) — a new, separate, dedicated immutable commit, matching the
established M9 (`eae411a...`)/M10 (`e10b081...`) pattern, never a new
repository.

- The backend env template would gain `DATABASE_URL=`.
- `pg` would be added as the backend's only new dependency — no ORM, no
  ambiguity for the admission logic in §2 to resolve.
- Startup would perform one bounded, fixed action against the injected
  database (e.g. `CREATE TABLE IF NOT EXISTS db_check (id int)` plus one
  `SELECT 1`) — never an unbounded migration.
- `GET /api/db-check` must return a **fixed, non-secret** shape only —
  `{ "connected": true }` or `{ "connected": false, "reason": "<generic>" }`
  — no row contents, no connection string, no hostname, no port. Mirrors
  `/api/secret-check`'s SHA-256-digest-only precedent; here there is not
  even a value to digest, a boolean is the whole point.
- Must not require or accept an externally-supplied `DATABASE_URL` — if
  Peephole's injected value is absent, the fixture must fail closed
  (`connected: false`), never silently falling back to any other database.
- Must not require or attempt to reach any database outside the one
  Peephole itself injects.

---

## 19. Test plan (planned — no tests exist yet)

### Portable

- Admission split: `databaseRequirement != null` + `orchestrationKey ==
  null` → `UNSUPPORTED_BACKEND`; the same plan admitted freely through the
  trusted path.
- Exact `pg` + exact `DATABASE_URL` matching; any other
  `DATABASE_DEPENDENCIES` member, any other `database-requirement` name, or
  a mix, stays unsupported.
- `QueuedBackendRuntime.orchestrationKey` propagation from
  `createInternal()`'s `queue.enqueue(...)` call.
- Resource id / database-name / role-name generation: format, uniqueness,
  Postgres-identifier safety, never derived from repository/branch/client
  input.
- SCRAM verifier computation: known-answer test vectors against RFC
  5802/7677.
- No raw password, verifier, or `DATABASE_URL` anywhere in a plan, public
  API shape, durable-store shape, or idempotency fingerprint — a dedicated
  "secret-free" test mirroring M10's exact equivalent.
- Every crash-window transition in §13's table, as an explicit rollback
  sequencing test.
- Three-set reaper classification (§14): every branch of the decision
  table, including both fail-closed branches.
- The invariant-violation case (§13's critical invariant) throws rather
  than silently granting.
- Fixed credential-file grammar (§15): only the server-assembled shape is
  ever written; nothing else validates.
- Teardown ordering: `SET ROLE` → `DROP DATABASE` → `RESET ROLE` → `DROP
  ROLE`, and that `RESET ROLE` always precedes `DROP ROLE`.

### PostgreSQL 18 integration

Against a disposable, real PostgreSQL 18 cluster (the same
`PEEPHOLE_POSTGRES_TEST_URL`-gated, `describe.skip`-when-unset pattern
`tests/postgresIntegration.test.ts` already establishes):

- the provisioning role used by the test is confirmed **not** superuser;
- role creation via §11's exact sequence;
- the explicit `SET TRUE` membership grant, confirmed necessary (i.e. the
  test also confirms the *absence* of that grant blocks the subsequent
  `CREATE DATABASE ... OWNER` step, proving the design's own reasoning);
- `CREATE DATABASE ... OWNER pv_<id>` succeeds;
- the full `ALLOW_CONNECTIONS false` → revoke → enable sequence, with an
  explicit assertion that no connection is possible before the final step;
- **the intended owner role can still connect after the sequence, with no
  additional `GRANT CONNECT`** — this is the specific claim §11 defers to
  this test rather than asserting outright;
- a wrong password is rejected;
- a different `pv_*` role cannot connect to this database (cross-preview
  denial, proven directly);
- where testable, confirm the raw password does not appear in captured SQL
  statement text;
- the client-computed SCRAM verifier round-trip: provision with the
  verifier, authenticate with the known raw password;
- `DROP DATABASE ... WITH (FORCE)` succeeds even with a live connection
  open;
- `DROP ROLE` succeeds after the drop;
- partial-provisioning recovery (role created, database not) — bounded
  `DROP ROLE` only;
- the provisioning role has no privilege over any unrelated role or
  database on the same cluster.

### Real Linux/gVisor

Extending the existing `PEEPHOLE_REAL_GVISOR_TESTS=1`-gated suite pattern:

- the sandbox's added `/32` route exists and is exactly one route;
- `192.168.253.1:5433` is reachable from inside the sandbox;
- the same address on any other port is **not** reachable;
- public internet, cloud metadata, private RFC1918 outside the one allowed
  `/32`, and another job's subnet all remain unreachable (re-running the
  existing negative assertions to prove the new `INPUT`-chain rule did not
  widen anything reachable via `FORWARD`);
- no default route exists in the sandbox's netns;
- no NAT/MASQUERADE rule exists for this path;
- `DATABASE_URL` reaches the sandboxed child (via digest/boolean
  comparison, never the raw value over any wire the test itself controls);
- the raw value is absent from OCI `config.json`/`process.args`;
- the credential tmpfs file is gone after `stop()`;
- the database and role are gone (checked directly against `18-tenant`)
  after `stop()`.

### Production acceptance — prepared runbook, not executed

This is a checklist for a future session to follow. None of it has been
done; `18-tenant` does not exist and this runbook has not been run.

- confirm the capacity prerequisite (§17) is satisfied **first**;
- install and configure `18-tenant` per this design;
- provision a real, dedicated M11 fixture commit (§18);
- create a real `fullstack-v1` preview;
- query the fixture's `/api/db-check` through the routed backend and
  confirm `connected: true`;
- perform normal `DELETE` cleanup, confirmed both at the FullStack-parent
  level and directly against `18-tenant`;
- separately record **independent** graceful-stop evidence and intentional
  `MainPID` `SIGKILL` crash-recovery evidence — never conflated in the same
  report, matching §13's locked discipline exactly;
- restart via systemd;
- observe the tenant-DB startup reaper's behavior;
- observe the durable FullStack parent's fail-closed transition;
- confirm zero DB/role/network/runsc/tmpfs/disk residue, checked directly;
- confirm the unchanged, unmodified `npm run smoke:production:host` still
  passes.

None of this is executed by this document. It is the acceptance runbook
M11-E's production infrastructure activation and acceptance stage will
follow, after M11-C1 through M11-C4's implementation and M11-D's real
Linux/real-gVisor verification are complete.

---

## 20. Open questions carried forward

1. Exact production instance type and whether an in-place resize or a
   replacement instance is the operator's preferred path for §17's RAM
   requirement — an infrastructure/cost decision this document cannot make.
2. Whether a brief `peephole.service`/host restart is acceptable for that
   RAM change, and the maintenance-window decision that implies.
3. `18-tenant`'s exact `shared_buffers`/`max_connections`/`work_mem` tuning
   should be finalized against the real, post-upsize host, not solely the
   proportional estimate in §17.

`192.168.253.1/32:5433` (§7) is **not** an open question — it is a locked
architecture target, found collision-free against every route, address,
and interface observed on the production host during the M11-A3 read-only
audit. What remains is an ordinary deployment-time safety check, not an
unresolved decision: **before M11-E changes networking, re-run
collision/routing validation and abort activation if `192.168.253.1` is no
longer safe** (e.g. the VPC subnet layout or the job-lease pool has since
changed). This is the same kind of pre-flight re-check `ensureProductionPreflight()`
already performs for other host assumptions before production startup
proceeds — not a sign the address itself is still undecided.

Everything else decidable from the existing codebase and the production
facts gathered in M11-A3 has been decided in this document.
