# RstrBot operations

## Upgrading the development preview to 0.2.0

Stop the core and preserve a consistent pre-upgrade database snapshot and a
separately protected copy of `secrets.key`. Replace the four executables and
`web/` together. Startup upgrades schema 1 to schema 2 transactionally; this is
not a reversible binary-only update. To return to a schema-1 release, restore
the pre-upgrade database and matching key into a separate data root. Do not run
an old binary against the upgraded database or run both versions on one data root.

The new account features require an administrator to configure a fixed HTTPS
public origin and exact Passkey RP hostname, Google OAuth client and/or SMTP
service. Local Passkey development uses `http://localhost`, not an IP RP. Once a
Passkey exists, origin and RP changes are rejected; plan domain changes before
registering credentials. See the [authentication guide](AUTHENTICATION.md) for
Google linking, email recovery, multiple Passkeys and replacement behavior.

Native WebAuthn dependencies require OpenSSL development files when building
and compatible OpenSSL shared libraries when running a dynamically linked
distribution. See [README](../README.md) for the build requirements. Exact test
scope and fixed-build receipts are in [v0.2.0 evidence](evidence/v0.2.0/).

### Retained 0.1.2 runtime behavior

Stop the core, retain the protected data root and a separate protected copy of
`secrets.key`, and replace the four executables plus `web/` together. Keep the old
distribution for an explicit rollback. The Linux runtime ZIP is an executable
service distribution, not a signed native desktop installer. See the current
[acceptance record](ACCEPTANCE.md) and [versioned evidence](evidence/v0.2.0/) for
what was actually executed against the candidate being installed.

In 0.1.2, runs, outbound deliveries and schedule claims are reconciled before the
TCP listener is bound and before the periodic scheduler starts. A large history
can therefore make startup take longer; connection refusal while that recovery
is still running is not a successful readiness result. A recovery error aborts
startup instead of accepting new work with partially reconciled intentions.

The recovery and scheduler scans read batches of at most 128 records using a
stable `(created_at, id)` cursor. Each batch also limits stored JSON to 16 MiB,
allowing a single record so the scan can always progress. Decoded objects and
other runtime allocations are additional memory; this is not an RSS guarantee.
The first batch captures an inclusive upper position. Follow `next` even after a
short batch, because the byte limit can be reached before 128 records. This
removes the old 10,000-row recovery failure without loading all history at once.
The scan is not a database snapshot: an insertion behind the cursor during a
periodic pass is handled by the next fresh pass. Multi-core operation remains
outside the verified deployment scope.

Unfinished runs become interrupted. A delivery still marked prepared becomes
`not_sent`; a delivery marked sending becomes `unknown`. In-flight schedules are
disabled and marked `needs_reconciliation`. None of these startup operations
replays a model request or an outbound message. Check the original intention,
usage reservation and downstream receipt before explicitly resuming work.

HTTP delivery now keeps the original login credential as an in-memory lease.
After a worker slot becomes available, and again after the worker handshake but
before `platform.send`, the core rechecks that credential along with membership,
route version/enabled state and private-network policy. Logout, expiration and
password recovery cannot be bypassed by a request that was already queued. An
in-flight request may already have reached its destination: known receipts are
kept, uncertain outcomes stay `unknown`, and the old request key never silently
starts another send.

### Prior 0.1.1 upgrade behavior, retained


Stop the service, preserve the protected data root and its separate encryption
key, then replace the four adjacent executables and `web/` together. No schema
migration is introduced by this patch. Keep the previous distribution for an
explicit rollback; do not overwrite or recreate the data root.

Existing private data remains private through the normal API, and shared
conversation context is now restricted to shared sources. This patch cannot
retract private text that an older version already copied into a shared answer,
event, export or downstream model request. Review such existing shared records
if that earlier preview was used with real private sources.

Changing a model provider/URL or Webhook URL now requires an explicit replacement
or clearing of its saved secret. A workspace administrator cannot move an
instance-approved private-network grant to a new target. Turning the global
`allow_private_network` setting off and restarting also blocks existing resources
that retained a private-network flag; previously saved delivery receipts remain
readable without re-sending. See the HTTP contract for `not_sent` and `unknown`.

Logout cancels active chat runs using that credential. Password changes revoke
all the account's sessions. Scheduled tasks retain their own owner authorization
and continue to recheck membership, instead of inheriting a browser session.
Only their owner can edit or enable them; authorized moderators may delete a
shared task.

## Build and start

The core and reference provider/platform workers are Rust executables. The WebUI
is a static React/TypeScript build served by the same authenticated HTTP service.
No Python, Node.js or .NET runtime is needed to run the built Rust core and bundled
workers. Those runtimes are needed only for development or their own plugins.

Install the versions in `mise.toml`, or use the pinned Rust toolchain and a
Node.js 24 runtime (pinned to 24.22.1). From a clean checkout:

