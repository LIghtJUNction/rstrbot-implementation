# RstrBot HTTP contract — application 0.2.0, API v1

Machine-readable OpenAPI 3.1: `GET /api/v1/openapi.json` and `docs/openapi.json`; covers all 66 API operations plus the two health operations. Router coverage includes the identity, email and provider configuration modules.

## Account and authentication additions

`GET /auth/options` returns enabled methods without secrets. `GET /auth/security` returns only the caller's verified email, Google bindings, passkey summaries and `recent_auth_until`. Account settings do not require workspace membership. Login accepts a username or explicitly verified email plus password.

`POST /auth/reauth {password}` and `/auth/passkeys/reauth/{options,finish}` refresh a five-minute window for the current session, without extending session expiry. Google sign-in is not a substitute for this confirmation. Proof failures have distinct codes and do not by themselves invalidate a still-valid browser session.

Passkey routes include `/auth/passkeys/register/{options,finish}`, `/auth/passkeys/login/{options,finish}` and PATCH/DELETE `/auth/passkeys/{id}`. Finish bodies contain `{challenge_id,credential}`; only public options are returned, while verifier state stays in a one-use, expiring database row. Registration may include `replace_id`; the new verified credential and old removal commit atomically. Default ceremonies require UV and leave physical/platform choice to the browser. Origin must be HTTPS or localhost and RP ID must exactly match the hostname. A change in configuration revision or credential version invalidates stale completion.

`POST /auth/google/start {mode:"login"|"link"}` returns the fixed Google authorization URL and sets a short-lived HttpOnly Lax browser-binding cookie. The ordinary login cookie remains Strict. `GET /auth/google/callback` consumes the one-use intent, checks binding and PKCE/nonce/verified ID token, then redirects to a fixed same-origin success/failure location; credentials never enter the return URL. Existing account linking uses current recent authentication and stable Google `sub`, never an email match. `POST /auth/google/unlink {id}` removes an owned binding and its issued sessions.

`POST /auth/email/start {email}` sends a same-session, single-use 15-minute verification link; `/auth/email/verify {token}` confirms it. Public `/auth/password/reset/request {email}` uses a generic response, and `/auth/password/reset/finish {token,new_password}` checks the original email/password version before revoking all prior sessions. SMTP delivery does not establish an email binding by itself.

`GET/PUT /admin/auth-settings` is instance-administrator only. PUT requires recent authentication and matching `revision`; secret inputs are write-only, encrypted at rest, and retained only when their destination is unchanged. `POST /admin/auth-settings/test-email {email}` sends through the saved SMTP configuration. The complete DTOs, errors and flags are in OpenAPI; operational setup and limitations are in [AUTHENTICATION.md](AUTHENTICATION.md).

New backups use `rstrbot-db-v2` with database schema 2. They include durable identity bindings and encrypted settings but exclude active sessions, authentication challenges and email tokens. Import remains a local maintenance operation and accepts legacy v1 backups.

## Shared API behavior

Base `/api/v1`. Errors `{error:{code,message}}`. Browser uses HttpOnly SameSite=Strict cookie, other clients Bearer. Mutation requests from browser have `X-RstrBot-Request: 1` (CSRF defense). No CORS credentials allowed. Resource paths always include workspace: `/workspaces/:wid/resources/:kind` (GET/POST) and `/workspaces/:wid/resource/:id` (GET/PATCH/DELETE). PATCH `{version,data}`; DELETE `?version=N`. Responses resource directly, lists `{items}`. Optional visibility `private` (default) or `workspace` on creation; changing visibility requires a separate explicit sharing flow and is not implicit on edit.

`GET /setup`: `{initialized,database,valkey,version}`. `POST /setup`: `{token,username,password,workspace}`; establishes session. The first CLI launch establishes a database connection; setup displays explicit SQLite/PostgreSQL choices and requires an actual successful selection before completing a type change. `POST /setup/test-database` requires bootstrap token and accepts `{token,database_url}`. Safe database change before setup via `POST /setup/database` with same body; never overwrites initialized target. `GET /auth/me` returns `{user}`; login username/password, logout POST. `POST /admin/users` `{username,password}` creates login without membership, administrator only.

