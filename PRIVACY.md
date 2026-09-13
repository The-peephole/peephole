# Peephole Privacy Policy

Effective date: September 13, 2026

Peephole is a Chrome extension that analyzes public GitHub repositories and,
when requested, builds supported static frontends in an isolated Peephole
preview service so that you can inspect them before cloning.

This policy describes the data handled by Peephole v0.1. Peephole does not use
analytics, advertising, or tracking services, and it does not sell user data.

## Data Peephole accesses

When you visit a GitHub repository page, the extension reads the page URL and a
small amount of visible repository-header metadata to identify the repository.
It does not read unrelated pages or your general browser history.

For public-repository analysis, the extension requests public information from
GitHub, including:

- the repository owner, name, numeric repository ID, default branch, commit
  SHA, public/private flag, and declared homepage;
- names, paths, types, and sizes of selected files in the repository root; and
- bounded contents of selected public project files, such as `package.json`,
  `README.md`, lockfile/configuration indicators, Vite configuration, and
  example environment-variable templates.

Peephole v0.1 rejects private repositories. It does not use your GitHub OAuth
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
API. The server independently resolves and validates the build plan from the
referenced public repository before creating the job. The worker then
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

## Local and server-side storage

The extension keeps repository analysis and metadata caches in the extension
background process's memory. It does not persist those caches. The only current
authentication credential stored by the extension is the short-lived Peephole
session in `browser.storage.session`.

The production service stores preview job, queue, cache, quota, and artifact
authorization metadata in PostgreSQL. It stores generated static artifacts on
the production host. Temporary source archives, workspaces, containers, and
network resources are job resources and are cleaned up after execution, with
ownership-aware recovery for interrupted jobs.

## Retention

The implementation provides the following operational expiration boundaries:

- signed OAuth state normally expires after 10 minutes;
- Peephole access sessions normally expire after 30 minutes;
- active preview jobs initially have a 15-minute execution expiry; and
- ready preview artifacts and their signed access are normally valid for up to
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
isolated sandbox. They can access the public repository files and approved
public-Internet egress during installation, so a repository's own script may
contact an external public service. Peephole blocks sandbox access to host,
private, link-local, metadata, and other sandbox networks, but it does not
operate an authenticated package proxy in v0.1.

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
repository that contains confidential information; v0.1 is designed only for
public repositories.

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
