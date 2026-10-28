//! Same-origin HTTP boundary. Authorization is re-evaluated by the store and
//! execution services; browser visibility never grants a capability.

use crate::{
    engine::{self, ChatRequest, ModelDiscoveryRequest},
    state::{AppError, AppState, prepare_data, sanitize_resource, sanitize_value},
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, FromRequest, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rstrbot_store::{Resource, Role, Store, TokenSession, User, Visibility};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};

const COOKIE: &str = "rstrbot_session";
const RESOURCE_KINDS: &[&str] = &[
    "conversations",
    "models",
    "plugins",
    "knowledge",
    "memories",
    "schedules",
    "routes",
    "agents",
    "runs",
    "deliveries",
];
const BODY_LIMIT: usize = 1024 * 1024;
pub(crate) type ApiResult<T> = Result<T, AppError>;

/// Build the authenticated API and the bundled, same-origin web application.
pub fn router(state: AppState, web_dir: PathBuf) -> Router {
    let api = Router::new()
        .merge(crate::identity::router())
        .merge(crate::identity_config::router())
        .merge(crate::email_auth::router())
        .route("/setup", get(setup_status).post(setup))
        .route("/setup/test-database", post(test_database))
        .route("/setup/database", post(select_database))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/password", post(change_password))
        .route("/admin/users", get(users).post(create_user))
        .route("/admin/backup", get(backup))
        .route("/admin/recovery/complete", post(finish_recovery))
        .route("/workspaces", get(workspaces).post(create_workspace))
        .route("/plugin-packages", get(plugin_packages))
        .route("/workspaces/{wid}/capabilities", get(capabilities))
        .route("/workspaces/{wid}/members", get(members).post(add_member))
        .route(
            "/workspaces/{wid}/members/{uid}",
            axum::routing::patch(edit_member).delete(remove_member),
        )
        .route(
            "/workspaces/{wid}/resources/{kind}",
            get(list_resources).post(create_resource),
        )
        .route(
            "/workspaces/{wid}/resource/{id}",
            get(resource).patch(update_resource).delete(delete_resource),
        )
        .route("/workspaces/{wid}/chat", post(chat))
        .route("/workspaces/{wid}/routes/{id}/send", post(send_route))
        .route("/workspaces/{wid}/runs/{id}", get(run))
        .route("/workspaces/{wid}/runs/{id}/cancel", post(cancel_run))
        .route(
            "/workspaces/{wid}/conversations/{id}/messages",
            get(messages),
        )
        .route(
            "/workspaces/{wid}/conversations/{id}/reset",
            post(reset_conversation),
        )
        .route(
            "/workspaces/{wid}/conversations/{id}/branch",
            post(branch_conversation),
        )
        .route("/workspaces/{wid}/models/{id}/test", post(test_model))
        .route("/workspaces/{wid}/models/discover", post(discover_models))
        .route("/workspaces/{wid}/plugins/{id}/reload", post(reload_plugin))
        .route("/workspaces/{wid}/knowledge/search", get(search_knowledge))
        .route(
            "/workspaces/{wid}/schedules/preview",
            post(preview_schedule),
        )
        .route(
            "/workspaces/{wid}/schedules/{id}/run",
            post(trigger_schedule),
        )
        .route(
            "/workspaces/{wid}/schedules/{id}/reconcile",
            post(reconcile_schedule),
        )
        .route("/workspaces/{wid}/events", get(events))
        .route("/workspaces/{wid}/audit", get(audit))
        .route("/workspaces/{wid}/budget", get(budget).put(set_budget))
        .route("/workspaces/{wid}/reservations", get(reservations))
        .route("/workspaces/{wid}/export", get(export_workspace))
        .route("/openapi.json", get(openapi))
        .fallback(api_not_found)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(Extension(Arc::new(LoginGate::new())));
    Router::new()
        .nest("/api/v1", api)
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .fallback_service(
            ServeDir::new(&web_dir).not_found_service(ServeFile::new(web_dir.join("index.html"))),
        )
        .layer(CompressionLayer::new())
        .layer(middleware::from_fn(request_boundary))
        .with_state(state)
}

/// Convert JSON extraction errors into the same stable envelope as domain errors.
pub(crate) struct Payload<T>(pub(crate) T);
impl<T: DeserializeOwned + Send> FromRequest<AppState> for Payload<T> {
    type Rejection = AppError;
    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(body)| Self(body))
            .map_err(|error| {
                let status = error.status();
                AppError::new(
                    status,
                    "invalid_json",
                    if status == StatusCode::PAYLOAD_TOO_LARGE {
                        "Request body exceeds 1 MiB"
                    } else {
                        "Request body is not valid JSON for this operation"
                    },
                )
            })
    }
}

