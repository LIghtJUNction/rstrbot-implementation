# RstrBot plugin protocol 1.0

This document describes executable code in `crates/rstrbot-plugin` and `sdk/`.
It is not a claim of old-plugin, OpenCode, Pi, Windows or macOS acceptance.

## 1. Package, instance, invocation

A package identifies an installed executable and its version/checksum. An
instance identifies its workspace configuration. An invocation starts a fresh
process for one request and stops its process group afterward. The core retains
authorization, durable history, budget reservations and operation receipts.
The worker does not receive a database connection or a mutable core object.

`Manifest` contains `id`, `version`, absolute `executable`, `args`, declared
`capabilities`, permission disclosures, optional `sha256`, and `timeouts`.
Supported capability domains are `model`, `tools`, `platform`, `events`, `tasks`,
`knowledge`, and `runtime`. A declaration alone never grants core permissions.
Installation is a host administrator operation. Workspace administrators must
not obtain arbitrary executable installation through workspace settings.

Workers are **trusted native programs**. Separate processes and working
directories limit accidental coupling; they do not stop a malicious program
running under the same OS account from reading that account's files. This
release does not advertise an untrusted-code sandbox. Unix workers are launched
with a cleared environment, private working directory, private Unix socket,
fresh nonce and trusted context. Only PATH and the three protocol variables are
inherited. Provider credentials are passed only to the selected provider call,
never to an ordinary tool invocation.

## 2. Build and examples

From the repository root:

```sh
cargo build -p rstrbot-plugin --bins
python3 tests/plugin_conformance.py --sdk rust
python3 tests/plugin_conformance.py --sdk python
cd sdk/typescript
npm ci --ignore-scripts
npm run build
cd ../..
python3 tests/plugin_conformance.py --sdk typescript
dotnet build sdk/csharp/EchoPlugin/EchoPlugin.csproj
python3 tests/plugin_conformance.py --sdk csharp
```

Only run the C# step with the .NET 10 SDK.
An absent runtime is reported as `not_executed`; it is never counted as a pass.
The shared harness is deliberately narrower than full SDK feature acceptance:
it exercises context binding, discovery, text/Unicode framing, progress events,
invalid parameters, unknown methods and an invalid initialization credential.
Rust integration tests additionally cover real process cancellation, deadlines,
checksums and sparse streamed tool calls against a local mock HTTP provider.

Four SDK entry points:

| Language | Source | Runtime and start |
| --- | --- | --- |
| Rust | `rstrbot_plugin::sdk` | Compile a binary; see `rstrbot-diagnostic` |
| Python | `sdk/python/rstrbot_sdk` | Python 3.11+, `await serve(Plugin(capabilities, handler))` |
| TypeScript | `sdk/typescript/src/index.ts` | Project toolchain Node 24.22.1, `await serve(capabilities, handler)` |
| C# | `sdk/csharp/RstrBot.Plugin` | .NET 10, `PluginServer.ServeAsync(...)` |

Python installs can use `uv venv /absolute/instance/venv` followed by
`uv pip install --python /absolute/instance/venv/bin/python /path/to/pinned.whl`.
Create a separate environment per plugin instance if dependencies conflict.
The SDK's `rstrbot-python-loader --list` reads `rstrbot.plugins` entry-point
metadata without importing modules. `--entry-point NAME` loads exactly one
matching entry point, which must export a `rstrbot_sdk.Plugin` value. Ambiguous
names are rejected. Dependency downloading and source provenance must be
approved by the installer; the running core does not silently install Python.

## 3. Transport and framing

On Unix the host creates a private directory (0700) and Unix socket (0600).
It verifies the peer UID and, when the platform exposes it, the spawned PID.
The worker receives:

* `RSTRBOT_SOCKET`: the socket path;
* `RSTRBOT_TOKEN`: a random invocation credential;
* `RSTRBOT_CONTEXT`: `{workspace_id, instance_id, generation}`.