`GET /workspaces` returns `{items}`; POST `{name}`. `/workspaces/:wid/members` GET and POST `{user_id,role}` (user id from account creation); PATCH `/members/:uid` `{role}`, DELETE same. GET `/capabilities` includes supported/authorized/available. GET `/budget`, PUT `{limit_microusd:null|integer}`.

Resources have `{id,workspace_id,owner_id,kind,visibility,version,data,created_at,updated_at}`; timestamps Unix seconds. Data:

- conversations: `{title,generation:0,system_prompt:"",model_id?,messages:[]}`. Messages contain `{id,role,content,created_at,run_id?,tool_calls?,tool_call_id?,citations?}`. Server owns messages/generation; initial create only title/system_prompt. Collection rows and the HTTP chat acceptance response omit `messages` and include `message_count`. GET resource returns history by default; `?include_messages=false` returns metadata. GET `/conversations/:id/messages?limit=50&before=N` returns `{items,next_before,total}` in chronological order; `next_before:null` means no earlier page. POST `/conversations/:id/reset` resets projection generation, preserves history. POST `/conversations/:id/branch` `{message_id,content}` forks history; never alters source.
- models: `{name,provider,base_url,model,api_key?,max_tokens:2048,input_microusd_per_million?,output_microusd_per_million?,allow_private_network:false}`. Provider IDs are read from installed packages declaring model capability; bundled OpenAI-compatible and diagnostic providers are examples, not a closed HTTP enum. API keys are write-only, encrypted at rest and represented in reads by `has_api_key`. Only instance admins may approve private-network access while the global policy permits it; model config never contains executable paths. POST `/models/:id/test` makes an actual model request and may incur cost. Diagnostic is an explicitly labeled local fixture, not AI.
- knowledge: `{title,text,status:"ready",chunks:[],index_version:1}`; server builds chunks. Search GET `/knowledge/search?q=...` => `{items:[{id,title,excerpt,score,chunk}]}`. UTF-8 text/Markdown import is supported first; other formats must state unsupported. Client creation `{title,text}`.

  Search also returns `degraded`, `degraded_reason` and `inconsistent_documents` (authorized IDs and titles after access and version rechecks); `index_inconsistent` means at least one eligible, accessible ready source failed index validation, so results may be incomplete. Chat fails with `knowledge_index_inconsistent` before contacting the model and names up to five sources allowed for that conversation audience. Re-saving valid source text rebuilds its index. Inaccessible or disabled sources do not degrade another audience's search.

  Run and conversation citation records retain source identifiers, hash, version and offsets, but do not persist the retrieved `text` or `excerpt`. Older citation fields are redacted on API reads. This does not erase generated answers or old database and backup copies, and does not establish an in-flight revocation guarantee.
- memories: `{title,content,source,enabled:true,archived:false,pinned:false}`. Explicit user-maintained; no silent learning.
- schedules: `{title,prompt,model_id,conversation_id,schedule_type:"once"|"interval"|"cron",at?:unix_seconds,interval_seconds?:integer,cron?:"0 0 9 * * *",timezone:"Asia/Taipei",enabled:true,missed_policy:"skip"}`. Server computes next_run; POST `/schedules/:id/run` manual, PATCH config version. Restored schedules disabled until explicitly enabled.
- plugins: `{name,package_id,enabled:false,config:{},status:"installed",generation:0}`. Package ids from GET `/plugin-packages`. Instance admin installs trusted local package manifests using CLI; workspace admin can create/enable isolated instances. POST `/plugins/:id/reload`; runtime status truthful, no running process until invocation.
- routes: `{name,adapter:"webhook",url,enabled:false}`. Explicit allowlisted outbound destination, no secrets rendered. Webhook delivery status separately recorded. Server admin must approve network origins. UI may leave disabled unless supported capability says true.
- agents: `{name,system_prompt,model_id,max_steps:6,knowledge:true,memory:true}`. Frozen per run.
- runs (read only): `{conversation_id,status:"queued|running|completed|failed|cancelled|interrupted|unknown",stage,content,error?,usage?,cost_microusd?,steps,delivery,persistence,created_at}`. Unknown cost is null.