```sh
mise install
npm --prefix web ci
npm --prefix web run build
cargo build --workspace --bins --locked
./target/debug/rstrbot --web-dir web/dist
```

The default listener is `127.0.0.1:8787`. On first launch, the console prints the
location of `bootstrap.token`, not its secret contents. Read this file through
your local terminal and use it in the setup screen within 15 minutes. A restart
generates a new proof while initialization remains incomplete. Setup creates the
first administrator and workspace atomically; another client cannot take over
an initialized instance.

The default data location follows the platform's application-data convention.
Use `--data-dir /absolute/path` for an explicit portable installation. Configuration
is saved in that location and is independent of the launch directory. Unix data
directories are owner-only; credentials and setup files are written with mode
0600. A process lock prevents two cores or maintenance commands from sharing one
data directory concurrently. PostgreSQL alone does not turn this release into a
supported multi-core deployment.

The bundled `diagnostic` provider is an explicitly labeled test fixture. It allows
offline verification of the execution loop and tools. It is not a substitute for
a real AI provider and must not be represented as model-quality validation.

## Database selection and optional Valkey

The setup screen always displays SQLite and PostgreSQL choices. Choosing a different engine does not itself change the connection: test it and select “Use database” before completing initialization. The form blocks initialization while that type change is unapplied. You can also supply a deployment
URL through `RSTRBOT_DATABASE_URL`; do not put real database passwords in shell
history. SQLite defaults to a file beneath the data directory. PostgreSQL uses the
same authorization and resource operations. The runtime currently applies its
initial schema on connection, so the database role needs the corresponding schema
privileges; separate migration/runtime roles and PG RLS are still unverified.

Default SQLite file URLs now encode the complete filesystem path, so Windows
drive letters, separators, spaces, Unicode and URL-special characters retain
their filename meaning. User-supplied valid connection URLs remain unchanged.
This fixes a failure exposed by the initial Windows CI run; it does not itself
establish final Windows runtime, plugin or desktop acceptance.

An existing Windows `config.json` containing the old malformed default URL is
**not automatically rewritten**. Stop the core, preserve the database, config and
`secrets.key`, then explicitly correct `database_url` to the properly encoded URL
of that same existing database, either in the protected config or through
`--database-url` / `RSTRBOT_DATABASE_URL`. Do not delete the database or data root
to regenerate defaults. The [initial CI receipt](evidence/v0.1.2/github-actions-initial.json)
retains the earlier failure; use the final release's later CI record for status.

```sh
RSTRBOT_DATABASE_URL='postgresql://user:password@localhost/rstrbot' \
  ./target/debug/rstrbot --data-dir /srv/rstrbot --web-dir web/dist
```

Valkey is optional. Set `--valkey-url` or `RSTRBOT_VALKEY_URL` when using its
configured integration. Durable permissions, events, runs, schedules and budget
reservations remain in the database. The current implementation writes a disposable presence key with a short TTL,
then checks that it can read that key. Actual status is exposed in setup and readiness
as available or degraded; this is not a general-purpose acceleration layer. `rstrbot check` tests the database and explicitly
reports that it has not tested model-provider connectivity.

## Server exposure

For remote clients, configure an HTTPS reverse proxy and restrict the upstream
port to that proxy. A non-loopback bind requires `--secure-cookie`; this flag
marks cookies Secure and **does not add TLS to the core socket**. A normal setup
keeps RstrBot on loopback and exposes only the proxy's HTTPS listener. Forward the
original Host and Origin consistently so the browser's same-origin write checks
can operate correctly. Never expose an unauthenticated setup proof or a data
directory through the proxy.

Private-network provider access is disabled by default. `--allow-private-network`
is an explicit instance-operator opt-in; individual connection configuration still
needs authorization. It is appropriate for a deliberately configured local model
server, not an automatic fallback after a failed public connection.

## Installing a trusted local plugin package

Build or obtain the executable through your own trusted distribution process.
Review the manifest's capabilities and permission disclosures, then register it:

```sh
./target/debug/rstrbot --data-dir /srv/rstrbot plugin-install \
  --manifest /absolute/path/plugin.json
```

The core must be stopped for local registration. The command validates the
manifest, resolves the executable path, verifies or records its SHA-256 checksum,
and creates a package descriptor. It does not start the program. Restart RstrBot,
then create and enable a workspace instance from Plugins. `--replace` explicitly
replaces a package descriptor after permission review. Package files and workspace
configuration are separate; package replacement does not delete workspace data.

A process boundary provides fault isolation. It does not sandbox hostile code.
This release's local executable packages are trusted operator-installed code.
Untrusted plugins require an independently verified OS sandbox or separate host.
Windows plugin transport/process acceptance is not implied by a successful core
build. See the protocol and SDK documentation for actual supported behavior.

## Backup, controlled migration and restore

