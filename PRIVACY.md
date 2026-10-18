# Peephole Privacy Policy

Effective date: October 18, 2026

Peephole is a Chrome extension that analyzes public GitHub repositories and,
when requested, builds supported static frontends in an isolated Peephole
preview service so that you can inspect them before cloning. Newer versions
can also run a narrow, supported frontend-plus-backend combination as a
full-stack preview, described below.

This policy covers the data handled by the published Peephole extension
versions and the Peephole preview service. Some features described below exist
only in newer versions. Depending on the installed version and the feature you
use, Peephole may perform only some of the operations described here. Peephole
does not use analytics, advertising, or tracking services, and it does not sell
user data.

## Data Peephole accesses

When you visit a GitHub repository page, the extension reads the page URL and a
small amount of visible repository-header metadata to identify the repository.
It does not read unrelated pages or your general browser history.

For public-repository analysis, the extension requests public information from
GitHub, including:

- the repository owner, name, numeric repository ID, default branch, commit
  SHA, public/private flag, and declared homepage;
- names, paths, types, and sizes of selected files in the repository root;
- bounded contents of selected public project files, such as `package.json`,
  `README.md`, lockfile/configuration indicators, Vite configuration, and
  example environment-variable templates; and
- depending on the installed version, the additional public repository data
  described below.

**Branch discovery.** Newer versions may list up to 100 of the repository's
public branch names, together with each branch's current commit, through the
GitHub API so that you can choose a branch. A selected branch is always
resolved to one exact commit before Peephole analyzes or previews it. Branch
names are public repository metadata. Peephole does not treat them as
credentials and does not store them persistently.

**Repository structure.** In newer versions, analysis is not limited to the
repository root. To find candidate project directories, Peephole may read a
bounded number of public directory listings (names, paths, types, and sizes)
and a bounded set of selected public files under those candidate paths, such as
nested `package.json` files, lockfile indicators, and example
environment-variable templates. The number of listings and files, and the
total bytes read, are capped. From example environment-variable templates,
Peephole uses only the variable _names_. It does not keep or display template
values, and it never reads real `.env` files.

**Deployment evidence.** Newer versions may query the repository's public
GitHub Deployments, and a bounded number of their status records, to show
confirmed deployment evidence. Peephole keeps only bounded fields: the
deployment ID, ref, commit, environment name and production flag, status
state, environment URL, and timestamps. A deployment URL is shown to you as a
link. Peephole does not fetch, crawl, or embed it.

**GitHub theme.** To match the Side Panel to the GitHub page, newer versions
read a bounded snapshot of the page's computed GitHub/Primer theme colors: the
light or dark scheme plus a fixed set of color values. This snapshot is local
user-interface state, not a credential or analytics. It is not sent to the
Peephole service.

Peephole rejects private repositories. It does not use your GitHub OAuth
credential to fetch repository contents.

## GitHub authentication

Building a preview requires you to choose **Connect GitHub**. Peephole uses a
GitHub App OAuth flow to verify your identity. During that flow:

- the extension and Peephole server handle a short-lived authorization code,
  signed state, and PKCE verifier;
- the Peephole server exchanges the code with GitHub and temporarily handles
  the resulting GitHub OAuth access token;
- the server sends that token to GitHub's `/user` API only to obtain your
  numeric GitHub user ID; and
- Peephole uses the resulting identifier in the form `github:<numeric-id>` as
  the requester identity for preview jobs and quotas.

The current server implementation does not persist the GitHub OAuth access
token. The token is not returned to or stored by the extension.

After identity verification, the server issues a signed Peephole session that
normally expires after 30 minutes. The extension stores that session token and
its expiry in `browser.storage.session`, not persistent local storage. Signing
out removes it. Peephole also removes the legacy personal-access-token storage
key used by older builds.

## Preview and build data

When you request a preview, the extension sends the public repository ID,
owner, name, exact commit SHA, and preview contract version to the Peephole
API. In newer versions, if you explicitly select a supported frontend target
within the repository, the request also includes that target's repository
path (its `sourceRoot`). The extension never sends a build command or plan.
The server independently validates the requested target and resolves the
build plan from the referenced public repository before creating the job. It
accepts only a bounded, validated repository-relative path, not an arbitrary
filesystem path or command. The worker then
downloads the selected public commit and runs the supported build inside a
resource-limited gVisor sandbox.

Preview processing creates job and build records that can include:

- the requester identifier described above;
- repository and commit identifiers;
- the build plan, cache key and cache result;
- job status, timestamps, expiry, idempotency metadata, attempt/lease metadata,
  and error code or message; and