POST `/workspaces/:wid/chat` `{conversation_id,content,model_id,idempotency_key,agent_id?,attachments?:[{name,text}]}` -> `{run,conversation}`; returns accepted asynchronously. GET `/events?after=cursor&limit=100` -> `{items,cursor}` durable ordered events `{id,kind,data,resource_id,...}`; data includes run_id/conversation_id, delta on `run.delta`. Poll 700 ms while active, 3s idle; switching context cancels old read requests and invalidates their view updates; an already submitted mutation is not implicitly cancelled. POST `/runs/:id/cancel`. GET `/runs/:id` resource. Every poll rechecks membership and private visibility. SSE optional, polling provides reliable recovery.

GET `/workspaces/:wid/export` exports only caller-visible resources, model secrets removed. GET `/admin/backup` administrator-only offline-consistent snapshot (does not contain key); CLI restore into empty database, pauses external work. GET `/workspaces/:wid/audit` -> `{items}` metadata only, no private message content.

Capabilities not implemented are `supported:false,available:false,reason` and do not produce fake successes. Never send model/plugin secrets in error bodies.

## Model ID discovery

Workspace administrators can call `POST /workspaces/:wid/models/discover` with `{provider,base_url,allow_private_network?,api_key?,saved_model_id?}`. The body rejects unknown fields. At most one credential source may be used: a temporary `api_key`, or `saved_model_id` referencing a visible saved model whose provider, exact base URL and private-network grant match. The endpoint invokes only the installed provider's `model.list` method. It does not generate text or reserve RstrBot budget; the provider may still log or charge the request. Temporary keys are never saved. Current session, workspace role, recovery state, private-network policy and saved model version are checked around the worker call. The response is `{items:[{id,name}],truncated,fixture}` with validated and deduplicated entries, capped at 500. The model editor keeps free text input and uses discovered IDs as suggestions, so manual IDs remain available when a provider does not support discovery or is unavailable. Diagnostic results are marked as fixtures.

## Explicit outbound delivery

`POST /workspaces/:wid/routes/:id/send` takes `{text,idempotency_key}` and returns a private `deliveries` resource. Only the instance operator may authorize a destination. The caller must currently have access to that enabled route. The request cannot override its URL or token. An intent is saved before any network send; repeated keys return the stored receipt. `accepted`, `rejected`, `unknown`, and `not_sent` remain distinct. Webhook acceptance is not proof that a human read the message. The adapter never retries an uncertain send and does not assume the receiver implements idempotency.

`GET /workspaces/:wid/resources/deliveries` lists only visible receipts. Delivery resources cannot be created or rewritten through generic resource endpoints. Recovery does not replay sends.

`GET /setup` and `/health/ready` expose `valkey_status`: `disabled`, `connecting`, `available`, `degraded`, or `invalid_configuration`. A healthy core can report a degraded optional cache. Cache status is observed by a short-lived presence write/read and is never used to authorize a request or settle a budget.

Database connection tests are read-only and do not run schema migrations. An existing unrelated schema is refused during selection. A new SQLite path should be selected at CLI startup, which creates it; the browser can test existing SQLite files and empty PostgreSQL schemas.

## 0.1.1 authority refinements

An authenticated HTTP chat keeps its original session as an in-memory execution lease. Logout cancels that credential's runs; password changes revoke all user sessions. The engine rechecks the lease during bounded worker calls and before continuing. Already known usage is still recorded, and uncertain charges are not released merely because authorization ended. Owner-delegated schedules have a separate persistent intention and do not depend on the browser session that created them.

Workspace-visible conversations automatically retrieve only workspace-visible knowledge, memories and plugin instances. Their agent must also be workspace-visible: admission with a private agent returns 403 atomically without creating a run or consuming its idempotency key. Personal search and private conversations retain the caller's normal private-resource access. This does not retroactively redact output created by an older version.