Use a short runtime directory: the full socket path must be under 104 bytes.
No plugin port is exposed over TCP. The host's Windows worker transport returns
`unsupported_platform` in this version. Named-pipe ACLs and Windows Job Objects
are still required before advertising native Windows worker acceptance.

Wire format is one UTF-8 JSON-RPC 2.0 object per newline. A frame is at most
1 MiB. The core caps request parameters at 512 KiB. JSON strings may contain
escaped newlines; raw multiline objects and batch requests are unsupported.
Host request IDs are strings. A connection contains initialization, then one
invocation, zero or more progress notifications and exactly one terminal reply.
The host allows eight running workers and a ten-second queue wait. This is a
global bound; workspace fairness is the scheduler's responsibility.

## 4. Initialization and capability negotiation

The host sends `initialize` with `protocol_version: "1.0"`, the nonce and trusted
context. The worker checks all three and replies with protocol version,
capability domains, workspace ID, instance ID and generation. Any mismatch is a
protocol error. A worker returning more capabilities does not enlarge the
installed manifest. The host checks both the manifest and handshake before
calling a method. There are no worker-initiated core-admin RPC methods.

Initialization has separate connection and handshake timeouts (default five
seconds each). An invocation has an overall timeout (default 120 seconds,
maximum 300 seconds). Configuration can be retried unchanged after a corrected
environment failure. The launcher never automatically replays operations.

In core 0.1.2, `PluginHost::call_authorized` additionally accepts a core-owned
authorization callback. It runs after obtaining the global worker slot and again
after successful initialization, before the business RPC is written. Each check
has a ten-second timeout. The callback is not supplied by the worker, runs
without a shared application mutex or open application transaction, and does
not change the wire protocol version. A successful manifest/nonce handshake is
not a replacement for current user authority. The general `call` wrapper does
not add a business authorization policy by itself; callers remain responsible
for choosing and enforcing the appropriate checks.

## 5. Request, events, cancellation, final result

A request is `{jsonrpc:"2.0", id, method, params}`. The terminal response contains
the same `id` and exactly one of `result` or `error`. Errors contain bounded
`code` and `message`; provider implementations omit headers, credentials, URL
paths and remote response bodies from errors.

Allowed notifications are `model.delta`, `tool.progress`, `platform.progress`
and `task.progress`. Their `params.request_id` must match the active invocation.
The host rejects unsolicited requests, unknown notification methods and stale
request IDs. The event channel is bounded. A slow consumer aborts with
`slow_consumer` instead of silently dropping data or growing memory indefinitely.

Cancellation is exposed by each SDK's cancellation token/event/signal. The host
can send `cancel` with `request_id`, and always reclaims the process group after
the call. Cancelling the host future also has a process-group kill guard. On
Unix, termination is followed by a short grace interval and group SIGKILL, with
the direct child reaped. A worker that deliberately escapes its process group
is outside the trusted-worker guarantee and needs OS isolation.

Cancellation cannot undo an HTTP request already accepted by a remote service.
After a cancelled or timed-out write, the core must retain the operation as
in-flight/unknown and reconcile it. It must not infer “nothing happened.”

## 6. Model providers

The `rstrbot-openai` executable implements an OpenAI-compatible HTTP provider;
the core contains no provider wire adapter. Methods are `model.list`,
`model.test` and `model.generate`. Common parameters are `base_url`, optional
`api_key`, `model` where applicable, and an administrator-approved
`allow_private_network` flag. HTTPS and public destinations are the default.
The provider resolves the host once, rejects private/reserved results, pins the
approved addresses, disables redirects and disables inherited proxy settings.
The explicit private-network option enables local model endpoints, including
HTTP. It must be controlled by instance administration, not a model or member.

Generation additionally takes OpenAI-format `messages`, optional `tools`,
`tool_choice`, `max_tokens`, `temperature` and `stream`. Responses contain:

```json
{
  "message": {"role":"assistant", "content":"...", "tool_calls":[]},
  "finish_reason":"stop",
  "usage":null
}
```