Stop the core before local maintenance so the process lock can be acquired:

```sh
./target/debug/rstrbot --data-dir /srv/rstrbot backup \
  --output /protected/backups/rstrbot-db-20261028.json
```

The output must be a new file. It contains a consistent database snapshot,
ownership, run/operation records, budget reservations and text attachments stored in conversation history. Password hashes and
encrypted credential records make it sensitive. Version 2 snapshots include
verified email, Google identity and Passkey public-key records, plus encrypted
authentication settings. Sessions, security challenges, email tokens and mail
rate-limit records are excluded. Version 1 snapshots remain importable and are
upgraded to schema 2; new v2 snapshots are not a downgrade format. Copy
`secrets.key` through a separately protected channel, and separately preserve
external plugin state and attachments. The snapshot explicitly declares that it
does not include that external state; it is not a complete application disaster
recovery archive.

Restore into a **new data directory and empty database**, keeping the source
unchanged:

```sh
./target/debug/rstrbot --data-dir /srv/rstrbot-restored restore \
  --input /protected/backups/rstrbot-db-20261028.json
```

Use `RSTRBOT_DATABASE_URL` with the target PostgreSQL database to transfer SQLite
records to PostgreSQL, or restore a PostgreSQL snapshot into a new SQLite data
directory. Restore checks the schema, manifest, checksum, column types, ownership
and reservation totals before committing. It never overwrites an initialized
target. Restore the original `secrets.key` with restricted permissions before
starting the recovered core; a missing key causes an explicit error instead of
silently generating a replacement that cannot decrypt old credentials.

The restored database starts in recovery mode. Review external receipts,
unfinished runs and plugin/channel identities before leaving recovery mode through
the instance-administrator recovery action. Unknown external outcomes stay unknown
and unknown costs stay reserved. Do not turn these into new tasks merely because
a receipt is missing. A successful database migration alone does not prove a safe
production cutover of external channels.

## Password recovery

The local operating-system owner can recover an account without exposing an
unauthenticated web recovery endpoint. Stop the core, set
`RSTRBOT_RECOVERY_PASSWORD` through a protected local environment, and run:

```sh
./target/debug/rstrbot --data-dir /srv/rstrbot recover-password --username alice
```

The password is never printed. Every session for the account is revoked and a
recovery timestamp is recorded. Clear the environment variable after use. The
host owner/root can read local data and secrets; application roles cannot prevent
that technical access.

## Verification and packaging

`scripts/check.sh` runs formatting, strict Clippy, tests, docs, frontend checks,
SDK checks, MCP delivery checks and the black-box integration suite. Missing SDK
runtimes are reported separately; CI's SDK job uses `--require-all` to fail when
any of the four SDKs cannot actually run. Set `RSTRBOT_TEST_DATABASE_URL` to a
disposable PG database for the same storage and HTTP tests against PostgreSQL.

```sh
cargo build --release --workspace --bins --locked
python3 scripts/package.py --profile release
```

The packaging script requires a clean committed source tree and refuses to overwrite an existing package. Use `--binary-dir` when Cargo outputs into a separate target directory. Packages include the core, three bundled workers, built WebUI, release/operations docs, versioned evidence and a file hash manifest bound to the source commit. They never include the data directory or master key. A
package is an executable distribution, not a verified signed desktop installer.
The CI workflow distinguishes Linux runtime tests, SQLite/PG with Valkey on/off,
SDK process tests, and native Windows/macOS core checks. A workflow definition is
not an executed CI receipt; only report success after a real run completes.

The unified `scripts/verify_integration.py` runner defines 26 real-service
HTTP/recovery groups, including both database backends for delivery-session
revocation and SMTP/identity behavior. `scripts/check.sh --full-matrix` requires
disposable PostgreSQL and Valkey services. The two browser harnesses cover the
workspace and account-security flows, including Chromium WebAuthn virtual
authenticators. Current receipts belong in `docs/evidence/v0.2.0/`; earlier
evidence is historical. See the receipts for actual executed counts and limits.
The plan and CI wiring are not passing results. Reused passing matrix rows must
match the candidate binaries, runner, harness files and service endpoints; a
changed candidate requires new evidence.

## Upgrade and shutdown

Take a consistent database backup and protected key copy first. Stop the old core,
preserve its binaries and all user data, replace the binaries/WebUI, then start the
new version and inspect its health and interrupted-run records. Version 0.2.0
uses schema 2 and upgrades schema 1 on startup. A rollback requires a protected
pre-upgrade snapshot and its key; replacing only the executable does not undo
the migration. Do not run two release versions against one data directory.

Ctrl-C and Unix SIGTERM request shutdown, cancel owned active runs, and wait for
bounded cleanup. Already-sent external operations retain their actual receipt or
unknown state. Process and native desktop behavior on each OS must be verified
separately before that platform is advertised as fully supported.