Only the schedule owner may PATCH a schedule's configuration, even when it is shared and the caller is another workspace administrator or owner. Current membership and minimum execution role remain required. Moderators retain authorized DELETE access to shared schedules; private schedules remain owner-only.

Saved model credentials may be retained only if both provider and the complete normalized URL stay the same. Retargeting or changing provider requires a new nonempty `api_key` or explicit `clear_api_key: true`; otherwise the update returns 400. The same rule applies to a route's bearer `token` and `clear_token`. Clearing takes precedence if both clear and replacement are supplied. A non-instance administrator cannot move a private-network grant to another destination, even with a new credential. The comparison covers the scheme, host, port and entire path, not just the origin.

Every actual model request and Webhook dispatch checks the current instance-wide private-network policy in addition to the saved resource grant. Disabled instance policy rejects new private-network operations with 403 `private_network_disabled`. A blocked model call does not reserve a new charge. A newly blocked delivery persists a `not_sent` receipt, so reusing its key after policy is re-enabled does not send it. Existing accepted/unknown receipts remain available for reconciliation without retransmission.

Collections accept `limit` and `offset` after authorization filtering. The WebUI exposes continuation controls and searches loaded pages; this version does not claim a full-collection search API. A refresh reconciles offset pages after concurrent inserts or deletions.


## 0.1.2 delivery leases and startup recovery

The HTTP send endpoint retains the exact caller credential as an in-memory
execution lease. It is not stored in the delivery resource and is not sent to the
worker. A second valid session for the same user cannot renew the revoked lease
of an already queued request. The request checks the credential before creating a
new intention. Existing receipt lookup still requires a current authenticated
caller, membership and visibility to the same authorized route.

The core revalidates the lease after obtaining a worker slot and after the worker
handshake, immediately before dispatching `platform.send`. These checks also
require the current member role, an enabled unchanged route version and current
private-network policy. A bounded monitor continues to check authority while the
call is running. The worker supplies none of these authorization facts.

A rejection before the known send boundary can preserve `not_sent`; once the
intent has entered sending, failure or cancellation without a reliable receipt
is conservatively `unknown`. The host attempts bounded process cleanup and
retains an already known final receipt. Logout does not prove that a remote side
effect was undone. Reusing an intention's key returns its saved receipt; changing
the route/version/text while retaining the key conflicts rather than silently
sending a different payload.

Before binding the HTTP listener, startup reconciles runs, deliveries and
schedule claims. It uses internal pages of 128 records with a 16 MiB stored-JSON
batch bound (one record is always allowed for progress), ordered by
`(created_at, id)` with a first-page upper bound. These internal cursors are not
public API tokens and must never bypass workspace authorization. Public
collections still use their existing authorized `limit`/`offset` contract.
The internal scan is not a transaction snapshot; periodic scheduling starts a
fresh bounded scan on each pass.

Recovery marks unfinished runs interrupted, prepared deliveries `not_sent`,
sending deliveries `unknown`, and in-flight schedule claims disabled and
`needs_reconciliation`. It does not create replacement operations. The listener
and periodic scheduler start only after all three recovery phases succeed.

UI affordances mirror the store rules: instance administration alone does not
grant workspace write permission; shared resources require an allowed role and
ownership or moderation authority; another user's private resource remains
unavailable. A member may read a shared conversation without permission to append
to it. The server remains authoritative even when a client shows stale controls.

The current 22-group integration runner and 14-flow browser harness include
regressions for these boundaries. Execution results for the release candidate
are recorded separately in `docs/evidence/v0.1.2/`; the presence of this contract
or a test definition does not establish that those runs passed.

Implementation references: [delivery authority](../src/delivery.rs),
[worker dispatch checks](../crates/rstrbot-plugin/src/host.rs),
[bounded internal scans](../crates/rstrbot-store/src/resources.rs), and
[startup ordering](../src/main.rs).


## 0.1.3 authentication and model-test dispatch