async fn request_boundary(request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let unsafe_method = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if is_api && unsafe_method {
        let headers = request.headers();
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.starts_with("Bearer "));
        if (!bearer
            && headers
                .get("x-rstrbot-request")
                .and_then(|h| h.to_str().ok())
                != Some("1"))
            || headers.get("sec-fetch-site").and_then(|h| h.to_str().ok()) == Some("cross-site")
        {
            return AppError::new(
                StatusCode::FORBIDDEN,
                "csrf_rejected",
                "Use a same-origin request with X-RstrBot-Request: 1",
            )
            .into_response();
        }
        if let Some(origin) = headers.get(header::ORIGIN) {
            let valid = origin
                .to_str()
                .ok()
                .and_then(|v| url::Url::parse(v).ok())
                .zip(headers.get(header::HOST).and_then(|h| h.to_str().ok()))
                .is_some_and(|(origin, host)| {
                    url::Url::parse(&format!("{}://{host}", origin.scheme()))
                        .is_ok_and(|target| target.origin() == origin.origin())
                });
            if !valid {
                return AppError::new(
                    StatusCode::FORBIDDEN,
                    "origin_rejected",
                    "Cross-origin mutations are not allowed",
                )
                .into_response();
            }
        }
    }
    let mut response = next.run(request).await;
    if is_api
        && response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json"))
    {
        let status = response.status();
        response = AppError::new(
            status,
            "invalid_request",
            status.canonical_reason().unwrap_or("Invalid request"),
        )
        .into_response();
    }
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"));
    if is_api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

pub(crate) fn token(headers: &HeaderMap) -> ApiResult<String> {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        return value
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| rstrbot_store::Error::Unauthorized.into());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == COOKIE).then(|| value.to_owned()))
        .ok_or_else(|| rstrbot_store::Error::Unauthorized.into())
}

pub(crate) async fn actor(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    Ok(state.store().await.authenticate(&token(headers)?).await?)
}

pub(crate) async fn session_response(
    state: &AppState,
    headers: &HeaderMap,
    session: TokenSession,
) -> ApiResult<Response> {
    let secure = if crate::identity_config::cookie_is_secure(state).await? {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{secure}",
        session.token
    );
    let mut data = json!({"user": session.user, "expires_at": session.expires_at});
    // CLI callers need a bearer token; the browser uses only the HttpOnly cookie.
    if !headers.contains_key(header::ORIGIN) {
        data["token"] = json!(session.token);
    }
    let mut response = Json(data).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| AppError::internal("Session cookie could not be encoded"))?,
    );
    Ok(response)
}