Only include `tool_calls` when present. Missing usage is `null`, not zero. The
provider preserves sparse streamed tool-call indices, IDs, names and argument
fragments. Original stream chunks are retained in `provider_state.raw_chunks`; unknown
fields are not assigned an invented merge rule. The assistant message preserves
recognized fields and the latest value of opaque fields. Incompatible providers
are not assigned fabricated signatures.
The SSE parser uses the maintained `eventsource-stream` crate. JSON and total
stream input are bounded at one third of the 1 MiB frame limit; incomplete final markers are failures.
No network request is retried automatically. `model.test` really calls the
configured model and may incur usage; `model.list` only checks discovery.

`rstrbot-diagnostic` is explicitly a deterministic fixture, **not an AI model**.
It labels every answer accordingly and leaves usage unknown. Send
`/diagnostic/tool hello` with an allowed tool to test one tool/continuation
round, or `/diagnostic/wait` to exercise cancellation. Fixture success is not
evidence of connectivity to a paid or local external model.

## 7. Tools, hooks and data

The sample `tools.list` response describes `echo`, its input schema and
`effect: "read_only"`. `tools.call` accepts `{name, arguments}` and returns
content. The echo tool does not read files, access the network or write state.
Other tools must declare whether they are read-only, idempotent writes or
non-replayable writes. The core, not the worker, binds any confirmation to the
operation and parameters and validates resource authority before execution.

The SDK can carry typed event, task and configuration methods, but it does not
magically implement every hook in the blueprint. Public persistent-plugin-data,
HTTP-route registration, durable event subscriptions and all legacy hook maps
remain separate features whose acceptance must be recorded individually. A
worker may not infer authority from a supplied workspace string or API key.

## 8. Platform adapter and standalone MCP

The `rstrbot-webhook` executable implements one real outgoing text transport.
`platform.capabilities` reports sending support, no receiving support, HTTP
acceptance receipts and no remote deduplication guarantee. `platform.send`
accepts `{url, token?, text, operation_id, allow_private_network?}`. The core
must derive destination and credential from a persisted authorized route.

For the core HTTP send operation, the original login credential stays in the
core as a lease; only the route's provider token is passed to the selected
Webhook worker. Core authorization rechecks that login, current membership,
route version/enabled state and private-network policy after queueing and after
handshake. The running call also has an authority monitor. Logging out or
changing a password does not permit a queued worker to continue merely because
the user still belongs to the workspace. The standalone MCP service below has
its own operator-configured credential boundary and does not acquire this
browser-session lease.

The adapter sends JSON `{text, operation_id}` with an `Idempotency-Key` header.
It sends exactly once: a 2xx response is `accepted`, another HTTP status is
`rejected`, and a network failure without a reliable receipt is `unknown`.
HTTP acceptance does not prove that a person has read a message, and sending an
idempotency header does not prove that the remote service honors it.
Core cancellation keeps an already known result where available; an in-flight
operation without a reliable receipt remains `unknown`. At core startup,
prepared and sending intentions are reconciled before the listener starts, using
bounded stable-cursor pages; no recovered intention is automatically dispatched
again. These core rules do not promise that a remote server can revoke or dedupe
a request it already received.

The same adapter can run without the full core as `rstrbot-webhook --mcp-stdio`.
Set `RSTRBOT_WEBHOOK_URL`, an absolute private `RSTRBOT_WEBHOOK_STATE` directory,
optional `RSTRBOT_WEBHOOK_TOKEN`, and optional `RSTRBOT_ALLOW_PRIVATE_NETWORK=1`.
Its MCP `send_message` tool accepts only `text` and `operation_id`; changing
destination, credential or workspace through tool arguments is rejected.
The operator-provided environment is this stdio service's credential boundary.
No public MCP HTTP endpoint or unrelated core state is started.

The standalone adapter durably creates a hashed intent record before sending.
Repeated IDs with identical parameters return the existing receipt; changed
parameters are rejected. Pending/unknown records are not replayed. A successful
send whose receipt cannot be saved returns the real delivery status plus
`persistence: "failed"` and `reconciliation_required: true`. The state directory
must be included in that service's independent backup. Review unknown intents
against destination logs before any manual recovery. There is no automatic
record expiry that could silently make old IDs replayable.