Login commits a session only while the account still has the password hash that
was actually verified and is still enabled. Password changes atomically replace
that verified hash and revoke the account's sessions. A concurrent password
change or local recovery invalidates older verified login/change requests; they
return 401 rather than issuing a post-revocation session or overwriting a newer
password. Argon2 work runs outside the short database transaction. No database
schema or HTTP request shape changed.

Model tests use the exact presented session as an in-memory lease, just like
HTTP chat. Current workspace administrator permission and the tested model's
version are checked before admission, after a worker slot becomes available,
after its handshake, while it runs, and before exposing its result. Normal model
and tool calls also recheck their current execution authority at both dispatch
gates. A second valid session does not revive a revoked queued request.

Cancellation does not undo an upstream request already sent. Known usage is
settled before the final response authorization; missing receipts retain unknown
cost and are never automatically replayed. These checks narrow the dispatch
race but do not claim an atomic transaction with an external provider.

The WebUI invalidates asynchronous view updates when leaving a conversation,
page or workspace. If only empty-conversation creation was submitted, leaving
that view prevents the subsequent model request. An already submitted chat may
finish in the original conversation; its late response cannot overwrite the new
view or clear its draft. Explicit access/not-found responses hide denied cached
content, and a later network failure cannot make it visible again. A successful
authorized read is required to restore it.

## Safe provider rejection categories

Model-provider HTTP 401, 403 and 429 are exposed as `provider_authentication_failed`, `provider_access_denied` and `provider_rate_limited` in a 502 error envelope. They do not invalidate the RstrBot session. Failed run resources may include `error_code`; older records without it remain readable. Raw response bodies and credentials are not returned; unknown network outcomes remain unknown and are not replayed automatically.

## 会话模型绑定（1.18）

成功接纳聊天运行时，会话元数据的可选 `last_model_id` 与用户消息和运行在同一事务写入；幂等重放不改变已有绑定。旧会话可能没有该字段。共享会话使用私有模型会被拒绝，拒绝不创建用户消息或运行；模型删除或失去访问权时客户端必须要求重新选择。

## Browser recovery after an unconfirmed chat admission

The Web client persists the exact chat request intent under the current origin, user, workspace and conversation before dispatch. A manual continuation with identical content, model and agent reuses the same idempotency key; it does not automatically resend. A different intent requires explicit confirmation after reviewing records. If browser storage is unavailable, the UI pauses sending. Server-side admission remains authoritative; pending browser records do not bypass workspace or resource permissions. The single-browser tests do not establish atomic coordination between simultaneously sending tabs or across devices.

For the same browser origin, the Web client uses Web Locks to serialize pending-intent creation and deletion for each user/workspace/conversation. A confirmation only clears the exact snapshot it presented; changed records are retained. Missing lock support or unavailable storage pauses sends. Web Locks require a secure context; HTTPS or localhost is required. This is not cross-device coordination, and server authorization and idempotency remain authoritative.

For an uncertain schedule, `POST /workspaces/:wid/schedules/:id/reconcile` with `{version,acknowledge:true}` records the owner's review and keeps the schedule paused. Only its owner with current execution permission may do this; stale versions and known active runs conflict. The atomic `schedule.reviewed` event retains the old claim and run, while outcome remains unknown. This operation does not send, enable or alter charges. Re-enabling separately schedules only future occurrences; an expired one-time plan requires editing its time.

Text attachments accept up to three UTF-8 .txt/.md names and original text, 16,384 bytes each and 32,768 bytes total. The core validates inputs and atomically stores them with the conversation message. The same key with changed attachments conflicts. Original text and SHA-256 are returned only to authorized conversation readers; the model receives the original text as untrusted user-supplied data. Images, PDF and binary files are not accepted.

The capabilities response reports `text_attachments` with supported/authorized/available, extensions and byte/file limits; generic `attachments` remains unsupported for images, audio, PDF, binary files and dedicated uploads.

`POST /workspaces/:wid/chat/text-attachments` follows the same chat schema and authorization; clients with files use this distinct route so older cores return 404 rather than silently ignoring unknown attachment fields. Never fall back to plain chat automatically.