- artifact identifiers and time-limited artifact URLs.

The service also uses the connecting IP address for abuse prevention and
per-IP quotas. The PostgreSQL quota table stores a SHA-256 hash of the IP-based
scope rather than the plain IP address. Network infrastructure may still
process IP addresses as part of delivering requests.

Successful builds produce static HTML, JavaScript, CSS, images, and other
public-repository build output. Artifacts are made available through a
time-limited HTTPS URL. Anyone who receives a valid artifact URL may be able to
view it until it expires, so do not share the URL unnecessarily.

## Full-stack preview

Newer versions may offer a full-stack preview for a narrow supported shape: a
Vite + React frontend and an Express backend using npm in the same public
repository. It runs only when you choose **Run full-stack preview**, and it
requires the same **Connect GitHub** session as a static preview.

**What the extension sends.** The request contains the public repository ID,
owner, name, exact commit SHA, the selected frontend and backend repository
paths, and, if you entered any, the configuration name/value pairs described
below. As for static previews, the extension never sends a command or plan;
the server re-derives the plan from the public repository at that commit.

**How it runs.** The server builds the frontend and starts the backend
process in a separate gVisor sandbox. The backend cannot open outbound
network connections, except to its own temporary database when one is
provided. Requests to `/api` on the preview's HTTPS address are forwarded to
that backend. The full-stack preview record stores the requester identifier,
repository, commit, target paths, status, preview URL, timing, idempotency,
and error information, like a static preview job.

**Who can reach it.** Like a static artifact, the full-stack preview address
is not limited to you. Anyone who has a valid preview URL can load the
frontend and call the backend's `/api` routes until the preview stops or
expires. The backend is the repository's own code, so what it returns is
controlled by that code.

**Server-generated values.** For a backend that declares them, the server may
generate random values for exactly four names (`JWT_SECRET`,
`SESSION_SECRET`, `COOKIE_SECRET`, `CSRF_SECRET`) and give them to that
backend process. They are created by Peephole, not taken from you, and are
not shown to you.

**Temporary PostgreSQL database.** If the backend declares a PostgreSQL `pg`
dependency and `DATABASE_URL`, the server creates one temporary database and
database user for that preview on the Peephole host and gives the connection
details only to that backend process. You never enter database credentials.
Anything the backend, or a visitor using the preview, stores in that database
belongs to that preview. Stopping the preview, expiry, or failure drops the
database and its user. After a server crash, leftover temporary databases are
removed during startup before the service accepts requests.

### Configuration values you enter

When a backend declares environment-variable names in a public
`.env.example`-style template, newer versions may show text fields for some of
those names so that you can supply **non-sensitive** configuration, such as a
display message or a feature mode. Peephole accepts input only for names that
do not look like secrets, credentials, database settings, network addresses,
or browser-public build variables. Names such as API keys, passwords, tokens,
and URLs are never given an input field. Each value is limited to 1,024 bytes
and all values together to 6,144 bytes.

These values are **not kept confidential from the preview**:

- they are given to the repository's own backend code, which can read them
  and may return them to anyone who opens the preview URL;
- before you can run the preview, the Side Panel asks you to confirm that you
  understand this; and
- Peephole cannot tell whether text you type into an allowed field is a
  secret. Do not enter API keys, passwords, tokens, or personal information.

How the current implementation handles them:

- **In the browser**, values stay in the Side Panel page's memory while you
  type. They are not written to extension storage. They are cleared when the
  server accepts the preview, and when you change the repository, commit, or
  selected target.
- **In transit**, they are sent over HTTPS in the full-stack preview request.
- **On the server**, they are held in the Peephole service's process memory
  until the backend starts. They are not written to Peephole's database, job
  queue, or idempotency record. When the backend starts, they are written to a
  memory-backed (tmpfs) file and passed to that backend process only. The
  file is removed when the backend stops, and leftover files are removed by
  periodic and startup cleanup.
- **Unused values** are discarded when the preview is cancelled or fails, and
  otherwise expire after the provisioning period. A server restart before the
  backend starts discards them; the preview then fails and asks you to enter
  them again.
- **Logs.** Peephole's code does not write these values to its application
  logs or error messages; errors name the variable, not its value. Peephole
  does not record the backend process's own output.

These describe the current implementation; they are not a guarantee that a
value can never be exposed. In particular, the repository's code, anyone with
the preview URL, and your own browser profile (including other extensions or
developer tools with access to the page) may be able to see what you enter.