pub(crate) struct LoginGate {
    attempts: Mutex<HashMap<String, VecDeque<Instant>>>,
    concurrent: Arc<Semaphore>,
}
impl LoginGate {
    fn new() -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            concurrent: Arc::new(Semaphore::new(4)),
        }
    }
    pub(crate) fn enter(&self, username: &str) -> ApiResult<OwnedSemaphorePermit> {
        if username.len() > 254 {
            return Err(AppError::bad_request("Sign-in identifier is too long"));
        }
        let now = Instant::now();
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| AppError::internal("Authentication rate limiter is unavailable"))?;
        attempts.retain(|_, values| {
            values.retain(|time| now.duration_since(*time) < Duration::from_secs(60));
            !values.is_empty()
        });
        let key = username.trim().to_lowercase();
        if attempts.values().map(VecDeque::len).sum::<usize>() >= 120
            || attempts.get(&key).is_some_and(|v| v.len() >= 12)
            || (!attempts.contains_key(&key) && attempts.len() >= 256)
        {
            return Err(AppError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many sign-in attempts. Try again in one minute",
            ));
        }
        attempts.entry(key).or_default().push_back(now);
        drop(attempts);
        self.concurrent.clone().try_acquire_owned().map_err(|_| {
            AppError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "authentication_busy",
                "Authentication capacity is busy; retry shortly",
            )
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginInput {
    username: String,
    password: String,
}
async fn login(
    State(state): State<AppState>,
    Extension(gate): Extension<Arc<LoginGate>>,
    headers: HeaderMap,
    Payload(body): Payload<LoginInput>,
) -> ApiResult<Response> {
    if body.username.len() > 254 || body.password.len() > 1024 {
        return Err(rstrbot_store::Error::Unauthorized.into());
    }
    let _permit = gate.enter(&body.username)?;
    let session = state
        .store()
        .await
        .login(&body.username, &body.password)
        .await?;
    session_response(&state, &headers, session).await
}
async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"user":actor(&state,&headers).await?})))
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    state.store().await.revoke(&token(&headers)?).await?;
    let secure = if crate::identity_config::cookie_is_secure(&state).await? {
        "; Secure"
    } else {
        ""
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
        ))
        .map_err(|_| AppError::internal("Session cookie could not be cleared"))?,
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordInput {
    current_password: String,
    new_password: String,
}
async fn change_password(
    State(state): State<AppState>,
    Extension(gate): Extension<Arc<LoginGate>>,
    headers: HeaderMap,
    Payload(body): Payload<PasswordInput>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    let _permit = gate.enter(&user.username)?;
    state
        .store()
        .await
        .change_password(&user, &body.current_password, &body.new_password)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let store = state.store().await;
    let config = state.config.read().await;
    Ok(Json(
        json!({"initialized":store.initialized().await?,"database":store.backend(),"valkey":config.valkey_url.is_some(),"valkey_status":*state.cache_status.read().await,"version":env!("CARGO_PKG_VERSION"),"database_selection":true}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupInput {
    token: String,
    username: String,
    password: String,
    workspace: String,
}
async fn setup(
    State(state): State<AppState>,
    Extension(gate): Extension<Arc<LoginGate>>,
    headers: HeaderMap,
    Payload(body): Payload<SetupInput>,
) -> ApiResult<Response> {
    let mut bootstrap = state.bootstrap.lock().await;
    let store = state.store().await;
    if store.initialized().await? {
        return Err(AppError::conflict("This instance is already initialized"));
    }
    if !bootstrap.check(&body.token) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "invalid_setup_token",
            "The setup token is invalid or expired; restart the uninitialized server to issue a new token",
        ));
    }
    let _permit = gate.enter(&body.username)?;
    let session = store
        .bootstrap(&body.username, &body.password, &body.workspace)
        .await?;
    bootstrap.token.clear();
    let token_path = state.config.read().await.data_dir.join("bootstrap.token");
    let _ = tokio::fs::remove_file(token_path).await;
    drop(bootstrap);
    session_response(&state, &headers, session).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DatabaseInput {
    token: String,
    database_url: String,
}
async fn database_target(
    state: &AppState,
    body: &DatabaseInput,
) -> ApiResult<rstrbot_store::Probe> {
    if body.database_url.len() > 4096
        || !(body.database_url.starts_with("sqlite:")
            || body.database_url.starts_with("postgres://")
            || body.database_url.starts_with("postgresql://"))
    {
        return Err(AppError::bad_request(
            "Choose a SQLite or PostgreSQL connection",
        ));
    }
    if state.store().await.initialized().await? {
        return Err(AppError::conflict(
            "Database selection is only available before initialization",
        ));
    }
    tokio::time::timeout(Duration::from_secs(12), Store::probe(&body.database_url))
        .await
        .map_err(|_| {
            AppError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "database_timeout",
                "Database connection timed out",
            )
        })?
        .map_err(AppError::from)
}
async fn test_database(
    State(state): State<AppState>,
    Payload(body): Payload<DatabaseInput>,
) -> ApiResult<Json<Value>> {
    let bootstrap = state.bootstrap.lock().await;
    if !bootstrap.check(&body.token) {
        return Err(AppError::forbidden());
    }
    let target = database_target(&state, &body).await?;
    let initialized = target.initialized;
    let backend = target.backend;
    Ok(Json(
        json!({"connected":true,"database":backend,"initialized":initialized,"can_select":!initialized&&(!target.has_user_tables||target.rstrbot_schema),"read_only_probe":true}),
    ))
}
async fn select_database(
    State(state): State<AppState>,
    Payload(body): Payload<DatabaseInput>,
) -> ApiResult<Json<Value>> {
    let bootstrap = state.bootstrap.lock().await;
    if !bootstrap.check(&body.token) {
        return Err(AppError::forbidden());
    }
    let probe = database_target(&state, &body).await?;
    if probe.initialized || (probe.has_user_tables && !probe.rstrbot_schema) {
        return Err(AppError::conflict(
            "The target already contains an initialized instance or unrelated tables; use an empty database and preserve the original",
        ));
    }
    let target = Store::connect(&body.database_url).await?;
    let backend = target.backend();
    let mut config = state.config.write().await;
    let previous = config.database_url.clone();
    config.database_url = body.database_url;
    if let Err(error) = config.save() {
        config.database_url = previous;
        target.close().await;
        return Err(error);
    }
    let old = std::mem::replace(&mut *state.db.write().await, target);
    old.close().await;
    Ok(Json(json!({"database":backend,"selected":true})))
}

async fn users(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        json!({"items":state.store().await.users(&user).await?}),
    ))
}
async fn create_user(
    State(state): State<AppState>,
    Extension(gate): Extension<Arc<LoginGate>>,
    headers: HeaderMap,
    Payload(body): Payload<LoginInput>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let _permit = gate.enter(&body.username)?;
    Ok(Json(
        json!({"user":state.store().await.create_user(&user,&body.username,&body.password).await?}),
    ))
}
async fn workspaces(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        json!({"items":state.store().await.workspaces(&user.id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceInput {
    name: String,
}
async fn create_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(body): Payload<WorkspaceInput>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(serde_json::to_value(
        state
            .store()
            .await
            .create_workspace(&user.id, &body.name)
            .await?,
    )?))
}
async fn members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        json!({"items":state.store().await.members(&wid,&user.id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberInput {
    user_id: String,
    role: Role,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleInput {
    role: Role,
}
async fn add_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Payload(body): Payload<MemberInput>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    let previous = store.membership(&wid, &body.user_id).await.ok();
    store
        .set_member(&wid, &user.id, &body.user_id, body.role)
        .await?;
    if previous.is_some_and(|role| role > body.role) {
        cancel_user_leases(&state, &wid, &body.user_id).await;
    }
    Ok(Json(json!({"user_id":body.user_id,"role":body.role})))
}
async fn edit_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, uid)): Path<(String, String)>,
    Payload(body): Payload<RoleInput>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    let previous = store.membership(&wid, &uid).await?;
    store.set_member(&wid, &user.id, &uid, body.role).await?;
    if previous > body.role {
        cancel_user_leases(&state, &wid, &uid).await;
    }
    Ok(Json(json!({"user_id":uid,"role":body.role})))
}
async fn remove_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, uid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    state
        .store()
        .await
        .remove_member(&wid, &user.id, &uid)
        .await?;
    cancel_user_leases(&state, &wid, &uid).await;
    Ok(StatusCode::NO_CONTENT)
}
async fn cancel_user_leases(state: &AppState, wid: &str, uid: &str) {
    for run in state.runs.lock().await.values() {
        if run.workspace_id == wid && run.user_id == uid {
            run.token.cancel();
        }
    }
}

#[derive(Deserialize, Default)]
struct PageQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    after: Option<i64>,
    before: Option<usize>,
    version: Option<i64>,
    q: Option<String>,
    include_messages: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateResource {
    #[serde(default = "private")]
    visibility: Visibility,
    data: Value,
}
fn private() -> Visibility {
    Visibility::Private
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateResource {
    version: i64,
    data: Value,
}
fn kind_check(kind: &str, write: bool) -> ApiResult<()> {
    if !RESOURCE_KINDS.contains(&kind) || (write && matches!(kind, "runs" | "deliveries")) {
        Err(AppError::bad_request(
            "Resource type is unsupported or read-only",
        ))
    } else {
        Ok(())
    }
}
fn minimum_role(kind: &str) -> Role {
    if matches!(kind, "models" | "plugins" | "routes" | "agents") {
        Role::Admin
    } else {
        Role::Member
    }
}
fn reject_server_fields(kind: &str, data: &Value) -> ApiResult<()> {
    if kind == "conversations"
        && ["messages", "generation"]
            .iter()
            .any(|key| data.get(key).is_some())
    {
        return Err(AppError::bad_request(
            "Conversation messages and generation are server-owned; use the chat and reset operations",
        ));
    }
    Ok(())
}
async fn list_resources(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, kind)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    kind_check(&kind, false)?;
    let records = state
        .store()
        .await
        .list_resources(
            &wid,
            &user.id,
            &kind,
            page.limit.unwrap_or(200),
            page.offset.unwrap_or(0),
        )
        .await?;
    Ok(Json(json!({"items":records.into_iter().map(|record| {
        let mut record = sanitize_resource(record);
        if record.kind == "conversations" { conversation_metadata(&mut record.data); }
        record
    }).collect::<Vec<_>>()})))
}
async fn resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    let mut record = sanitize_resource(
        state
            .store()
            .await
            .get_resource(&wid, &user.id, &id)
            .await?,
    );
    if record.kind == "conversations" && page.include_messages == Some(false) {
        conversation_metadata(&mut record.data);
    }
    Ok(Json(record))
}

