#!/usr/bin/env python3
"""Build the curated release contract; this is not automatic Rust type inference.

Run this script after changing its definitions, then run validate_openapi.py.
The validator independently compares methods/paths against the actual router.
Only Python's standard library is required.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[1]
VERSION = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]["version"]
OUT = ROOT / "docs/openapi.json"
SCHEMAS = {}
PATHS = {}
KINDS = ["conversations", "models", "plugins", "knowledge", "memories",
         "schedules", "routes", "agents", "runs", "deliveries"]
INPUTS = dict(zip(KINDS[:8], ["ConversationInput", "ModelInput", "PluginInput",
                 "KnowledgeInput", "MemoryInput", "ScheduleInput", "RouteInput", "AgentInput"]))
TYPE_NAMES = dict(zip(KINDS, ["Conversation", "Model", "Plugin", "Knowledge", "Memory",
                             "Schedule", "Route", "Agent", "Run", "Delivery"]))


def ref(name):
    return {"$ref": "#/components/schemas/" + name}


def string(description=None, **kw):
    value = {"type": "string", **kw}
    if description:
        value["description"] = description
    return value


def integer(description=None, **kw):
    value = {"type": "integer", "format": "int64", **kw}
    if description:
        value["description"] = description
    return value


def obj(properties, required=None, closed=False, **kw):
    value = {"type": "object", "properties": properties,
             "additionalProperties": not closed, **kw}
    if required:
        value["required"] = list(required)
    return value


def array(items, **kw):
    return {"type": "array", "items": items, **kw}


def nullable(value):
    return {"anyOf": [deepcopy(value), {"type": "null"}]}


def text(limit, description="", nonblank=False):
    # The server counts UTF-8 bytes; JSON Schema maxLength counts characters.
    value = string(description or f"At most {limit} UTF-8 bytes.",
                   maxLength=limit, **{"x-max-utf8-bytes": limit})
    if nonblank:
        value.update(minLength=1, pattern=r"\S")
    return value


def schema(name, value):
    SCHEMAS[name] = value
    return ref(name)


def collection(name, item, **kw):
    return schema(name, obj({"items": array(item, **kw)}, ["items"]))


ID = string("Opaque resource/account/workspace identifier; do not infer authorization from its shape.")
TIME = integer("UTC Unix timestamp in seconds.")
BOOL = {"type": "boolean"}
MONEY = integer("Integer micro-US dollars (1 USD = 1,000,000 micro-USD).", minimum=0)
ROLE = schema("Role", string(enum=["viewer", "member", "operator", "admin", "owner"]))
VIS = schema("Visibility", string(enum=["private", "workspace"]))
DB = schema("DatabaseBackend", string(enum=["sqlite", "postgresql"]))
CACHE = schema("ValkeyStatus", string(enum=["disabled", "connecting", "available", "degraded", "invalid_configuration"]))
schema("Error", obj({"error": obj({"code": string(), "message": string()}, ["code", "message"])}, ["error"]))
schema("User", obj({"id": ID, "username": string(), "instance_admin": BOOL}, ["id", "username", "instance_admin"]))
schema("UserResponse", obj({"user": ref("User")}, ["user"]))
collection("UserList", ref("User"), maxItems=1000)
schema("SessionResponse", obj({"user": ref("User"), "expires_at": TIME,
    "token": string("Opaque bearer session token. Included exactly when the request has no Origin header; omitted when Origin is present. This is not an independently scoped API key.", readOnly=True, **{"x-sensitive": True})},
    ["user", "expires_at"], description="Also sets the HttpOnly session cookie. Never cache or log the response body."))
schema("SetupStatus", obj({"initialized": BOOL, "database": DB, "valkey": BOOL,
    "valkey_status": CACHE, "version": string(), "database_selection": {"const": True}},
    ["initialized", "database", "valkey", "valkey_status", "version", "database_selection"]))
schema("Workspace", obj({"id": ID, "name": string(), "role": ROLE, "created_at": TIME}, ["id", "name", "role", "created_at"]))
collection("WorkspaceList", ref("Workspace"))
schema("Member", obj({"user_id": ID, "username": string(), "role": ROLE}, ["user_id", "username", "role"]))
collection("MemberList", ref("Member"))
schema("MembershipChange", obj({"user_id": ID, "role": ROLE}, ["user_id", "role"]))
schema("Capability", obj({"supported": BOOL, "authorized": BOOL, "available": BOOL, "reason": string()}, ["supported", "authorized", "available"]))
schema("Capabilities", {"type": "object", "additionalProperties": ref("Capability"),
    "description": "Independent support, current authorization and live availability. Unsupported attachments/vector_search/legacy_compatibility/desktop_installers/multi_node are reported as false, not exposed as working routes.",
    "properties": {name: ref("Capability") for name in ["chat", "knowledge", "memories", "schedules", "models", "plugins", "agents", "members", "audit", "export", "backup", "routes", "attachments", "vector_search", "legacy_compatibility", "desktop_installers", "multi_node"]}})
schema("Package", obj({"id": ID, "name": string(), "version": string(), "capabilities": array(string()),
    "permissions": array(string()), "checksum": nullable(string())}, ["id", "name", "version", "capabilities", "permissions", "checksum"]))
collection("PackageList", ref("Package"))
schema("Budget", obj({"workspace_id": ID, "limit_microusd": nullable(MONEY), "spent_microusd": MONEY,
    "reserved_microusd": MONEY, "unknown_reservations": integer(minimum=0)},
    ["workspace_id", "limit_microusd", "spent_microusd", "reserved_microusd", "unknown_reservations"]))
schema("Reservation", obj({"id": ID, "workspace_id": ID, "operation_id": string(), "amount_microusd": MONEY,
    "actual_microusd": nullable(MONEY), "state": string(enum=["reserved", "settled", "unknown"])},
    ["id", "workspace_id", "operation_id", "amount_microusd", "actual_microusd", "state"]))
collection("ReservationList", ref("Reservation"), maxItems=500)

schema("LoginInput", obj({"username": text(254, "Local username or explicitly verified email; trimmed and lowercased by the server."),
    "password": text(1024, "Existing account password.") | {"format": "password", "writeOnly": True}}, ["username", "password"], True))
password = text(1024, "12–1024 UTF-8 bytes. This byte minimum is not a Unicode character count.") | {"format": "password", "writeOnly": True, "x-min-utf8-bytes": 12}
username = text(64, "After trim/lowercase: 3–64 ASCII letters, digits, underscore, dash, @ or dot.")
proof = string("The current local bootstrap.token proof, valid for 15 minutes while uninitialized. Never place it in a URL.", writeOnly=True, **{"x-sensitive": True})
schema("CreateUserInput", obj({"username": username, "password": password}, ["username", "password"], True))
schema("SetupInput", obj({"token": proof, "username": username, "password": password,
    "workspace": text(200, nonblank=True)}, ["token", "username", "password", "workspace"], True))
schema("PasswordInput", obj({"current_password": text(1024) | {"format": "password", "writeOnly": True},
    "new_password": password}, ["current_password", "new_password"], True))
schema("AuthOptions", obj({"google_enabled": BOOL, "passkey_enabled": BOOL, "email_enabled": BOOL,
    "public_origin": nullable(string()), "rp_id": nullable(string()), "username_required": {"const": True}},
    ["google_enabled", "passkey_enabled", "email_enabled", "public_origin", "rp_id", "username_required"]))
schema("VerifiedEmail", obj({"email": string(format="email"), "verified_at": TIME, "version": integer(minimum=1)}, ["email", "verified_at", "version"]))
schema("GoogleBinding", obj({"id": ID, "email": nullable(string()), "created_at": TIME, "last_used_at": nullable(TIME)}, ["id", "email", "created_at", "last_used_at"]))
schema("PasskeySummary", obj({"id": ID, "name": string(), "created_at": TIME, "last_used_at": nullable(TIME),
    "backup_eligible": nullable(BOOL), "backed_up": nullable(BOOL)}, ["id", "name", "created_at", "last_used_at", "backup_eligible", "backed_up"]))
schema("PasskeyResponse", obj({"passkey": ref("PasskeySummary")}, ["passkey"]))
schema("AccountSecurity", obj({"email": nullable(ref("VerifiedEmail")), "google": array(ref("GoogleBinding")),
    "passkeys": array(ref("PasskeySummary")), "has_password": BOOL, "recent_auth_until": TIME},
    ["email", "google", "passkeys", "has_password", "recent_auth_until"]))
schema("RecentAuthentication", obj({"recent_auth_until": TIME}, ["recent_auth_until"]))
schema("PasswordReauth", obj({"password": text(1024) | {"format": "password", "writeOnly": True}}, ["password"], True))
schema("EmailInput", obj({"email": text(254) | {"format": "email"}}, ["email"], True))
schema("EmailPending", obj({"pending": {"const": True}, "expires_at": TIME}, ["pending", "expires_at"]))
schema("EmailAccepted", obj({"accepted": {"const": True}}, ["accepted"]))
verification_token = text(256, "Single-use random token from the email link fragment; never log or place in a query parameter.") | {"writeOnly": True, "x-sensitive": True}
schema("EmailVerifyInput", obj({"token": verification_token}, ["token"], True))
schema("EmailResetInput", obj({"token": verification_token, "new_password": password}, ["token", "new_password"], True))
schema("PasskeyRegistrationInput", obj({"name": text(100), "replace_id": nullable(ID),
    "authenticator": nullable(string(enum=["any", "security-key", "platform", "google-password-manager"]))}, ["name"], True))
schema("PasskeyLoginInput", obj({"username": text(254, "Username or verified email; this release uses an account-first passkey flow.")}, ["username"], True))
schema("PasskeyOptions", obj({"challenge_id": string("Opaque single-use ceremony ID, not verifier state."), "expires_at": TIME,
    "publicKey": obj({}, description="WebAuthn request/creation options. Binary values are unpadded base64url strings; decode before calling navigator.credentials.")}, ["challenge_id", "expires_at", "publicKey"]))
schema("PasskeyFinishInput", obj({"challenge_id": text(256), "credential": obj({},
    description="Native WebAuthn credential with id/rawId/type/response and clientExtensionResults. Binary fields use base64url. The WebAuthn verifier checks signature, origin, RP, challenge and user verification.")}, ["challenge_id", "credential"], True))
schema("PasskeyRenameInput", obj({"name": text(100)}, ["name"], True))
schema("GoogleStartInput", obj({"mode": string(enum=["login", "link"])}, ["mode"], True))
schema("GoogleStartResponse", obj({"url": string(format="uri")}, ["url"]))
schema("GoogleUnlinkInput", obj({"id": ID}, ["id"], True))
secret_input = text(8192, "Write-only secret. Omit or send empty to retain; clear explicitly. Destination changes require replacement or clearing.") | {"writeOnly": True, "x-sensitive": True}
schema("GoogleSettingsInput", obj({"enabled": BOOL, "client_id": text(254), "client_secret": nullable(secret_input),
    "clear_client_secret": BOOL}, ["enabled", "client_id"], True))
smtp_properties = {"enabled": BOOL, "host": text(253), "port": integer(minimum=1, maximum=65535),
    "security": string(enum=["tls", "starttls", "local"]), "username": text(254), "from_email": text(254), "from_name": text(120)}
schema("SmtpSettingsInput", obj(smtp_properties | {"password": nullable(secret_input), "clear_password": BOOL}, list(smtp_properties), True))
schema("AuthSettingsInput", obj({"revision": integer(minimum=0), "public_origin": nullable(string()), "rp_id": nullable(string()),
    "google": ref("GoogleSettingsInput"), "smtp": ref("SmtpSettingsInput")}, ["revision", "google", "smtp"], True))
schema("AuthSettings", obj({"revision": integer(minimum=0), "public_origin": nullable(string()), "rp_id": nullable(string()),
    "passkey_count": integer(minimum=0),
    "google": obj({"enabled": BOOL, "client_id": string(), "has_client_secret": BOOL, "redirect_uri": nullable(string())}, ["enabled", "client_id", "has_client_secret", "redirect_uri"]),
    "smtp": obj(smtp_properties | {"has_password": BOOL}, list(smtp_properties) + ["has_password"])}, ["revision", "public_origin", "rp_id", "passkey_count", "google", "smtp"]))
schema("DatabaseInput", obj({"token": proof,
    "database_url": text(4096, "sqlite:, postgres:// or postgresql:// URL. Credentials are sensitive. SQLite probes require an existing file; select a new SQLite path at CLI startup.") | {"writeOnly": True}}, ["token", "database_url"], True))
schema("DatabaseProbe", obj({"connected": {"const": True}, "database": DB, "initialized": BOOL,
    "can_select": BOOL, "read_only_probe": {"const": True}}, ["connected", "database", "initialized", "can_select", "read_only_probe"]))
schema("DatabaseSelected", obj({"database": DB, "selected": {"const": True}}, ["database", "selected"]))
schema("WorkspaceInput", obj({"name": text(200, nonblank=True)}, ["name"], True))
schema("MemberInput", obj({"user_id": ID, "role": ROLE}, ["user_id", "role"], True))
schema("RoleInput", obj({"role": ROLE}, ["role"], True))
schema("BudgetInput", obj({"limit_microusd": nullable(MONEY)}, closed=True,
    description="A nonnegative integer sets the workspace budget. Null OR an omitted field clears the limit; the current serde Option field is not required."))

schema("ConversationInput", obj({"title": text(200, nonblank=True), "system_prompt": text(16000)}, ["title"],
    description="Write title and optional system_prompt. Omitted system_prompt becomes an empty string. messages and generation are rejected; other unknown data fields are ignored.",
    **{"not": {"anyOf": [{"required": ["messages"]}, {"required": ["generation"]}]}}))
price = nullable(integer("Configured micro-USD per million tokens; not a fetched or verified supplier price.", minimum=0, maximum=1_000_000_000_000))
schema("ModelInput", obj({"name": text(200, nonblank=True), "model": text(200, nonblank=True),
    "provider": string("Installed package with model capability; bundled values are openai and diagnostic. Third-party installed provider IDs are allowed.", default="openai"),
    "base_url": text(2048, "Required unless provider is diagnostic. Public endpoints require HTTPS, no embedded credentials/query/fragment. HTTP/private targets require explicit instance and resource approval."),
    "api_key": text(8192, "Write-only; omitted or empty preserves the previous secret only for the same normalized URL and provider. Changing either requires a new secret or clear_api_key=true.") | {"writeOnly": True, "format": "password"},
    "clear_api_key": BOOL, "max_tokens": integer(minimum=1, maximum=32768, default=2048),
    "input_microusd_per_million": price, "output_microusd_per_million": price,
    "allow_private_network": BOOL}, ["name", "model"],
    description="Private-network authorization is bound to an instance-approved full URL and provider and is subject to the global policy at invocation. Unknown fields are ignored; a model's existence does not prove endpoint connectivity."))
schema("ModelDiscoveryInput", obj({
    "provider": text(100, "ID of an installed package declaring model capability.", nonblank=True),
    "base_url": text(2048, "Required for network providers; HTTP requires an approved private-network grant."),
    "api_key": nullable(text(8192, "Temporary write-only credential used for this discovery call and never persisted.") | {"writeOnly": True, "format": "password", "x-sensitive": True}),
    "allow_private_network": BOOL | {"default": False},
    "saved_model_id": nullable(ID),
}, ["provider"], closed=True,
    description="Supply at most one of api_key or saved_model_id. A saved key is reused only when the saved model's workspace, provider, exact base URL and private-network grant match. Unknown fields are rejected."))
schema("DiscoveredModel", obj({"id": text(200, nonblank=True), "name": text(200)}, ["id", "name"], closed=True))
schema("ModelDiscoveryResult", obj({"items": array(ref("DiscoveredModel"), maxItems=500), "truncated": BOOL, "fixture": BOOL},
    ["items", "truncated", "fixture"], closed=True,
    description="Only sanitized model IDs and display names are returned; provider-specific fields are discarded."))
schema("PluginInput", obj({"name": string(), "package_id": text(120, nonblank=True), "enabled": BOOL | {"default": False},
    "config": {"description": "JSON passed to the selected trusted worker. Serialized config is limited to 32 KiB; current implementation accepts any JSON value, not only an object.", "x-max-json-bytes": 32768}}, ["package_id"],
    description="The operator installs executable packages through CLI. This API creates a workspace instance, not an arbitrary executable installation. Omitted enabled becomes false."))
schema("KnowledgeInput", obj({"title": text(512, nonblank=True), "text": text(524288, "Nonblank UTF-8 text/Markdown, at most 512 KiB, without NUL bytes.", True),
    "enabled": BOOL, "archived": BOOL}, ["title", "text"], description="Indexes are rebuilt from the source. Caller-supplied chunks or source hashes are ignored. No PDF/media/URL import endpoint is provided."))
schema("MemoryInput", obj({"title": text(200, nonblank=True), "content": text(16000, nonblank=True), "source": text(2000),
    "enabled": BOOL | {"default": True}, "archived": BOOL | {"default": False}, "pinned": BOOL | {"default": False},
    "expires_at": nullable(TIME)}, ["title", "content"]))
schedule_time = {"anyOf": [integer(minimum=0, maximum=4_102_444_800), string(format="date-time")],
    "description": "Unix seconds from 1970 to 2100, or RFC3339 with explicit UTC offset; normalized to seconds when applicable."}
schema("ScheduleInput", obj({"title": text(200, nonblank=True), "prompt": text(16384, nonblank=True),
    "model_id": text(128, nonblank=True), "conversation_id": text(128, nonblank=True), "agent_id": nullable(text(128, nonblank=True)),
    "schedule_type": string(enum=["once", "interval", "cron"]), "at": schedule_time, "start_at": schedule_time,
    "interval_seconds": integer(minimum=60, maximum=31536000), "cron": text(128, "Six or seven fields; the seconds field must be one integer 0–59. Maximum frequency is once per minute."),
    "timezone": text(100, "IANA timezone. Required for cron; defaults to UTC for other kinds.", True),
    "enabled": BOOL | {"default": True}, "missed_policy": {"type": "string", "const": "skip", "default": "skip"}},
    ["title", "prompt", "model_id", "conversation_id", "schedule_type"],
    description="once requires at; interval requires interval_seconds; cron requires cron and timezone. Additional operational fields are ignored or preserved from stored state. No automatic replay after uncertain dispatch.",
    allOf=[
        {"if": {"properties": {"schedule_type": {"const": "once"}}, "required": ["schedule_type"]}, "then": {"required": ["at"]}},
        {"if": {"properties": {"schedule_type": {"const": "interval"}}, "required": ["schedule_type"]}, "then": {"required": ["interval_seconds"]}},
        {"if": {"properties": {"schedule_type": {"const": "cron"}}, "required": ["schedule_type"]}, "then": {"required": ["cron", "timezone"]}}
    ]))
schema("RouteInput", obj({"name": text(200, nonblank=True), "url": text(2048, "HTTP(S) destination without embedded credentials, query or fragment. The sending adapter applies HTTPS/address/redirect restrictions before dispatch."),
    "enabled": BOOL | {"default": False}, "allow_private_network": BOOL,
    "token": text(8192, "Write-only outbound bearer secret; empty/omitted preserves it only for the same normalized destination. Changing destination requires a new token or clear_token=true.") | {"format": "password", "writeOnly": True},
    "clear_token": BOOL}, ["name", "url"],
    description="Only an instance administrator may create/change destination or re-enable a route. Workspace admin may disable a previously authorized route. Adapter is server-fixed to webhook."))
schema("AgentInput", obj({"name": text(200, nonblank=True), "system_prompt": text(16000), "model_id": ID,
    "max_steps": integer(minimum=1, maximum=12, default=6), "knowledge": BOOL, "memory": BOOL}, ["name"],
    description="An instruction/configuration resource; not a sub-agent or arbitrary-code sandbox. The run takes an explicit model_id and freezes effective configuration."))
schema("CreateResource", obj({"visibility": VIS | {"default": "private"},
    "data": {"anyOf": [ref(name) for name in INPUTS.values()], "description": "Configuration must match the kind in the URL, not merely any shape. See x-resource-input-schemas for that binding; OpenAPI cannot link a path parameter value directly to request-body branches. Unknown data fields are generally ignored."}},
    ["data"], True, **{"x-resource-input-schemas": {kind: ref(name) for kind, name in INPUTS.items()}}))
schema("UpdateResource", obj({"version": integer("Current resource version for compare-and-swap; stale version returns 409."),
    "data": {"anyOf": [ref(name) for name in INPUTS.values()], "description": "Full editable configuration for the stored kind, not JSON Merge Patch. Required fields must be resubmitted. Omitted fields follow each kind's defaults; secrets are preserved unless explicitly cleared."}},
    ["version", "data"], True, **{"x-resource-input-schemas": {kind: ref(name) for kind, name in INPUTS.items()}}))
schema("ChatRequest", obj({"conversation_id": ID, "content": text(32768, nonblank=True), "model_id": ID,
    "idempotency_key": text(200, "Stable nonblank key scoped to user/workspace. Exact intent replay returns its stored run; changed content/config with the same key conflicts.", True),
    "agent_id": nullable(ID),
    "attachments": array(obj({"name": text(255, "A nonempty .txt or .md filename without path separators or control characters."),
                              "text": text(16384, "UTF-8 text without NUL. Original bytes are preserved.")}, ["name", "text"], True),
                         maxItems=3, description="UTF-8 text files sent with the message; combined text is at most 32768 UTF-8 bytes. The files inherit conversation visibility and are included in the model request.")},
    ["conversation_id", "content", "model_id", "idempotency_key"], True,
    description="Unknown top-level and attachment fields are rejected before admission. Older versions ignored extra chat fields. Sends an asynchronous run; HTTP success does not mean the model has completed."))
schema("ReconcileScheduleInput", obj({"version": integer(minimum=1), "acknowledge": {"const": True, "type": "boolean"}}, ["version", "acknowledge"], True))
schema("BranchInput", obj({"message_id": ID, "content": text(32768, nonblank=True)}, ["message_id", "content"], True))
schema("SendRequest", obj({"text": text(32768, nonblank=True),
    "idempotency_key": text(191, "Stable opaque key. The stored key prepends delivery: within the 200-byte bound. Reuse the original key after an uncertain response; never change the text or route version under the same key.")},
    ["text", "idempotency_key"], True, description="No URL/token override is accepted. The saved authorized route supplies both. An unknown result is not automatically retried."))

schema("Message", obj({"id": ID, "role": string(), "content": {"description": "Provider-preserved JSON content, normally text; rendered as safe text by this release."},
    "created_at": TIME, "run_id": ID, "generation": integer(minimum=0), "tool_call_id": string(), "name": string(),
    "tool_calls": array(obj({"id": string(), "type": string(), "function": obj({"name": string(), "arguments": string()})})),
    "citations": array({})}, description="Provider fields may be retained, but api_key/token/password/provider_state fields are recursively omitted from HTTP views. Plain model text never triggers a tool."))
schema("ConversationData", obj({"title": string(), "system_prompt": string(), "generation": integer(minimum=0),
    "active_run": nullable(ID), "messages": array(ref("Message")), "message_count": integer(minimum=0),
    "branched_from": obj({"conversation_id": ID, "message_id": ID}, ["conversation_id", "message_id"])},
    ["title", "generation"], description="Collection and /chat responses omit messages and include message_count. Single-resource reads include history unless include_messages=false. Reset preserves history while incrementing generation."))
for kind, name in INPUTS.items():
    if kind == "conversations":
        continue
    data = deepcopy(SCHEMAS[name])
    data.pop("allOf", None)
    data.pop("required", None)
    data["description"] = "Sanitized stored configuration and server-maintained fields. Unknown/optional values are retained as JSON where the runtime permits them."
    for key in ["api_key", "clear_api_key", "token", "clear_token"]:
        data["properties"].pop(key, None)
    SCHEMAS[TYPE_NAMES[kind] + "Data"] = data
SCHEMAS["ModelData"]["properties"]["has_api_key"] = BOOL
SCHEMAS["RouteData"]["properties"].update(adapter={"const": "webhook"}, has_token=BOOL)
SCHEMAS["PluginData"]["properties"].update(status=string(), generation=integer(minimum=0), last_error=nullable(string()))
# These particular fields pass through serde_json::Value without a strict type
# guard. A response schema must not promise stronger types than existing data.
for data_name, properties in {
    "ModelData": {"base_url": "string", "allow_private_network": "boolean"},
    "PluginData": {"name": "string"},
    "KnowledgeData": {"enabled": "boolean", "archived": "boolean"},
    "MemoryData": {"source": "string", "expires_at": "integer or null"},
    "AgentData": {"system_prompt": "string", "model_id": "string", "knowledge": "boolean", "memory": "boolean"},
    "RouteData": {"allow_private_network": "boolean"},
    "ScheduleData": {"timezone": "string"},
}.items():
    for property_name, preferred in properties.items():
        SCHEMAS[data_name]["properties"][property_name] = {
            "description": f"Normally {preferred}. Existing runtime paths can preserve this field as arbitrary JSON; consumers must check its type.",
            "x-preferred-json-type": preferred,
        }
schema("KnowledgeChunk", obj({"id": string(), "ordinal": integer(minimum=0), "start_byte": integer(minimum=0),
    "end_byte": integer(minimum=0), "text": string()}, ["id", "ordinal", "start_byte", "end_byte", "text"]))
SCHEMAS["KnowledgeData"]["properties"].update(chunks=array(ref("KnowledgeChunk")), source_hash=string(),
    index_version=integer(), index_kind=string(), state=string(), status=string(), updated_at=TIME)
SCHEMAS["ScheduleData"]["properties"].update(next_run=nullable(TIME), status=string(), claim_id=nullable(string()), claimed_at=TIME,
    scheduled_for=TIME, run_id=nullable(ID), last_run=TIME, last_error={}, last_result={}, misfire_grace_seconds=integer(), dst_policy=string())
schema("RunData", obj({"conversation_id": ID, "model_id": ID, "model_version": integer(), "provider": string(),
    "generation": integer(minimum=0), "agent_id": nullable(ID), "agent_snapshot": nullable(ref("AgentData")),
    "status": string(enum=["queued", "running", "completed", "failed", "cancelled", "interrupted", "unknown"]),
    "stage": string(), "content": string(), "steps": integer(minimum=0), "usage": {}, "cost_microusd": nullable(MONEY),
    "delivery": string(), "persistence": string(), "created_at": TIME, "finished_at": TIME,
    "model_calls": array({}), "tool_results": array({}), "error": {}},
    ["conversation_id", "status", "stage", "content", "steps", "usage", "cost_microusd", "delivery", "persistence", "created_at"],
    description="Independent execution, delivery and persistence facts. usage and cost may be null/unknown. An accepted run can later fail; read events/current run."))
schema("DeliveryData", obj({"route_id": ID, "route_version": integer(), "text": string(),
    "status": string(enum=["prepared", "sending", "accepted", "rejected", "unknown", "not_sent"]),
    "delivery": string(enum=["not_attempted", "in_flight", "accepted", "rejected", "unknown", "not_sent"]),
    "persistence": string(), "deduplication_guaranteed": {"const": False}, "receipt": {}, "error": {},
    "finished_at": TIME, "recovery": string()}, ["route_id", "route_version", "text", "status", "delivery", "persistence", "deduplication_guaranteed"],
    description="Private sender-owned receipt. accepted means HTTP destination accepted, not human read. Unknown operations are never automatically resent. The receiver is not assumed to deduplicate."))
schema("ResourceBase", obj({"id": ID, "workspace_id": ID, "owner_id": ID,
    "kind": string(enum=KINDS), "visibility": VIS, "version": integer(minimum=1), "data": {"type": "object"},
    "created_at": TIME, "updated_at": TIME}, ["id", "workspace_id", "owner_id", "kind", "visibility", "version", "data", "created_at", "updated_at"]))
for kind, name in TYPE_NAMES.items():
    schema(name + "Resource", {"allOf": [ref("ResourceBase"), obj({"kind": {"const": kind}, "data": ref(name + "Data")})]})
schema("Resource", {"oneOf": [ref(name + "Resource") for name in TYPE_NAMES.values()]})
collection("ResourceList", ref("Resource"), maxItems=500)
schema("ChatAccepted", obj({"run": ref("RunResource"), "conversation": ref("ConversationResource")}, ["run", "conversation"]))
schema("MessagePage", obj({"items": array(ref("Message"), maxItems=200), "next_before": nullable(integer(minimum=0)),
    "total": integer(minimum=0)}, ["items", "next_before", "total"]))
schema("ModelTestResult", obj({"success": {"const": True}, "message": {}, "usage": {}, "cost_microusd": nullable(MONEY), "fixture": BOOL},
    ["success", "message", "usage", "cost_microusd", "fixture"]))
schema("KnowledgeHit", obj({"id": string(), "document_id": ID, "title": string(), "excerpt": string(), "text": string(),
    "score": integer(minimum=0), "chunk": nullable(integer(minimum=0)), "chunk_id": string(), "source_start": integer(minimum=0),
    "source_end": integer(minimum=0), "source_hash": nullable(string()), "index_version": nullable(integer())},
    ["id", "document_id", "title", "excerpt", "text", "score", "chunk", "chunk_id", "source_start", "source_end", "source_hash", "index_version"]))
schema("KnowledgeSearch", obj({"items": array(ref("KnowledgeHit"), maxItems=8), "method": {"const": "lexical"}, "truncated": BOOL,
    "limits": obj({"documents": integer(), "scanned_source_bytes": integer(), "results": integer()}, ["documents", "scanned_source_bytes", "results"])},
    ["items", "method", "truncated"], description="Current ACL-filtered lexical search. limits may be absent for an empty tokenized query. truncated reports source scan bounds."))
schema("SchedulePreview", obj({"next_runs": array(TIME, maxItems=5), "next_run": nullable(TIME), "timezone": string(),
    "missed_policy": {"const": "skip"}, "misfire_grace_seconds": {"const": 30}, "dst_policy": {"const": "first_occurrence_skip_gaps"}},
    ["next_runs", "next_run", "timezone", "missed_policy", "misfire_grace_seconds", "dst_policy"]))
schema("Event", obj({"id": integer(), "workspace_id": ID, "resource_id": ID, "kind": string(), "data": {}, "created_at": TIME},
    ["id", "workspace_id", "resource_id", "kind", "data", "created_at"]))
schema("EventPage", obj({"items": array(ref("Event"), maxItems=500), "cursor": integer(minimum=0)}, ["items", "cursor"]))
schema("AuditEvent", {"allOf": [ref("Event"), obj({"data": {"type": "null"}})]})
collection("AuditPage", ref("AuditEvent"), maxItems=500)
schema("VisibleExport", obj({"format": {"const": "rstrbot-visible-resources-v1"}, "workspace_id": ID, "exported_by": ID,
    "created_at": TIME, "resources": array(ref("Resource"), maxItems=10000), "consistent_snapshot": {"const": False}},
    ["format", "workspace_id", "exported_by", "created_at", "resources", "consistent_snapshot"],
    description="Only currently visible sanitized resources, bounded at 16 MiB/10,000 records. Not a transactionally consistent instance backup."))

# Backup rows deliberately have database scalar types; their JSON columns are
# encoded strings. Generate those exact table columns from the source manifest.
backup_source = (ROOT / "crates/rstrbot-store/src/backup.rs").read_text().split("const TABLES:", 1)[1]
table_properties = {}
for match in re.finditer(r'Table\s*\{\s*name:\s*"([^"]+)",\s*columns:\s*&\[(.*?)\]', backup_source, re.S):
    table, definitions = match.groups()
    column_types = {"text": string, "nullable_text": lambda: nullable(string()), "int": integer, "nullable_int": lambda: nullable(integer())}
    columns = {name: column_types[kind]()
               for kind, name in re.findall(r'(text|nullable_text|int|nullable_int)\("([^"]+)"\)', definitions)}
    row_name = "Backup" + "".join(part.title() for part in table.split("_")) + "Row"
    if table == "users":
        columns["password_hash"]["x-sensitive"] = True
    schema(row_name, obj(columns, columns.keys(), True))
    table_properties[table] = array(ref(row_name), maxItems=250000)
assert len(table_properties) == 13
schema("Backup", obj({"format": {"const": "rstrbot-db-v2"}, "schema_version": {"const": 2}, "created_at": TIME,
    "source_backend": DB, "includes_external_state": {"const": False}, "tables": obj(table_properties, table_properties.keys(), True),
    "sha256": string(pattern="^[0-9a-f]{64}$")},
    ["format", "schema_version", "created_at", "source_backend", "includes_external_state", "tables", "sha256"],
    description="Sensitive consistent database snapshot including verified emails, Google/passkey bindings and encrypted identity configuration. Excludes sessions, pending authentication/email challenges, secrets.key and external files/state. Protect separately from the encryption key. Restore is CLI-only into an empty target; legacy v1 imports remain supported.", **{"x-sensitive": True}))
schema("Liveness", obj({"status": {"const": "ok"}, "version": string()}, ["status", "version"]))
schema("Readiness", obj({"status": {"const": "ok"}, "database": DB, "initialized": BOOL, "recovery_mode": BOOL,
    "valkey_status": CACHE, "checks": array(string()), "upstream_models": {"const": "not_checked"}},
    ["status", "database", "initialized", "recovery_mode", "valkey_status", "checks", "upstream_models"]))
schema("OpenApiDocument", obj({"openapi": string(), "info": {"type": "object"}, "paths": {"type": "object"},
    "components": {"type": "object"}, "servers": array({"type": "object"})}, ["openapi", "info", "paths"]))

PARAMETERS = {
    "WorkspaceId": {"name": "wid", "in": "path", "required": True, "schema": ID, "description": "Workspace whose current membership is checked for this operation."},
    "ResourceId": {"name": "id", "in": "path", "required": True, "schema": ID, "description": "Resource ID. Current workspace and private visibility checks apply before use."},
    "UserId": {"name": "uid", "in": "path", "required": True, "schema": ID, "description": "Target local user ID."},
    "ResourceKind": {"name": "kind", "in": "path", "required": True, "schema": string(enum=KINDS), "description": "runs and deliveries are read-only and cannot be posted through generic resources."},
    "CsrfHeader": {"name": "X-RstrBot-Request", "in": "header", "required": False, "schema": {"type": "string", "const": "1"},
        "description": "Required on every /api mutation without an Authorization value starting exactly with 'Bearer '. Includes unauthenticated setup/login. Bearer callers may omit it, but Origin/ Sec-Fetch-Site checks still apply. Not an authentication credential."},
    "Origin": {"name": "Origin", "in": "header", "required": False, "schema": string(),
        "description": "If present on a mutation, its origin must match Host using the Origin scheme. cross-site Sec-Fetch-Site is always rejected. Setup/login omit bearer token from JSON exactly when this header is present."},
    "ListLimit": {"name": "limit", "in": "query", "required": False, "schema": integer(default=200), "description": "Server clamps to 1–500; values outside that interval are not rejected.", "x-server-clamp": [1, 500]},
    "Offset": {"name": "offset", "in": "query", "required": False, "schema": integer(default=0), "description": "Server clamps to 0–10,000,000.", "x-server-clamp": [0, 10000000]},
    "EventLimit": {"name": "limit", "in": "query", "required": False, "schema": integer(default=100), "description": "Server clamps to 1–500.", "x-server-clamp": [1, 500]},
    "After": {"name": "after", "in": "query", "required": False, "schema": integer(default=0), "description": "Exclusive durable event ID; negative values are clamped to zero."},
    "MessageLimit": {"name": "limit", "in": "query", "required": False, "schema": integer(default=50), "description": "Server clamps to 1–200.", "x-server-clamp": [1, 200]},
    "Before": {"name": "before", "in": "query", "required": False, "schema": integer(minimum=0), "description": "Exclusive backward history array index. Missing uses current length; larger values clamp to length. Use next_before from prior response."},
    "IncludeMessages": {"name": "include_messages", "in": "query", "required": False, "schema": BOOL | {"default": True}, "description": "Only affects conversations: false replaces messages with message_count."},
    "Version": {"name": "version", "in": "query", "required": True, "schema": integer(), "description": "Current resource version. Required on delete; mismatch returns 409."},
    "Search": {"name": "q", "in": "query", "required": True, "schema": text(2048, nonblank=True), "description": "Nonblank UTF-8 lexical query, at most 2048 bytes."},
}

ERROR_TEXT = {
    "400": "Invalid parameters, unsupported resource kind, or business validation failure.",
    "401": "Missing, expired or invalid session. An Authorization header takes precedence over any cookie.",
    "402": "Workspace budget cannot reserve this operation.",
    "403": "Current authorization, bootstrap proof, CSRF or origin check rejected the operation.",
    "404": "Resource missing, inaccessible, wrong kind, or API route not found. Private records may be hidden as not found.",
    "409": "Stale version, changed idempotent intent, busy execution, initialized target or recovery conflict. Reload/reconcile before retrying.",
    "413": "Request JSON exceeds 1 MiB, or a visible export exceeds its configured bound.",
    "415": "A JSON body was required but Content-Type was not application/json.",
    "422": "JSON could not be deserialized into the operation's request type, including rejected unknown fields.",
    "429": "Authentication or execution capacity/rate limit reached. No Retry-After header is currently guaranteed.",
    "500": "Internal or filesystem failure. Do not infer that an external operation was rolled back.",
    "502": "Worker/provider operation failed or rejected the request.",
    "503": "Durable storage unavailable. The prior outcome may require reconciliation.",
    "504": "Database connection probe exceeded its timeout.",
}
RESPONSES = {"Error" + status: {"description": description, "content": {"application/json": {"schema": ref("Error")}}}
             for status, description in ERROR_TEXT.items()}
RESPONSES["UnexpectedError"] = {"description": "Other HTTP error in the stable JSON envelope. Error codes are extensible; unsupported methods/failing extractors are normalized at the API boundary.",
    "content": {"application/json": {"schema": ref("Error"), "example": {"error": {"code": "invalid_request", "message": "Invalid request"}}}}}

def parameter(name):
    return {"$ref": "#/components/parameters/" + name}


def operation(path, method, handler, summary, description, response=None, body=None,
              public=False, tag="Resources", query=(), errors=(), example=None, request_examples=None,
              status="200", cookie=False, source="src/api.rs", operation_id=None):
    full = path if path.startswith("/health/") else "/api/v1" + path
    item = PATHS.setdefault(full, {})
    if "parameters" not in item:
        names = {"wid": "WorkspaceId", "id": "ResourceId", "uid": "UserId", "kind": "ResourceKind"}
        parameters = [parameter(names[name]) for name in re.findall(r"\{([^}]+)\}", full)]
        if parameters:
            item["parameters"] = parameters
    mutation = method not in ["get", "head", "options"]
    op = {"operationId": operation_id or handler, "summary": summary, "description": description, "tags": [tag],
          "security": [] if public else ([{"bearerAuth": []}, {"sessionCookie": [], "csrfHeader": []}] if mutation else [{"bearerAuth": []}, {"sessionCookie": []}]),
          "responses": {}, "x-handler": source + "::" + handler}
    params = [parameter(name) for name in query]
    if mutation:
        params += [parameter("CsrfHeader"), parameter("Origin")]
        op["x-csrf"] = "Required even for public setup/login unless Authorization starts with Bearer; cross-site/origin checks also apply to bearer requests."
    if params:
        op["parameters"] = params
    if body:
        media = {"schema": ref(body)}
        if request_examples:
            media["examples"] = {name: {"summary": "Illustrative, no real credentials or IDs", "value": value} for name, value in request_examples.items()}
        op["requestBody"] = {"required": True, "description": "UTF-8 JSON, maximum total body 1 MiB. Byte-length limits are annotated separately from JSON Schema character counts.", "content": {"application/json": media}}
    success = {"description": "Request succeeded." if status == "200" else "Operation accepted/completed with no response body."}
    if response:
        success["content"] = {"application/json": {"schema": ref(response)}}
        if example is not None:
            success["content"]["application/json"]["example"] = example
    if cookie:
        success["headers"] = {"Set-Cookie": {"description": "rstrbot_session; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800 for a new session or 0 for logout. Secure is conditional on server configuration.", "schema": string()}}
    op["responses"][status] = success
    codes = set(errors)
    if not public:
        codes.update(["401", "403", "503"])
    if query:
        codes.add("400")
    if mutation:
        codes.add("403")
    if body:
        codes.update(["400", "413", "415", "422"])
    for code in sorted(codes):
        op["responses"][code] = {"$ref": "#/components/responses/Error" + code}
    op["responses"]["default"] = {"$ref": "#/components/responses/UnexpectedError"}
    item[method] = op


uid = "11111111-1111-4111-8111-111111111111"
wid = "22222222-2222-4222-8222-222222222222"
rid = "33333333-3333-4333-8333-333333333333"
modelid = "44444444-4444-4444-8444-444444444444"
user_example = {"id": uid, "username": "example_user", "instance_admin": False}
session_example = {"user": user_example, "expires_at": 1793404800}
workspace_example = {"id": wid, "name": "Example workspace", "role": "owner", "created_at": 1792800000}
resource_examples = {
    "conversation": {"visibility": "private", "data": {"title": "Example conversation", "system_prompt": "Be concise."}},
    "model": {"visibility": "workspace", "data": {"name": "Diagnostic fixture", "provider": "diagnostic", "model": "diagnostic", "max_tokens": 256}},
    "plugin": {"visibility": "workspace", "data": {"name": "Diagnostic tools", "package_id": "diagnostic", "enabled": True, "config": {}}},
    "knowledge": {"visibility": "private", "data": {"title": "Example note", "text": "This example contains no personal data."}},
    "memory": {"visibility": "private", "data": {"title": "Reply preference", "content": "Use concise answers.", "enabled": True}},
    "schedule": {"visibility": "private", "data": {"title": "Example interval", "prompt": "Summarize my authorized notes.", "model_id": modelid, "conversation_id": rid, "schedule_type": "interval", "interval_seconds": 3600, "enabled": False}},
    "route": {"visibility": "private", "data": {"name": "Example destination", "url": "https://receiver.example/messages", "enabled": False}},
    "agent": {"visibility": "private", "data": {"name": "Example assistant", "system_prompt": "Use authorized notes.", "max_steps": 4}}
}
conversation_example = {"id": rid, "workspace_id": wid, "owner_id": uid, "kind": "conversations", "visibility": "private", "version": 1,
    "data": {"title": "Example conversation", "system_prompt": "", "generation": 0, "messages": []}, "created_at": 1792800000, "updated_at": 1792800000}
budget_example = {"workspace_id": wid, "limit_microusd": None, "spent_microusd": 0, "reserved_microusd": 0, "unknown_reservations": 0}

operation("/setup", "get", "setup_status", "Read initialization status", "Public status only; does not disclose bootstrap proof or database credentials.", "SetupStatus", public=True, tag="Setup", errors=["503"],
    example={"initialized": False, "database": "sqlite", "valkey": False, "valkey_status": "disabled", "version": VERSION, "database_selection": True})
operation("/setup", "post", "setup", "Initialize the instance once", "Creates first administrator/workspace atomically, consumes the unexpired local proof and sets a session. Rejects an initialized instance. Browser-facing requests must send X-RstrBot-Request: 1. The illustrated session response assumes Origin is present.", "SessionResponse", "SetupInput", public=True, tag="Setup", errors=["409", "429", "503"], cookie=True, example=session_example | {"user": user_example | {"instance_admin": True}},
    request_examples={"localProof": {"token": "0" * 64, "username": "example_user", "password": "example-only-not-a-secret", "workspace": "Example workspace"}})
operation("/setup/test-database", "post", "test_database", "Probe a database without migration", "Bootstrap proof required; current instance must be uninitialized. Opens a read-only probe, identifies schema and initialized state, does not select or migrate the database. An unrelated existing schema cannot be selected.", "DatabaseProbe", "DatabaseInput", public=True, tag="Setup", errors=["409", "503", "504"],
    example={"connected": True, "database": "postgresql", "initialized": False, "can_select": True, "read_only_probe": True}, request_examples={"emptyPostgres": {"token": "0" * 64, "database_url": "postgresql://example_user@localhost/example_database"}})
operation("/setup/database", "post", "select_database", "Select an uninitialized database", "Bootstrap proof required. Rejects initialized/unrelated target schemas, then initializes the RstrBot schema, persists configuration and swaps the active store. It does not import or overwrite a populated instance.", "DatabaseSelected", "DatabaseInput", public=True, tag="Setup", errors=["409", "500", "503", "504"], example={"database": "postgresql", "selected": True}, request_examples={"emptyPostgres": {"token": "0" * 64, "database_url": "postgresql://example_user@localhost/example_database"}})
operation("/auth/login", "post", "login", "Sign in to a local account", "Rate limited. Sets an HttpOnly cookie. JSON includes bearer token exactly when Origin is absent; clients must not infer browser detection from User-Agent.", "SessionResponse", "LoginInput", public=True, tag="Authentication", errors=["401", "429", "503"], cookie=True, example=session_example, request_examples={"credentials": {"username": "example_user", "password": "example-only-not-a-secret"}})
operation("/auth/logout", "post", "logout", "Revoke the presented session", "Uses the presented bearer token or exact session cookie, revokes it, and expires the browser cookie. This is session logout, not account deletion.", tag="Authentication", status="204", cookie=True)
operation("/auth/me", "get", "me", "Read current account", "Authenticates the presented session against current account state.", "UserResponse", tag="Authentication", example={"user": user_example})
operation("/auth/password", "post", "change_password", "Change the local account password", "Requires the current password and a valid session; revokes all sessions for this account. Sign in again after success. Password hashing is rate/capacity limited.", body="PasswordInput", tag="Authentication", status="204", errors=["429"], request_examples={"change": {"current_password": "old-example-not-a-secret", "new_password": "new-example-not-a-secret"}})
operation("/auth/options", "get", "options", "Read available sign-in methods", "Returns public capability flags and the configured origin/RP only. IP origins cannot enable WebAuthn; use localhost or an HTTPS domain. Does not expose OAuth or mail credentials.", "AuthOptions", public=True, tag="Authentication", source="src/identity_config.rs")
operation("/auth/security", "get", "security", "Read this account's sign-in methods", "Returns verified email, Google bindings and redacted passkey metadata. Backup flags come from verified authenticator data and do not identify a cloud provider. No private keys or WebAuthn verifier state are returned.", "AccountSecurity", tag="Authentication", source="src/identity.rs")
operation("/auth/reauth", "post", "reauthenticate", "Confirm the current password", "Refreshes the five-minute recent-authentication window for this specific active session. Does not create another session or extend the absolute session lifetime. Failed proof does not revoke the current session.", "RecentAuthentication", "PasswordReauth", tag="Authentication", errors=["429"], source="src/identity.rs")
operation("/auth/passkeys/register/options", "post", "register_options", "Start passkey registration or replacement", "Requires a current recently authenticated session. Server stores expiring one-use verifier state bound to this session, account and configuration revision. Replacement preserves the old credential until the new registration commits. No authenticator attachment is forced; physical FIDO2 UV-capable keys and synced credentials are accepted.", "PasskeyOptions", "PasskeyRegistrationInput", tag="Authentication", errors=["409", "429"], source="src/identity.rs")
operation("/auth/passkeys/register/finish", "post", "register_finish", "Complete passkey registration", "Verifies the browser ceremony, then atomically adds the credential and optionally removes the replaced one. Requires the original active recently authenticated session. A failed or cancelled ceremony cannot remove the old credential.", "PasskeyResponse", "PasskeyFinishInput", tag="Authentication", errors=["409", "429"], source="src/identity.rs")
operation("/auth/passkeys/login/options", "post", "login_options", "Start account-first passkey sign-in", "Accepts a username or explicitly verified email. Existing credential allow-list is scoped to that account. One-use verifier state expires after five minutes. Credential IDs and browser prompts are not themselves proof of authentication.", "PasskeyOptions", "PasskeyLoginInput", public=True, tag="Authentication", errors=["401", "429", "503"], source="src/identity.rs")
operation("/auth/passkeys/login/finish", "post", "login_finish", "Sign in using a verified passkey assertion", "Verifies RP/origin/challenge/signature/user verification, then rechecks the enabled account, credential version and configuration under database locks before issuing a session. A removed or replaced credential cannot revive a stale assertion.", "SessionResponse", "PasskeyFinishInput", public=True, cookie=True, tag="Authentication", errors=["401", "409", "429", "503"], source="src/identity.rs")
operation("/auth/passkeys/reauth/options", "post", "reauth_options", "Start passkey confirmation for this session", "Uses only passkeys bound to the current account, with single-use state bound to the original session.", "PasskeyOptions", tag="Authentication", errors=["429"], source="src/identity.rs")
operation("/auth/passkeys/reauth/finish", "post", "reauth_finish", "Confirm this session using a passkey", "Fresh verified assertion updates only this session's recent-authentication window. Revoked sessions and stale credential versions remain invalid.", "RecentAuthentication", "PasskeyFinishInput", tag="Authentication", errors=["409", "429"], source="src/identity.rs")
operation("/auth/passkeys/{id}", "patch", "rename", "Rename a bound passkey", "Requires current recently authenticated account ownership. The name is a user label, not an attested authenticator vendor.", "PasskeyResponse", "PasskeyRenameInput", tag="Authentication", errors=["404"], source="src/identity.rs", operation_id="rename_passkey")
operation("/auth/passkeys/{id}", "delete", "remove", "Remove one bound passkey", "Requires current recently authenticated account ownership and preserves at least one usable sign-in method. Sessions issued using the removed credential are revoked.", tag="Authentication", status="204", errors=["400", "404"], source="src/identity.rs", operation_id="remove_passkey")
operation("/auth/google/start", "post", "start", "Start Google sign-in or binding", "Authorization-code OIDC with state, nonce, PKCE S256 and an independent HttpOnly SameSite=Lax browser-binding cookie. Link requires recent password/passkey confirmation. Google sign-in only accepts previously explicitly linked identities; no registration or account merge by email. A Google login session must confirm a local password or passkey before sensitive account changes.", "GoogleStartResponse", "GoogleStartInput", public=True, tag="Authentication", errors=["401", "429", "503"], source="src/identity/google.rs", operation_id="google_start")
operation("/auth/google/callback", "get", "callback", "Finish the Google authorization-code callback", "Consumes the one-use intent and validates its browser binding before any token exchange. Uses fixed Google endpoints and verifies JWT signature, issuer, audience, authorized presenter, lifetime and nonce. Rechecks the original session for account changes; errors redirect to /?auth=failed without provider details or credentials.", public=True, tag="Authentication", status="303", source="src/identity/google.rs", operation_id="google_callback")
google_callback = PATHS["/api/v1/auth/google/callback"]["get"]
google_callback["parameters"] = [{"name": name, "in": "query", "required": False, "schema": string(), "description": "Provider callback value; never log."} for name in ["state", "code", "error"]]
google_callback["responses"]["303"] = {"description": "Redirect to the same-origin application with a success/failure indicator. Clears the short-lived OAuth cookie.", "headers": {"Location": {"schema": string(), "description": "Fixed same-origin return path."}, "Set-Cookie": {"schema": string(), "description": "Clears the OAuth binding and may set the normal HttpOnly Strict session cookie."}}}
operation("/auth/google/unlink", "post", "unlink", "Remove a Google identity binding", "Requires a current recently authenticated owner session, revokes sessions issued by that identity and preserves another usable sign-in method.", body="GoogleUnlinkInput", tag="Authentication", status="204", errors=["400", "404"], source="src/identity/google.rs", operation_id="google_unlink")
operation("/auth/email/start", "post", "start_email", "Send an email verification link", "Current recent authentication required. Delivers through saved SMTP settings; response never contains the verification token. Pending replacement leaves the prior verified email active. Rate limited per account, including hourly/daily caps.", "EmailPending", "EmailInput", tag="Authentication", errors=["409", "429", "502"], source="src/email_auth.rs")
operation("/auth/email/verify", "post", "verify_email", "Confirm a pending email binding", "Requires the original active session and one-use 15-minute token from the mail fragment. Atomically confirms the new address and invalidates stale recovery requests. Merely opening a GET link never binds an email.", "VerifiedEmail", "EmailVerifyInput", tag="Authentication", errors=["409", "429"], source="src/email_auth.rs")
operation("/auth/password/reset/request", "post", "request_reset", "Request email password recovery", "Uses only an explicitly verified address. Existing, unknown and delivery-throttled addresses receive the same accepted response. Mail delivery is asynchronous; acceptance does not promise delivery. Public/global request limiting can still return 429.", "EmailAccepted", "EmailInput", public=True, tag="Authentication", errors=["429", "503"], source="src/email_auth.rs")
operation("/auth/password/reset/finish", "post", "finish_reset", "Reset a password using verified email", "Consumes a valid single-use 15-minute token, checks the exact password/email version captured at issuance, changes the password and revokes all account sessions/challenges. Stale recovery cannot overwrite a newer password or email change.", body="EmailResetInput", public=True, tag="Authentication", status="204", errors=["429", "503"], source="src/email_auth.rs")
operation("/admin/auth-settings", "get", "settings", "Read redacted authentication configuration", "Instance administrator only. Shows secret-presence flags instead of secret values or ciphertext; includes the exact Google redirect URI and passkey count.", "AuthSettings", tag="Administration", source="src/identity_config.rs", operation_id="read_auth_settings")
operation("/admin/auth-settings", "put", "save_settings", "Save authentication and email configuration", "Requires current recently authenticated instance administrator and matching revision. Entire configuration saves atomically. Secrets are encrypted with the installation vault; changing their destination requires replacement or explicit clearing. Origin/RP cannot change while passkeys exist. SMTP requires TLS or STARTTLS, except explicitly selected literal loopback local relay.", "AuthSettings", "AuthSettingsInput", tag="Administration", errors=["409", "429"], source="src/identity_config.rs")
operation("/admin/auth-settings/test-email", "post", "test_email", "Send a test using saved SMTP settings", "Requires current recently authenticated instance administrator. Sends one real message to the supplied address through the already saved transport. No credentials or message bodies are logged. A successful result means the SMTP server accepted the message.", "EmailAccepted", "EmailInput", tag="Administration", errors=["429", "502"], source="src/email_auth.rs")
operation("/admin/users", "get", "users", "List active local accounts", "Instance administrator only; returns up to 1000 active users ordered by username, without password hashes.", "UserList", tag="Administration", example={"items": [user_example]})
operation("/admin/users", "post", "create_user", "Create a local login account", "Instance administrator only. Creates a non-instance-admin account without workspace membership; membership is a separate action.", "UserResponse", "CreateUserInput", tag="Administration", errors=["409", "429"], example={"user": user_example}, request_examples={"account": {"username": "example_user", "password": "example-only-not-a-secret"}})
operation("/admin/backup", "get", "backup", "Export a sensitive consistent database snapshot", "Instance administrator only. Includes password hashes and encrypted secrets but excludes sessions, secrets.key and external state. Bounded to 256 MiB of row data and 250,000 rows per table. Restore is CLI-only.", "Backup", tag="Administration", errors=["400", "500"])
operation("/admin/recovery/complete", "post", "finish_recovery", "Explicitly leave recovery mode", "Instance administrator only. Operator must reconcile external receipts, keys and plugin state first. Does not automatically replay unknown operations or re-enable restored schedules.", tag="Administration", status="204")
operation("/workspaces", "get", "workspaces", "List current workspace memberships", "Only current active-account memberships are returned; instance admin does not implicitly become a workspace member.", "WorkspaceList", tag="Workspaces", example={"items": [workspace_example]})
operation("/workspaces", "post", "create_workspace", "Create a workspace", "Authenticated account becomes owner of the new workspace. Name is trimmed/nonblank, maximum 200 UTF-8 bytes.", "Workspace", "WorkspaceInput", tag="Workspaces", example=workspace_example, request_examples={"workspace": {"name": "Example workspace"}})
operation("/plugin-packages", "get", "plugin_packages", "List installed package metadata", "Authenticated accounts may discover operator-installed packages. Executable paths, secrets and launch configuration are not returned. Discovery is not a claim that a worker is currently running.", "PackageList", tag="Plugins", example={"items": []})
operation("/workspaces/{wid}/capabilities", "get", "capabilities", "Read effective capability status", "Current workspace membership required. supported/authorized/available are separate facts; clients must not treat navigation visibility as authorization.", "Capabilities", tag="Workspaces", example={"chat": {"supported": True, "authorized": True, "available": True, "reason": ""}, "attachments": {"supported": False, "authorized": False, "available": False, "reason": "Attachment upload and media decoding are not implemented in this release"}})
member_rules = "Workspace admin minimum. Only an owner can grant/change admin or owner roles or manage existing admins/owners. The final owner cannot be removed/demoted. A role downgrade cancels that user's active workspace execution leases."
operation("/workspaces/{wid}/members", "get", "members", "List workspace members", "Workspace admin minimum. Includes user IDs, usernames and current roles.", "MemberList", tag="Workspaces", example={"items": []})
operation("/workspaces/{wid}/members", "post", "add_member", "Add or replace workspace membership", member_rules + " This endpoint upserts a membership for an existing active local account.", "MembershipChange", "MemberInput", tag="Workspaces", errors=["400", "404"], example={"user_id": uid, "role": "member"}, request_examples={"member": {"user_id": uid, "role": "member"}})
operation("/workspaces/{wid}/members/{uid}", "patch", "edit_member", "Change an existing member's role", member_rules, "MembershipChange", "RoleInput", tag="Workspaces", errors=["400", "404"], example={"user_id": uid, "role": "viewer"}, request_examples={"role": {"role": "viewer"}})
operation("/workspaces/{wid}/members/{uid}", "delete", "remove_member", "Remove workspace membership", member_rules + " Removal cancels current execution leases and blocks subsequent API reads/sends.", tag="Workspaces", status="204", errors=["400", "404"])
write_rules = "Models/plugins/routes/agents require workspace admin; other editable kinds require member. Private resources remain creator-only, including for workspace owners. Editing another user's workspace-visible resource requires operator minimum in addition to the kind's role. "
operation("/workspaces/{wid}/resources/{kind}", "get", "list_resources", "List visible resources of one kind", "Current membership required. Filters private rows before pagination. Ordered by created_at descending then ID descending. Conversations are metadata-only. runs/deliveries can be read here.", "ResourceList", query=["ListLimit", "Offset"], errors=["400"], example={"items": []})
operation("/workspaces/{wid}/resources/{kind}", "post", "create_resource", "Create an editable resource", write_rules + "runs/deliveries are server-owned and rejected. data follows the kind-specific schema in x-resource-input-schemas. visibility defaults private and is fixed for later generic edits.", "Resource", "CreateResource", errors=["404", "409"], example=conversation_example, request_examples=resource_examples)
operation("/workspaces/{wid}/resource/{id}", "get", "resource", "Read a visible resource", "Private/inaccessible resources return not found. Secrets are recursively removed. include_messages only changes conversation representation.", "Resource", query=["IncludeMessages"], errors=["404"], example=conversation_example)
operation("/workspaces/{wid}/resource/{id}", "patch", "update_resource", "Replace editable configuration with version protection", write_rules + "Schedules are owner-editable only, including shared schedules. Compare-and-swap version is required. This is not JSON Merge Patch. Ownership/visibility cannot be changed here. Operational schedule fields and existing secrets are preserved according to their dedicated rules; plugin edits cancel old generation leases.", "Resource", "UpdateResource", errors=["404", "409"], example=conversation_example | {"version": 2}, request_examples={"title": {"version": 1, "data": {"title": "Revised conversation", "system_prompt": ""}}})
operation("/workspaces/{wid}/resource/{id}", "delete", "delete_resource", "Delete an editable resource at its current version", write_rules + "version query is required. Conversation deletion cancels active runs and removes related history/events; runs/deliveries cannot be deleted through this generic endpoint.", query=["Version"], errors=["404", "409"], status="204")
operation("/workspaces/{wid}/chat", "post", "chat", "Accept an idempotent asynchronous conversation run", "Member minimum and write access to conversation. Shared conversations require a shared agent and automatically use only shared knowledge, memories and tool instances. The original HTTP credential remains an execution lease; expiry/revocation cancels that credential's active runs. Returns HTTP 200 with run plus conversation metadata; this does not mean completion. Exact replay uses original idempotency key; do not issue a new key after uncertain HTTP transport. Recovery, active conversation or capacity may reject admission before side effects.", "ChatAccepted", "ChatRequest", tag="Execution", errors=["402", "404", "409", "429", "502"], request_examples={"message": {"conversation_id": rid, "model_id": modelid, "content": "Summarize my authorized notes.", "idempotency_key": "example-chat-intent-001"}})
operation("/workspaces/{wid}/chat/text-attachments", "post", "chat", "Accept a conversation run with UTF-8 text attachments", "Use this route for text attachments so older cores reject the request instead of silently ignoring unrecognized attachment fields. It follows the same access, idempotency and execution rules as chat.", "ChatAccepted", "ChatRequest", tag="Execution", errors=["402", "404", "409", "429", "502"], operation_id="chat_with_text_attachments", request_examples={"message": {"conversation_id": rid, "model_id": modelid, "content": "Summarize my authorized notes.", "idempotency_key": "example-chat-intent-001"}})
operation("/workspaces/{wid}/routes/{id}/send", "post", "send_route", "Send once to an explicitly authorized route", "Member minimum plus current access to the enabled route. Durable private intent is written before dispatch; repeated identical key returns saved receipt. This call waits for the bounded worker result; accepted/rejected/unknown can all be HTTP 200 resource responses. No destination/token override, autonomous scheduling, guaranteed receiver deduplication or automatic retry is implied.", "DeliveryResource", "SendRequest", tag="Delivery", errors=["404", "409", "500"], request_examples={"send": {"text": "Example delivery text", "idempotency_key": "example-delivery-intent-001"}})
operation("/workspaces/{wid}/runs/{id}", "get", "run", "Read an authorized run", "Resource must be a run in the current workspace and visible to caller.", "RunResource", tag="Execution", errors=["404"])
operation("/workspaces/{wid}/runs/{id}/cancel", "post", "cancel_run", "Request cancellation of a run", "Member minimum. Caller owns the run or has operator role on a visible shared run. Cancels the in-memory execution lease if present; 204 does not undo an already observed external effect or prove a terminal record has persisted. Poll the run/events.", tag="Execution", status="204", errors=["404"])
operation("/workspaces/{wid}/conversations/{id}/messages", "get", "messages", "Page visible conversation history backwards", "Current membership and visibility required. Returns chronological items within the selected backward page. next_before is an array index, not an event ID; null means no earlier history.", "MessagePage", tag="Execution", query=["MessageLimit", "Before"], errors=["404"], example={"items": [], "next_before": None, "total": 0})
operation("/workspaces/{wid}/conversations/{id}/reset", "post", "reset_conversation", "Reset context generation while preserving history", "Requires write access to the visible conversation. Increments generation, clears active_run and cancels that conversation's current leases. Old-generation outputs cannot become current context.", tag="Execution", status="204", errors=["400", "404", "409"])
operation("/workspaces/{wid}/conversations/{id}/branch", "post", "branch_conversation", "Fork visible history at a selected user message", "Member minimum. Creates a caller-owned conversation with the source visibility, source history before the selected user message, and replacement content appended as a new user message. Preserves that selected message's generation; does not dispatch a model call. Source remains unchanged.", "ConversationResource", "BranchInput", tag="Execution", errors=["404", "409"], request_examples={"branch": {"message_id": uid, "content": "Revised question"}})
operation("/workspaces/{wid}/models/{id}/test", "post", "test_model", "Perform a real bounded model request", "Workspace admin minimum and current visibility. Calls the configured model with a short prompt; can incur usage and reserves/settles budget. No automatic retry. diagnostic is an explicitly labeled non-AI fixture; missing usage/cost remains unknown.", "ModelTestResult", tag="Execution", errors=["400", "402", "404", "409", "429", "502"], example={"success": True, "message": {"role": "assistant", "content": "Illustrative diagnostic response"}, "usage": None, "cost_microusd": 0, "fixture": True})
operation("/workspaces/{wid}/models/discover", "post", "discover_models", "Discover model IDs from an installed provider", "Workspace admin required. Invokes only the installed provider's model.list capability; it sends no generation request and reserves no RstrBot budget, though the provider may log or charge the request. Temporary api_key values are write-only and never persisted. A saved key may be reused only for the exact same workspace resource, provider, base URL and private-network grant. HTTPS is required by default; private HTTP requires the current instance administrator and global policy. Session, role, recovery and saved-model version are rechecked before dispatch, during the call and before returning. Results contain at most 500 validated, deduplicated IDs/names. Discovery failure does not prevent manual model ID entry.", "ModelDiscoveryResult", "ModelDiscoveryInput", tag="Execution", errors=["400", "403", "404", "409", "429", "502"], example={"items": [{"id": "example-model", "name": "Example model"}], "truncated": False, "fixture": False}, request_examples={"openai_compatible": {"provider": "openai", "base_url": "https://api.example.com/v1", "allow_private_network": False}})
operation("/workspaces/{wid}/plugins/{id}/reload", "post", "reload_plugin", "Advance a plugin instance generation", "Workspace admin minimum and write access. Cancels leases using the old instance and updates its generation/status. Does not perform package download or automatically launch a persistent worker.", tag="Plugins", status="204", errors=["400", "404", "409"])
operation("/workspaces/{wid}/knowledge/search", "get", "search_knowledge", "Search authorized text chunks", "ACL-filtered lexical retrieval with bounded source scan and at most 8 hits. No vector embeddings or remote source fetching. Query is required/nonblank; only current unchanged visible sources survive final recheck.", "KnowledgeSearch", tag="Knowledge", query=["Search"], example={"items": [], "method": "lexical", "truncated": False, "limits": {"documents": 500, "scanned_source_bytes": 16777216, "results": 8}})
operation("/workspaces/{wid}/schedules/preview", "post", "preview_schedule", "Preview next calendar/interval times without dispatch", "Member minimum. Validates the same full schedule configuration and time function used by execution, but persists nothing and calls no model. Returns up to 5 future UTC times; DST gaps skipped, repeated local time uses first occurrence.", "SchedulePreview", "ScheduleInput", tag="Scheduling", request_examples={"interval": resource_examples["schedule"]["data"]})
operation("/workspaces/{wid}/schedules/{id}/run", "post", "trigger_schedule", "Manually claim and dispatch an owned schedule", "Member minimum; only the schedule creator may dispatch it. Uses durable claim and bounded chat admission. Rejects recovery/in-flight/uncertain states. This is a new deliberate manual invocation, not a safe retry mechanism for unknown prior dispatch.", "ChatAccepted", tag="Scheduling", errors=["400", "402", "404", "409", "429", "502"])
operation("/workspaces/{wid}/schedules/{id}/reconcile", "post", "reconcile_schedule", "Record review of an uncertain schedule and keep it paused", "Only the schedule owner with current member permission can acknowledge review. It records an unknown outcome and does not dispatch, send or enable. Active known runs and stale versions are rejected.", "Resource", "ReconcileScheduleInput", tag="Scheduling", errors=["404", "409", "500"])
operation("/workspaces/{wid}/events", "get", "events", "Replay authorized durable events", "Rechecks membership/private visibility on every poll. IDs are monotonically ordered but may contain gaps. cursor is last returned authorized ID, or requested nonnegative after when empty. This endpoint is JSON polling; no SSE endpoint is declared.", "EventPage", tag="Events", query=["After", "EventLimit"], example={"items": [], "cursor": 0})
operation("/workspaces/{wid}/audit", "get", "audit", "Read authorized audit metadata", "Workspace admin minimum. Same current private-resource filtering as events; every data payload is null, so private message content is not leaked through audit. No cursor field; continue after last returned event ID.", "AuditPage", tag="Events", query=["After", "EventLimit"], example={"items": []})
operation("/workspaces/{wid}/budget", "get", "budget", "Read current durable budget totals", "Current workspace membership required. Unknown reservations remain reserved; a null limit means unlimited, not zero cost.", "Budget", tag="Budget", errors=["404"], example=budget_example)
operation("/workspaces/{wid}/budget", "put", "set_budget", "Set or clear the workspace budget limit", "Workspace admin minimum. Null or omitted limit clears the cap. Configured prices and byte-based preflight estimates do not guarantee an absolute external supplier bill ceiling; actual/unknown costs are preserved honestly.", "Budget", "BudgetInput", tag="Budget", errors=["404"], example=budget_example | {"limit_microusd": 5000000}, request_examples={"limit": {"limit_microusd": 5000000}, "unlimited": {"limit_microusd": None}})
operation("/workspaces/{wid}/reservations", "get", "reservations", "Inspect recent budget reservations", "Workspace admin minimum; up to 500 reservations ordered newest first. No settlement/reconciliation mutation is exposed by this endpoint.", "ReservationList", tag="Budget", example={"items": []})
operation("/workspaces/{wid}/export", "get", "export_workspace", "Export only caller-visible sanitized resources", "Current membership required. Covers all implemented resource kinds. Bound 16 MiB/10,000 rows; larger export fails explicitly. This sequential ACL-filtered export is not a consistent disaster-recovery snapshot.", "VisibleExport", tag="Workspaces", errors=["413"], example={"format": "rstrbot-visible-resources-v1", "workspace_id": wid, "exported_by": uid, "created_at": 1792800000, "resources": [], "consistent_snapshot": False})
operation("/openapi.json", "get", "openapi", "Read the OpenAPI document", "Public API contract/discovery. For older binaries, compare the returned document with the version distributed in docs/openapi.json; a newer source file does not retrofit an already running binary.", "OpenApiDocument", public=True, tag="Discovery")
operation("/health/live", "get", "live", "Read process liveness", "Public process liveness; does not test storage or providers.", "Liveness", public=True, tag="Health", example={"status": "ok", "version": VERSION})
operation("/health/ready", "get", "ready", "Check durable storage readiness", "Public database probe with a 3-second timeout. A degraded optional cache can coexist with healthy core readiness. Does not call upstream models.", "Readiness", public=True, tag="Health", errors=["503"], example={"status": "ok", "database": "sqlite", "initialized": True, "recovery_mode": False, "valkey_status": "disabled", "checks": ["database"], "upstream_models": "not_checked"})


def build():
    return {"openapi": "3.1.0", "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "info": {"title": "RstrBot HTTP API", "version": VERSION,
            "description": "Contract for actually registered release routes. All paths are absolute from the server origin. Current JSON success bodies use HTTP 200; documented no-content operations use 204. Browser authentication uses an HttpOnly SameSite=Strict cookie; non-browser callers may use the same opaque session token as Bearer (not a separately scoped API key). Authorization headers override cookies. Every API mutation without a Bearer-prefixed Authorization requires X-RstrBot-Request: 1, including setup/login. Cross-site Sec-Fetch-Site and mismatched Origin are rejected even with Bearer. No credentialed CORS is provided. The Google callback has its own single-use state/browser binding validation before exchanging a code. JSON bodies are limited to 1 MiB; UTF-8 byte limits are described with x-max-utf8-bytes. Unknown top-level fields are rejected only where the Rust request type declares deny_unknown_fields; generic data and ChatRequest are described separately. Examples are illustrative test data, not execution evidence. Unsupported capabilities have no invented endpoints.",
            "license": {"name": "MIT", "identifier": "MIT"}},
        "servers": [{"url": "/", "description": "Same-origin deployment; all API paths include /api/v1 explicitly."}],
        "tags": [{"name": name} for name in ["Setup", "Authentication", "Administration", "Workspaces", "Resources", "Execution", "Plugins", "Delivery", "Knowledge", "Scheduling", "Events", "Budget", "Discovery", "Health"]],
        "security": [{"bearerAuth": []}, {"sessionCookie": []}],
        "paths": PATHS,
        "components": {"securitySchemes": {
            "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "opaque session token",
                "description": "Session token returned by setup/login only when Origin is absent. Not JWT/OAuth or an independent personal API key. Any Authorization header overrides cookie fallback."},
            "sessionCookie": {"type": "apiKey", "in": "cookie", "name": "rstrbot_session", "description": "HttpOnly SameSite=Strict browser session; Secure if deployment config enables it. Do not read it with frontend JavaScript."},
            "csrfHeader": {"type": "apiKey", "in": "header", "name": "X-RstrBot-Request", "description": "Literal value 1. Anti-CSRF signal, not identity; required with cookie-based API mutations."}},
            "parameters": PARAMETERS, "responses": RESPONSES, "schemas": SCHEMAS},
        "x-reviewed-sources": ["src/api.rs", "src/identity.rs", "src/identity/google.rs", "src/identity_config.rs", "src/email_auth.rs", "src/state.rs", "src/engine.rs", "src/schedule.rs", "src/delivery.rs", "src/knowledge.rs", "crates/rstrbot-store/src/lib.rs", "crates/rstrbot-store/src/resources.rs", "crates/rstrbot-store/src/auth.rs", "crates/rstrbot-store/src/identity.rs", "crates/rstrbot-store/src/workspaces.rs", "crates/rstrbot-store/src/backup.rs", "crates/rstrbot-store/src/budget.rs"],
        "x-contract-notes": ["Resource data schemas describe supported client configuration. Some serde_json::Value fields are intentionally permissive and may retain extra JSON; they are not claimed to be globally rejected.", "All permission checks occur on the server against current membership/visibility; examples and schemas do not confer authority.", "The path/method inventory covers explicitly registered handlers. Axum's implicit HEAD handling for GET routes does not create a separate business operation; OPTIONS/CORS support is not declared.", "No API endpoint performs restore, executable installation, attachment upload, arbitrary sandbox execution, legacy compatibility or autonomous agent delegation in this release."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    encoded = json.dumps(build(), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUT.exists() or OUT.read_text() != encoded:
            raise SystemExit("docs/openapi.json differs; regenerate with python3 scripts/generate_openapi.py")
        print("OpenAPI generated document is current")
    else:
        OUT.write_text(encoded)
        print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