## Local and server-side storage

The extension keeps repository analysis, branch, deployment, and metadata
caches in the extension background process's memory. It does not persist those
caches. The only authentication credential stored by the extension is the
short-lived Peephole session in `browser.storage.session`. Newer versions also
store the GitHub theme snapshot described above in `browser.storage.session`,
keyed by browser tab. That snapshot is user-interface state, not a credential,
and the browser clears session storage when the browser session ends.
Versions with full-stack preview also keep, per browser tab, a snapshot of an
accepted full-stack preview in `browser.storage.session`: the analysis of the
selected public repository target and the preview's ID, target paths, status,
URL, error, and timestamps. This lets you stop or reopen the preview after the
panel reloads. It does not include configuration values, the request, or the
Peephole session.

The production service stores preview job, full-stack preview, queue, cache,
quota, and artifact authorization metadata in PostgreSQL. It stores generated static artifacts on
the production host. Temporary source archives, workspaces, containers, and
network resources are job resources and are cleaned up after execution, with
ownership-aware recovery for interrupted jobs.

## Retention

The implementation provides the following operational expiration boundaries:

- signed OAuth state normally expires after 10 minutes;
- Peephole access sessions normally expire after 30 minutes;
- active preview jobs initially have a 15-minute execution expiry; and
- full-stack previews are time-limited; stopping or expiry ends the backend
  and removes its temporary database, configuration file, and sandbox
  resources;
- ready preview artifacts and their artifact authorization are normally valid for up to
  60 minutes. Expired artifact files and authorization metadata are processed
  by periodic maintenance; unsigned orphan artifact directories use a two-hour
  cleanup grace period.

Expiration controls access and job state, but it is not the same as deletion of
every database row. The current implementation does not establish an automatic
deletion schedule for all historical job, cache, quota, and cancelled queue
records. Those records may remain until operational deletion. Server journal,
reverse-proxy access-log, backup, and infrastructure-log retention is also not
defined by the application repository and depends on production operations.
We will update this policy when a documented deletion schedule is established.

## Data sharing and service providers

Peephole uses data only to provide, secure, and operate repository analysis and
preview features. Data may be processed by:

- **GitHub**, for OAuth identity verification, public repository API requests,
  and downloading a public commit archive;
- **package registries and package hosts referenced by the public project**,
  when the isolated install step downloads dependencies; and
- **hosting and network infrastructure providers**, currently including AWS,
  to operate the Peephole API, database, worker, and artifact delivery.

Repository-controlled install scripts run without extension privileges in an
isolated sandbox. They can access the public repository files and bounded
public-Internet egress during installation, so a repository's own script may
contact an external public service. Peephole blocks sandbox access to host,
private, link-local, metadata, and other sandbox networks, but it does not
currently operate an authenticated package proxy.

Peephole does not transfer data to advertising platforms or data brokers and
does not use it for personalized advertising, lending, or credit decisions.
Humans do not read user data except with specific user consent for support,
when necessary for security or abuse investigation, when required by law, or
when data has been aggregated and anonymized for permitted internal operations.

Peephole's use and transfer of information received from Google APIs adheres to
the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data),
including the Limited Use requirements.

## Security

The extension communicates with GitHub and the production Peephole service over
HTTPS. OAuth uses signed, expiring state and PKCE. The production build runs
untrusted repository code in a gVisor sandbox with network, memory, time, and
disk controls. Preview artifacts are served from a separate origin and are not
given extension privileges.

No system can guarantee absolute security. Do not use Peephole with a
repository that contains confidential information; Peephole is designed only
for public repositories.

## Your choices

You can use public repository analysis without connecting a GitHub identity.
You must explicitly connect GitHub and request a build before Peephole creates
a preview job. You can disconnect in the extension to remove the local
Peephole session, or uninstall the extension to remove its browser storage.
Disconnecting or uninstalling does not immediately delete an already-created
server job or artifact; its normal expiry still applies.

To ask a privacy question or request deletion of data that can be identified
and safely verified, open an issue at
[github.com/The-peephole/peephole/issues](https://github.com/The-peephole/peephole/issues).
Do not include credentials, session tokens, private information, or database
connection details in a public issue. We may need a private verification method
before acting on a deletion request.

## Children's data

Peephole is a developer tool and is not directed to children under 13. We do
not knowingly collect children's personal information.

## Changes to this policy

We may update this policy when Peephole's behavior or operational practices
change. Material changes will be published in this repository with a revised
effective date.