fn conversation_metadata(data: &mut Value) {
    if let Some(object) = data.as_object_mut() {
        let count = object
            .remove("messages")
            .and_then(|value| value.as_array().map(Vec::len))
            .unwrap_or(0);
        object.insert("message_count".into(), json!(count));
    }
}
async fn create_resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, kind)): Path<(String, String)>,
    Payload(body): Payload<CreateResource>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    kind_check(&kind, true)?;
    reject_server_fields(&kind, &body.data)?;
    let store = state.store().await;
    store
        .require_role(&wid, &user.id, minimum_role(&kind))
        .await?;
    let data = prepare_data(&state, &user, &kind, body.data, None).await?;
    let record = store
        .create_resource(&wid, &user.id, &kind, body.visibility, data)
        .await?;
    Ok(Json(sanitize_resource(record)))
}
async fn update_resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Payload(body): Payload<UpdateResource>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    let previous = store.get_resource(&wid, &user.id, &id).await?;
    kind_check(&previous.kind, true)?;
    reject_server_fields(&previous.kind, &body.data)?;
    store
        .require_role(&wid, &user.id, minimum_role(&previous.kind))
        .await?;
    let requested_enable =
        previous.kind == "schedules" && body.data.get("enabled") == Some(&Value::Bool(true));
    let mut data = prepare_data(&state, &user, &previous.kind, body.data, Some(&previous)).await?;
    if previous.kind == "schedules" {
        if requested_enable && data["enabled"] != true {
            return Err(AppError::new(
                axum::http::StatusCode::BAD_REQUEST,
                "schedule_future_time_required",
                "Choose a future time before enabling this schedule",
            ));
        }
        if matches!(
            previous.data["status"].as_str(),
            Some("unknown" | "needs_reconciliation")
        ) && data["enabled"] == true
        {
            return Err(AppError::conflict(
                "Reconcile this schedule's uncertain result before enabling it",
            ));
        }
        for key in crate::schedule::protected_fields() {
            if let Some(value) = previous.data.get(*key) {
                data[*key] = value.clone();
            }
        }
        if previous.data["enabled"] != data["enabled"]
            && !matches!(
                previous.data["status"].as_str(),
                Some("dispatching" | "running" | "queued" | "unknown" | "needs_reconciliation")
            )
        {
            data["status"] = if data["enabled"] == true {
                "scheduled"
            } else {
                "paused"
            }
            .into();
        }
    }
    let record = store
        .update_resource(&wid, &user.id, &id, body.version, data)
        .await?;
    if previous.kind == "plugins" {
        cancel_plugin_leases(&state, &wid, &id).await;
    }
    Ok(Json(sanitize_resource(record)))
}
async fn delete_resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    let record = store.get_resource(&wid, &user.id, &id).await?;
    kind_check(&record.kind, true)?;
    let role = store
        .require_role(&wid, &user.id, minimum_role(&record.kind))
        .await?;
    if record.owner_id != user.id && role < Role::Operator {
        return Err(AppError::forbidden());
    }
    let version = page.version.ok_or_else(|| {
        AppError::bad_request("DELETE requires the current version query parameter")
    })?;
    if version != record.version {
        return Err(AppError::conflict(
            "The record changed; reload before deleting",
        ));
    }
    if record.kind == "conversations" {
        for run in state.runs.lock().await.values() {
            if run.workspace_id == wid && run.conversation_id == id {
                run.token.cancel();
            }
        }
        store
            .delete_conversation(&wid, &user.id, &id, version)
            .await?;
    } else {
        store.delete_resource(&wid, &user.id, &id, version).await?;
        if record.kind == "plugins" {
            cancel_plugin_leases(&state, &wid, &id).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn cancel_plugin_leases(state: &AppState, wid: &str, id: &str) {
    for run in state.runs.lock().await.values() {
        if run.workspace_id == wid && run.plugin_ids.iter().any(|p| p == id) {
            run.token.cancel();
        }
    }
}

async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Payload(body): Payload<ChatRequest>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let mut result = engine::start_authenticated(state, user, wid, body, token(&headers)?).await?;
    if let Some(data) = result
        .get_mut("conversation")
        .and_then(|conversation| conversation.get_mut("data"))
    {
        conversation_metadata(data);
    }
    Ok(Json(result))
}
async fn run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    let record = state
        .store()
        .await
        .get_resource(&wid, &user.id, &id)
        .await?;
    if record.kind != "runs" {
        return Err(rstrbot_store::Error::NotFound.into());
    }
    Ok(Json(sanitize_resource(record)))
}
async fn cancel_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    engine::cancel(state, &user, &wid, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn reset_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    engine::reset(state, &user, &wid, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BranchInput {
    message_id: String,
    content: String,
}
async fn branch_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Payload(body): Payload<BranchInput>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(sanitize_resource(
        engine::branch(state, &user, &wid, &id, &body.message_id, &body.content).await?,
    )))
}
async fn messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let record = state
        .store()
        .await
        .get_resource(&wid, &user.id, &id)
        .await?;
    if record.kind != "conversations" {
        return Err(rstrbot_store::Error::NotFound.into());
    }
    let empty = Vec::new();
    let list = record.data["messages"].as_array().unwrap_or(&empty);
    let end = page.before.unwrap_or(list.len()).min(list.len());
    let start = end.saturating_sub(page.limit.unwrap_or(50).clamp(1, 200) as usize);
    let mut selected = Value::Array(list[start..end].to_vec());
    sanitize_value(&mut selected);
    Ok(Json(
        json!({"items":selected,"next_before":if start==0{None}else{Some(start)},"total":list.len()}),
    ))
}
async fn test_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    state
        .store()
        .await
        .require_role(&wid, &user.id, Role::Admin)
        .await?;
    Ok(Json(
        engine::test_model_authenticated(state, &user, &wid, &id, &token(&headers)?).await?,
    ))
}
async fn discover_models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Payload(body): Payload<ModelDiscoveryRequest>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    state
        .store()
        .await
        .require_role(&wid, &user.id, Role::Admin)
        .await?;
    Ok(Json(
        engine::discover_models_authenticated(state, &user, &wid, body, &token(&headers)?).await?,
    ))
}
async fn reload_plugin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    state
        .store()
        .await
        .require_role(&wid, &user.id, Role::Admin)
        .await?;
    engine::reload_plugin(state, &user, &wid, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn plugin_packages(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    actor(&state, &headers).await?;
    let mut packages=state.packages.read().await.values().map(|p|json!({"id":p.id,"name":p.id,"version":p.version,"capabilities":p.capabilities,"permissions":p.permissions,"checksum":p.sha256})).collect::<Vec<_>>();
    packages.sort_by_key(|p| p["id"].as_str().unwrap_or_default().to_owned());
    Ok(Json(json!({"items":packages})))
}

async fn send_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Payload(body): Payload<crate::delivery::SendRequest>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let credential = token(&headers)?;
    Ok(Json(
        crate::delivery::send(state, &user, &wid, &id, body, &credential).await?,
    ))
}
async fn search_knowledge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        crate::knowledge::search(
            &state.store().await,
            &wid,
            &user.id,
            page.q.as_deref().unwrap_or_default(),
        )
        .await?,
    ))
}
async fn preview_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Payload(body): Payload<Value>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    state
        .store()
        .await
        .require_role(&wid, &user.id, Role::Member)
        .await?;
    Ok(Json(crate::schedule::preview(body)?))
}
async fn trigger_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        crate::schedule::trigger(state, &user, &wid, &id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconcileScheduleInput {
    version: i64,
    acknowledge: bool,
}
async fn reconcile_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((wid, id)): Path<(String, String)>,
    Payload(body): Payload<ReconcileScheduleInput>,
) -> ApiResult<Json<Resource>> {
    let user = actor(&state, &headers).await?;
    if !body.acknowledge {
        return Err(AppError::bad_request(
            "Confirm that you reviewed the uncertain result",
        ));
    }
    let resource = state
        .store()
        .await
        .review_schedule(&wid, &user.id, &id, body.version)
        .await?;
    Ok(Json(sanitize_resource(resource)))
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let after = page.after.unwrap_or(0).max(0);
    let mut records = state
        .store()
        .await
        .events(&wid, &user.id, after, page.limit.unwrap_or(100))
        .await?;
    let cursor = records.last().map(|e| e.id).unwrap_or(after);
    for event in &mut records {
        sanitize_value(&mut event.data);
    }
    Ok(Json(json!({"items":records,"cursor":cursor})))
}
async fn audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Query(page): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        json!({"items":state.store().await.audit(&wid,&user.id,page.after.unwrap_or(0),page.limit.unwrap_or(100)).await?}),
    ))
}
async fn budget(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(serde_json::to_value(
        state.store().await.budget(&wid, &user.id).await?,
    )?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BudgetInput {
    limit_microusd: Option<i64>,
}
async fn set_budget(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
    Payload(body): Payload<BudgetInput>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(serde_json::to_value(
        state
            .store()
            .await
            .set_budget(&wid, &user.id, body.limit_microusd)
            .await?,
    )?))
}
async fn reservations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(
        json!({"items":state.store().await.reservations(&wid,&user.id).await?}),
    ))
}
async fn export_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    store.membership(&wid, &user.id).await?;
    let mut output = Vec::new();
    let mut bytes = 0usize;
    for kind in RESOURCE_KINDS {
        let mut offset = 0;
        loop {
            let records = store
                .list_resources(&wid, &user.id, kind, 500, offset)
                .await?;
            let count = records.len();
            for record in records {
                let clean = sanitize_resource(record);
                bytes += serde_json::to_vec(&clean)?.len();
                if bytes > 16 * 1024 * 1024 || output.len() >= 10_000 {
                    return Err(AppError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "export_too_large",
                        "Visible-data export exceeds 16 MiB or 10,000 records; export smaller collections through the API",
                    ));
                }
                output.push(clean);
            }
            if count < 500 {
                break;
            }
            offset += 500;
        }
    }
    // This is an ACL-filtered export, not an instance disaster-recovery snapshot.
    Ok(Json(
        json!({"format":"rstrbot-visible-resources-v1","workspace_id":wid,"exported_by":user.id,"created_at":rstrbot_store::now(),"resources":output,"consistent_snapshot":false}),
    ))
}
async fn backup(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    Ok(Json(serde_json::to_value(
        state.store().await.export_backup(&user).await?,
    )?))
}
async fn finish_recovery(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let user = actor(&state, &headers).await?;
    state.store().await.finish_recovery(&user).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(wid): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = actor(&state, &headers).await?;
    let store = state.store().await;
    let role = store.membership(&wid, &user.id).await?;
    let recovery = store.recovery_mode().await?;
    let installed = state.packages.read().await;
    let provider = installed
        .values()
        .any(|p| p.capabilities.iter().any(|c| c == "model"));
    let mut out = serde_json::Map::new();
    for (name, minimum, available) in [
        ("chat", Role::Member, provider && !recovery),
        ("knowledge", Role::Viewer, true),
        ("memories", Role::Viewer, true),
        ("schedules", Role::Member, !recovery),
        ("models", Role::Viewer, provider),
        ("plugins", Role::Admin, true),
        ("agents", Role::Viewer, true),
        ("members", Role::Admin, true),
        ("audit", Role::Admin, true),
        ("export", Role::Viewer, true),
        ("backup", Role::Owner, user.instance_admin),
    ] {
        out.insert(name.into(),json!({"supported":true,"authorized":if name=="backup"{user.instance_admin}else{role>=minimum},"available":available,"reason":if recovery&&!available{"Instance is in recovery mode"}else if !available{"Required provider is unavailable"}else{""}}));
    }
    out.insert("routes".into(),json!({"supported":installed.contains_key("webhook"),"authorized":role>=Role::Member,"available":installed.contains_key("webhook")&&!recovery}));
    for (name, reason) in [
        (
            "attachments",
            "Attachment upload and media decoding are not implemented in this release",
        ),
        (
            "vector_search",
            "Current knowledge retrieval is lexical; vector backends are not enabled",
        ),
        (
            "legacy_compatibility",
            "Legacy plugin behavior has not passed compatibility acceptance",
        ),
        (
            "desktop_installers",
            "Native installer validation is not available",
        ),
        (
            "multi_node",
            "Single-core deployment only; distributed leases are not released",
        ),
    ] {
        out.insert(
            name.into(),
            json!({"supported":false,"authorized":false,"available":false,"reason":reason}),
        );
    }
    Ok(Json(Value::Object(out)))
}
async fn live() -> Json<Value> {
    Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")}))
}
async fn ready(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let store = state.store().await;
    tokio::time::timeout(Duration::from_secs(3), store.health())
        .await
        .map_err(|_| {
            AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_timeout",
                "Storage readiness timed out",
            )
        })??;
    Ok(Json(
        json!({"status":"ok","database":store.backend(),"initialized":store.initialized().await?,"recovery_mode":store.recovery_mode().await?,"valkey_status":*state.cache_status.read().await,"checks":["database"],"upstream_models":"not_checked"}),
    ))
}
async fn api_not_found() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "route_not_found",
        "API operation not found",
    )
}