## 9. Installation, configuration and version changes

Package installation, workspace configuration and successful invocation are
different states. A valid manifest or saved credential does not prove a running
provider. Keep the old manifest/configuration until the replacement passes its
handshake and capability checks. New capability requests require a fresh
authorization decision. Disabling an instance cancels its active call tokens
and prevents new calls through core authorization; the host itself is stateless
between invocations.

Executable checksums are checked before launch when configured. Protection of
the executable and its parent directory is still a host administrator duty;
the checksum check does not claim to solve hostile same-account file replacement.
Transient invocation directories are removed after process cleanup. They are
not a persistent plugin data directory and must not be used as one.

## 10. Compatibility and limits

No current claim is made for unmodified legacy plugins, old HTTP routes,
OpenCode plugins or Pi plugins. Their blueprint identifiers and acceptance
cases remain in the project traceability documents. Importing an entry point
or completing a handshake is not “full compatibility.” Named-pipe transport,
native Windows/macOS cleanup acceptance, system sandboxing, provider-specific
OAuth refresh and live third-party model/platform tests require separate proof.

The C# SDK can be built and tested with the same fixture vectors; until that
command actually runs, its status is **implemented, not executed**. Platform
and provider mock tests establish protocol behavior only, not real service
credentials or network availability.

## 11. Error codes and diagnostics

Host error categories: `invalid_manifest`, `checksum_mismatch`,
`capability_denied`, `plugin_start_failed`, `plugin_timeout`, `cancelled`,
`protocol_error`, `slow_consumer`, `plugin_error`, `unsupported_platform`, and
`plugin_io_error`. Worker errors use JSON-RPC `-32601` for an unknown method,
`-32602` for invalid parameters, `-32603` for an internal handler failure,
`-32001` for rejected initialization and `-32800` for cancellation.

Stderr is suppressed by the host to avoid accidental credential leakage.
Provider errors intentionally contain status/category, not a raw remote body.
Development may run a trusted example directly through the conformance harness
to diagnose its own process. Production diagnostics must remain workspace scoped.

## 12. Versioning and evidence

Protocol 1.0 requires exact negotiation. Additive optional capabilities do not
grant authority automatically. A breaking change must publish a new protocol
version and explicit migration notes before adoption. Example versions, crate
versions, TypeScript lockfile and test vectors are committed together.

Implementation references:

* [Tokio process lifecycle](https://docs.rs/tokio/latest/tokio/process/index.html)
* [Tokio process groups](https://docs.rs/tokio/latest/tokio/process/struct.Command.html#method.process_group)
* [Python entry-point metadata](https://packaging.python.org/en/latest/specifications/entry-points/)
* [JSON-RPC 2.0](https://www.jsonrpc.org/specification)

The release verification report records the executed commands and environments;
it, rather than this design description, is the source for pass/fail claims.

## Optional provider rejection codes

A model worker that has actually received upstream HTTP 401, 403 or 429 may report JSON-RPC error codes `-32041`, `-32043` and `-32029` respectively. Use fixed, non-sensitive messages and never include the upstream response body. Older hosts may treat these as generic worker errors; unknown codes remain generic. An interrupted request is not proof of rejection. The Rust worker has local process/HTTP coverage; other SDK runtime vectors require separate verification.

The core discovers enabled, authorized plugin instances through a workspace- and user-scoped cursor; interactive and scheduled runs use the same discovery path. A plugin may declare at most 32 tools and a run may expose at most 64 eligible read-only tools. A larger list, invalid list, missing enabled package, or scan beyond 10,000 visible instances stops the run with a structured catalog error before model generation or business tool calls. Discovery itself invokes `tools.list`. Limits and discovery never authorize writes or override current membership and instance checks. See `tests/plugin_catalog.py` for executable boundary and scheduled-run fixtures.