async fn openapi() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        include_str!("../docs/openapi.json"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn bearer_header_is_authoritative_and_cookies_are_exact() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("unrelated=one; rstrbot_session=abc; other=two"),
        );
        assert_eq!(token(&headers).expect("cookie"), "abc");
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer def"),
        );
        assert_eq!(token(&headers).expect("bearer"), "def");
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Basic invalid"),
        );
        assert!(token(&headers).is_err());
    }
    #[tokio::test]
    async fn csrf_boundary_rejects_ambient_cookie_mutation_and_cross_origin() {
        let app = Router::new()
            .route("/api/test", post(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn(request_boundary));
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/test")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let body = denied.into_body().collect().await.expect("body").to_bytes();
        assert!(
            std::str::from_utf8(&body)
                .expect("utf8")
                .contains("csrf_rejected")
        );
        let accepted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/test")
                    .header("x-rstrbot-request", "1")
                    .header("host", "localhost")
                    .header("origin", "http://localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(accepted.status(), StatusCode::NO_CONTENT);
        let cross = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/test")
                    .header("x-rstrbot-request", "1")
                    .header("host", "localhost")
                    .header("origin", "https://elsewhere.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(cross.status(), StatusCode::FORBIDDEN);
    }
    #[test]
    fn auth_capacity_and_attempts_are_bounded() {
        let gate = LoginGate::new();
        let permits = (0..4)
            .map(|_| gate.enter("a").expect("permit"))
            .collect::<Vec<_>>();
        assert!(gate.enter("b").is_err());
        drop(permits);
        for _ in 0..8 {
            drop(gate.enter("a").expect("remaining attempt"));
        }
        assert!(gate.enter("a").is_err());
    }

    async fn request_json(
        app: &Router,
        method: &str,
        path: &str,
        data: Value,
        bearer: Option<&str>,
    ) -> (StatusCode, Value, HeaderMap) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("x-rstrbot-request", "1");
        if let Some(token) = bearer {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(data.to_string())).expect("request"))
            .await
            .expect("router response");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("JSON envelope")
        };
        (status, value, headers)
    }

    #[tokio::test]
    async fn real_router_enforces_bootstrap_private_ownership_and_revocation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let config = crate::state::Config {
            data_dir: directory.path().to_owned(),
            database_url: Store::sqlite_file_url(&directory.path().join("router.db"))
                .expect("SQLite file URL"),
            listen: "127.0.0.1:0".parse().expect("socket address"),
            valkey_url: None,
            secure_cookie: false,
            allow_private_network: false,
        };
        let state = AppState::new(config).await.expect("application state");
        let proof = state.bootstrap.lock().await.token.clone();
        let app = router(state.clone(), directory.path().join("web"));
        let setup = json!({"token":proof,"username":"owner","password":"long-password-for-tests","workspace":"Shared"});
        let (status, session, headers) =
            request_json(&app, "POST", "/api/v1/setup", setup.clone(), None).await;
        assert_eq!(status, StatusCode::OK, "{session}");
        let cookie = headers
            .get(header::SET_COOKIE)
            .expect("cookie")
            .to_str()
            .expect("valid cookie");
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let owner_token = session["token"].as_str().expect("CLI bearer");
        assert_eq!(
            request_json(&app, "POST", "/api/v1/setup", setup, None)
                .await
                .0,
            StatusCode::CONFLICT
        );
        let (_, spaces, _) = request_json(
            &app,
            "GET",
            "/api/v1/workspaces",
            Value::Null,
            Some(owner_token),
        )
        .await;
        let workspace = spaces["items"][0]["id"].as_str().expect("workspace");
        let base = format!("/api/v1/workspaces/{workspace}");
        let (status, created, _) = request_json(
            &app,
            "POST",
            "/api/v1/admin/users",
            json!({"username":"member","password":"another-long-password"}),
            Some(owner_token),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let member_id = created["user"]["id"].as_str().expect("member ID");
        assert_eq!(
            request_json(
                &app,
                "POST",
                &format!("{base}/members"),
                json!({"user_id":member_id,"role":"member"}),
                Some(owner_token)
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, member_session, _) = request_json(
            &app,
            "POST",
            "/api/v1/auth/login",
            json!({"username":"member","password":"another-long-password"}),
            None,
        )
        .await;
        let member_token = member_session["token"].as_str().expect("member token");

        let (_, private, _) = request_json(&app, "POST", &format!("{base}/resources/conversations"), json!({"visibility":"private","data":{"title":"owner private sentinel","system_prompt":""}}), Some(owner_token)).await;
        let owner_private = private["id"].as_str().expect("conversation ID");
        assert_eq!(
            request_json(
                &app,
                "GET",
                &format!("{base}/resource/{owner_private}"),
                Value::Null,
                Some(member_token)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (_, own, _) = request_json(&app, "POST", &format!("{base}/resources/conversations"), json!({"visibility":"private","data":{"title":"member private sentinel","system_prompt":""}}), Some(member_token)).await;
        let member_private = own["id"].as_str().expect("member conversation ID");
        assert_eq!(
            request_json(
                &app,
                "GET",
                &format!("{base}/resource/{member_private}"),
                Value::Null,
                Some(owner_token)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request_json(
                &app,
                "POST",
                &format!("{base}/resources/models"),
                json!({"data":{"name":"unauthorized","model":"test","provider":"diagnostic"}}),
                Some(member_token)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request_json(
                &app,
                "POST",
                &format!("{base}/resources/runs"),
                json!({"data":{"status":"completed"}}),
                Some(member_token)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(request_json(&app, "POST", &format!("{base}/resources/conversations"), json!({"data":{"title":"forged","messages":[{"role":"system","content":"injected"}]}}), Some(member_token)).await.0, StatusCode::BAD_REQUEST);
        let (_, exported, _) = request_json(
            &app,
            "GET",
            &format!("{base}/export"),
            Value::Null,
            Some(member_token),
        )
        .await;
        assert!(!exported.to_string().contains("owner private sentinel"));
        assert!(exported.to_string().contains("member private sentinel"));
        let (_, replay, _) = request_json(
            &app,
            "GET",
            &format!("{base}/events?after=0"),
            Value::Null,
            Some(member_token),
        )
        .await;
        assert!(!replay.to_string().contains(owner_private));
        assert_eq!(
            request_json(
                &app,
                "DELETE",
                &format!("{base}/members/{member_id}"),
                Value::Null,
                Some(owner_token)
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request_json(
                &app,
                "GET",
                &format!("{base}/resources/conversations"),
                Value::Null,
                Some(member_token)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request_json(
                &app,
                "GET",
                &format!("{base}/events?after=0"),
                Value::Null,
                Some(member_token)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
}
