use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use rand::{RngCore, rngs::OsRng};
use rstrbot_plugin::{Manifest, PluginHost, Timeouts};
use rstrbot_store::{Resource, Store, User};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_input", message)
    }
    pub fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Operation is not permitted",
        )
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
impl From<rstrbot_store::Error> for AppError {
    fn from(error: rstrbot_store::Error) -> Self {
        use rstrbot_store::Error;
        match error {
            Error::Unauthorized => Self::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Please sign in again",
            ),
            Error::Forbidden => Self::forbidden(),
            Error::RecentAuthRequired => Self::new(
                StatusCode::FORBIDDEN,
                "reauth_required",
                "Confirm your identity before changing account security settings",
            ),
            Error::RateLimited => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Wait at least one minute before requesting another email; the hourly or daily limit may also apply",
            ),
            Error::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", "Resource not found"),
            Error::Conflict => Self::conflict(
                "The record changed or this operation is already in progress; reload before retrying",
            ),
            Error::Invalid(s) => Self::bad_request(s),
            Error::BudgetExceeded => Self::new(
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
                "Workspace budget cannot cover this request",
            ),
            Error::Database(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                "Storage is unavailable; the operation may require reconciliation",
            ),
            Error::Serialization(_) => Self::internal("Stored data could not be decoded"),
        }
    }
}
impl From<rstrbot_plugin::PluginError> for AppError {
    fn from(e: rstrbot_plugin::PluginError) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            e.code(),
            match &e {
                rstrbot_plugin::PluginError::Remote { .. } => match e.code() {
                    "provider_authentication_failed" => {
                        "The model provider rejected the credentials; check the model configuration"
                            .into()
                    }
                    "provider_access_denied" => {
                        "The model provider denied access; check the model and provider permissions"
                            .into()
                    }
                    "provider_rate_limited" => {
                        "The model provider is rate limiting requests; wait before trying again"
                            .into()
                    }
                    _ => "The plugin rejected the operation; check configuration".into(),
                },
                _ => e.to_string(),
            },
        )
    }
}
impl From<std::io::Error> for AppError {
    fn from(_: std::io::Error) -> Self {
        Self::internal("Filesystem operation failed; check permissions and free space")
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::bad_request("Invalid JSON document")
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub data_dir: PathBuf,
    pub database_url: String,
    pub listen: SocketAddr,
    pub valkey_url: Option<String>,
    pub secure_cookie: bool,
    pub allow_private_network: bool,
}
impl Config {
    pub fn load(
        data_dir: Option<PathBuf>,
        database_url: Option<String>,
        listen: SocketAddr,
        valkey_url: Option<String>,
        secure_cookie: bool,
        allow_private_network: bool,
    ) -> Result<Self, AppError> {
        let data_dir = match data_dir {
            Some(p) if p.is_absolute() => p,
            Some(p) => std::env::current_dir()?.join(p),
            None => directories::ProjectDirs::from("org", "RstrBot", "RstrBot")
                .ok_or_else(|| AppError::bad_request("Specify an absolute --data-dir"))?
                .data_local_dir()
                .to_owned(),
        };
        private_dir(&data_dir)?;
        let path = data_dir.join("config.json");
        let mut config = if path.exists() {
            serde_json::from_slice::<Self>(&fs::read(&path)?)?
        } else {
            Self {
                database_url: Store::sqlite_file_url(&data_dir.join("rstrbot.db"))?,
                data_dir: data_dir.clone(),
                listen,
                valkey_url: None,
                secure_cookie: false,
                allow_private_network: false,
            }
        };
        config.data_dir = data_dir;
        if let Some(url) = database_url {
            config.database_url = url;
        }
        config.listen = listen;
        if valkey_url.is_some() {
            config.valkey_url = valkey_url;
        }
        config.secure_cookie |= secure_cookie;
        config.allow_private_network |= allow_private_network;
        config.save()?;
        Ok(config)
    }
    pub fn save(&self) -> Result<(), AppError> {
        atomic_private_write(
            &self.data_dir.join("config.json"),
            &serde_json::to_vec_pretty(self)?,
        )
    }
}

pub fn private_dir(path: &Path) -> Result<(), AppError> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(AppError::bad_request("Data directory cannot be a symlink"));
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn atomic_private_write(path: &Path, data: &[u8]) -> Result<(), AppError> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(AppError::bad_request("Refusing a symlink target"));
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub struct Vault {
    key: [u8; 32],
}
impl Vault {
    fn load(path: &Path, initialized: bool) -> Result<Self, AppError> {
        if !path.exists() {
            if initialized {
                return Err(AppError::internal(
                    "The encryption key is missing. Restore secrets.key from your protected backup before starting",
                ));
            }
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            atomic_private_write(path, &key)?;
        }
        if path.symlink_metadata()?.file_type().is_symlink() {
            return Err(AppError::bad_request(
                "Encryption key must not be a symlink",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
                return Err(AppError::internal(
                    "Encryption key permissions are too broad; restrict secrets.key to its owner before starting",
                ));
            }
        }
        let bytes = fs::read(path)?;
        let key = bytes
            .try_into()
            .map_err(|_| AppError::internal("Encryption key must contain exactly 32 bytes"))?;
        Ok(Self { key })
    }
    pub fn seal(&self, value: &str) -> Result<String, AppError> {
        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = cipher
            .encrypt(XNonce::from_slice(&nonce), value.as_bytes())
            .map_err(|_| AppError::internal("Secret encryption failed"))?;
        let mut envelope = nonce.to_vec();
        envelope.extend(encrypted);
        Ok(STANDARD.encode(envelope))
    }
    pub fn open(&self, value: &str) -> Result<String, AppError> {
        let envelope = STANDARD
            .decode(value)
            .map_err(|_| AppError::internal("Secret is damaged"))?;
        if envelope.len() < 40 {
            return Err(AppError::internal("Secret is damaged"));
        }
        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let bytes = cipher
            .decrypt(XNonce::from_slice(&envelope[..24]), &envelope[24..])
            .map_err(|_| {
                AppError::internal("Secret cannot be opened with this installation key")
            })?;
        String::from_utf8(bytes).map_err(|_| AppError::internal("Secret encoding is invalid"))
    }
}

pub struct Bootstrap {
    pub token: String,
    pub expires_at: i64,
}
impl Bootstrap {
    pub fn check(&self, token: &str) -> bool {
        let expected = Sha256::digest(self.token.as_bytes());
        let actual = Sha256::digest(token.as_bytes());
        let different = expected
            .iter()
            .zip(actual.iter())
            .fold(0u8, |a, (x, y)| a | (x ^ y));
        !self.token.is_empty() && chrono::Utc::now().timestamp() < self.expires_at && different == 0
    }
}
#[derive(Clone)]
pub struct ActiveRun {
    pub user_id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    pub plugin_ids: Vec<String>,
    pub token: CancellationToken,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<RwLock<Store>>,
    pub config: Arc<RwLock<Config>>,
    pub vault: Arc<Vault>,
    pub packages: Arc<RwLock<HashMap<String, Manifest>>>,
    pub host: Arc<PluginHost>,
    pub runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    pub bootstrap: Arc<Mutex<Bootstrap>>,
    pub shutdown: CancellationToken,
    pub capacity: Arc<Semaphore>,
    pub cache_status: Arc<RwLock<String>>,
}
impl AppState {
    pub async fn new(config: Config) -> Result<Self, AppError> {
        private_dir(&config.data_dir)?;
        let store = Store::connect(&config.database_url).await?;
        let initialized = store.initialized().await?;
        let vault = Vault::load(&config.data_dir.join("secrets.key"), initialized)?;
        let mut random = [0u8; 32];
        OsRng.fill_bytes(&mut random);
        let bootstrap = Bootstrap {
            token: if initialized {
                String::new()
            } else {
                hex::encode(random)
            },
            expires_at: chrono::Utc::now().timestamp() + 900,
        };
        if !initialized {
            atomic_private_write(
                &config.data_dir.join("bootstrap.token"),
                bootstrap.token.as_bytes(),
            )?;
        }
        let mut packages = HashMap::new();
        let executable = std::env::current_exe()?;
        let executable_dir = executable
            .parent()
            .ok_or_else(|| AppError::internal("Executable directory not found"))?;
        let suffix = std::env::consts::EXE_SUFFIX;
        for (id, capabilities, permissions) in [
            ("openai", vec!["model"], vec!["network"]),
            ("diagnostic", vec!["model", "tools"], vec![]),
            ("webhook", vec!["platform"], vec!["network"]),
        ] {
            let path = executable_dir.join(format!("rstrbot-{id}{suffix}"));
            if path.is_file() {
                packages.insert(
                    id.into(),
                    Manifest {
                        id: id.into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                        executable: path,
                        args: vec![],
                        capabilities: capabilities.into_iter().map(String::from).collect(),
                        permissions: permissions.into_iter().map(String::from).collect(),
                        sha256: None,
                        timeouts: Timeouts::default(),
                    },
                );
            }
        }
        let plugins_dir = config.data_dir.join("plugins");
        private_dir(&plugins_dir)?;
        for entry in fs::read_dir(plugins_dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|x| x == "json") {
                let manifest: Manifest = serde_json::from_slice(&fs::read(path)?)?;
                rstrbot_plugin::validate_manifest(&manifest)?;
                if packages.contains_key(&manifest.id) {
                    return Err(AppError::bad_request(
                        "Installed plugin shadows a reserved package id",
                    ));
                }
                packages.insert(manifest.id.clone(), manifest);
            }
        }
        let runtime = std::env::temp_dir().join(format!(
            "rb-{}",
            &hex::encode(Sha256::digest(config.data_dir.to_string_lossy().as_bytes()))[..16]
        ));
        private_dir(&runtime)?;
        let cache_status = if config.valkey_url.is_some() {
            "connecting"
        } else {
            "disabled"
        };
        let state = Self {
            db: Arc::new(RwLock::new(store)),
            config: Arc::new(RwLock::new(config)),
            vault: Arc::new(vault),
            packages: Arc::new(RwLock::new(packages)),
            host: Arc::new(PluginHost::new(runtime)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            bootstrap: Arc::new(Mutex::new(bootstrap)),
            shutdown: CancellationToken::new(),
            capacity: Arc::new(Semaphore::new(16)),
            cache_status: Arc::new(RwLock::new(cache_status.into())),
        };
        tokio::spawn(crate::cache::heartbeat(state.clone()));
        Ok(state)
    }
    pub async fn store(&self) -> Store {
        self.db.read().await.clone()
    }
    pub async fn shutdown_runs(&self) {
        self.shutdown.cancel();
        for run in self.runs.lock().await.values() {
            run.token.cancel();
        }
        let _ = tokio::time::timeout(Duration::from_secs(8), async {
            while !self.runs.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
    }
}

pub fn sanitize_resource(mut resource: Resource) -> Resource {
    sanitize_value(&mut resource.data);
    resource
}
pub fn sanitize_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("api_key_cipher") {
                map.insert("has_api_key".into(), json!(true));
            }
            if map.contains_key("token_cipher") {
                map.insert("has_token".into(), json!(true));
            }
            map.retain(|key, _| {
                !matches!(
                    key.as_str(),
                    "api_key"
                        | "api_key_cipher"
                        | "token"
                        | "token_cipher"
                        | "password"
                        | "provider_state"
                )
            });
            for v in map.values_mut() {
                sanitize_value(v);
            }
        }
        Value::Array(list) => {
            for v in list {
                sanitize_value(v);
            }
        }
        _ => {}
    }
}

fn text(data: &Value, key: &str, max: usize, required: bool) -> Result<String, AppError> {
    let value = data.get(key).and_then(Value::as_str).unwrap_or_default();
    if (required && value.trim().is_empty()) || value.len() > max {
        return Err(AppError::bad_request(format!(
            "{key} is missing or too long"
        )));
    }
    Ok(value.to_owned())
}
fn selected(data: &Value, keys: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for key in keys {
        if let Some(v) = data.get(*key) {
            result.insert((*key).into(), v.clone());
        }
    }
    Value::Object(result)
}
/// Compare complete normalized URLs, including scheme, port and path. A
/// different path on the same host may be controlled by a different tenant.
/// Missing URLs are equivalent only for providers without a network target.
fn same_url(previous: Option<&str>, next: Option<&str>) -> bool {
    match (previous, next) {
        (None, None) => true,
        (Some(previous), Some(next)) => url::Url::parse(previous)
            .ok()
            .zip(url::Url::parse(next).ok())
            .is_some_and(|(previous, next)| previous == next),
        _ => false,
    }
}

fn secret_field(
    state: &AppState,
    data: &Value,
    previous: Option<&Resource>,
    result: &mut Value,
    name: &str,
    destination_unchanged: bool,
) -> Result<(), AppError> {
    let cipher_key = format!("{name}_cipher");
    let replacement = data
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let clear = data.get(format!("clear_{name}")).and_then(Value::as_bool) == Some(true);
    let retained = previous.and_then(|r| r.data.get(&cipher_key));
    // Calling a shared connection does not grant the caller its secret. An
    // endpoint/provider edit must not silently forward that secret elsewhere,
    // including when the editor is an instance administrator.
    if !destination_unchanged && retained.is_some() && replacement.is_none() && !clear {
        return Err(AppError::bad_request(format!(
            "Changing the credential destination requires a new {name} or clear_{name}=true"
        )));
    }
    if let Some(value) = replacement {
        if value.len() > 8192 {
            return Err(AppError::bad_request("Credential is too long"));
        }
        result[&cipher_key] = json!(state.vault.seal(value)?);
    } else if let Some(value) = retained {
        result[&cipher_key] = value.clone();
    }
    if clear {
        result.as_object_mut().map(|m| m.remove(&cipher_key));
    }
    Ok(())
}

pub async fn prepare_data(
    state: &AppState,
    user: &User,
    kind: &str,
    data: Value,
    previous: Option<&Resource>,
) -> Result<Value, AppError> {
    if !data.is_object() {
        return Err(AppError::bad_request("Resource data must be an object"));
    }
    match kind {
        "conversations" => {
            let title = text(&data, "title", 200, true)?;
            let prompt = text(&data, "system_prompt", 16000, false)?;
            let mut out = previous
                .map(|p| p.data.clone())
                .unwrap_or_else(|| json!({"messages":[],"generation":0}));
            out["title"] = json!(title);
            out["system_prompt"] = json!(prompt);
            Ok(out)
        }
        "models" => {
            text(&data, "name", 200, true)?;
            text(&data, "model", 200, true)?;
            let provider = data
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("openai");
            if !state
                .packages
                .read()
                .await
                .get(provider)
                .is_some_and(|p| p.capabilities.iter().any(|c| c == "model"))
            {
                return Err(AppError::bad_request(
                    "Model provider package is not installed",
                ));
            }
            let mut out = selected(
                &data,
                &[
                    "name",
                    "provider",
                    "base_url",
                    "model",
                    "max_tokens",
                    "input_microusd_per_million",
                    "output_microusd_per_million",
                    "allow_private_network",
                ],
            );
            out["provider"] = json!(provider);
            let destination_unchanged = previous.is_some_and(|previous| {
                previous.data["provider"].as_str().unwrap_or("openai") == provider
                    && same_url(
                        previous.data["base_url"].as_str(),
                        data["base_url"].as_str(),
                    )
            });
            let max = data
                .get("max_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(2048);
            if !(1..=32768).contains(&max) {
                return Err(AppError::bad_request("max_tokens must be 1–32768"));
            }
            out["max_tokens"] = json!(max);
            for key in ["input_microusd_per_million", "output_microusd_per_million"] {
                if let Some(v) = out.get(key).filter(|v| !v.is_null())
                    && !v
                        .as_i64()
                        .is_some_and(|v| (0..=1_000_000_000_000).contains(&v))
                {
                    return Err(AppError::bad_request(
                        "Price must be a nonnegative integer in microdollars per million tokens",
                    ));
                }
            }
            if provider != "diagnostic" {
                let url = url::Url::parse(&text(&data, "base_url", 2048, true)?)
                    .map_err(|_| AppError::bad_request("Invalid model URL"))?;
                let allow = data
                    .get("allow_private_network")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let was_allowed = destination_unchanged
                    && previous.is_some_and(|r| r.data["allow_private_network"] == true);
                if allow
                    && (!state.config.read().await.allow_private_network
                        || (!user.instance_admin && !was_allowed))
                {
                    return Err(AppError::forbidden());
                }
                if !matches!(url.scheme(), "https" | "http")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(AppError::bad_request(
                        "Use an HTTP(S) model base URL without credentials, query or fragment",
                    ));
                }
                if url.scheme() != "https" && !allow {
                    return Err(AppError::bad_request(
                        "Public models require HTTPS; local model access requires explicit instance administrator permission",
                    ));
                }
                out["allow_private_network"] = json!(allow);
            } else {
                // A non-network diagnostic provider cannot carry a private
                // networking approval into a future provider switch.
                out["allow_private_network"] = json!(false);
            }
            secret_field(
                state,
                &data,
                previous,
                &mut out,
                "api_key",
                destination_unchanged,
            )?;
            Ok(out)
        }
        "knowledge" => crate::knowledge::validate_and_index(data),
        "memories" => {
            text(&data, "title", 200, true)?;
            text(&data, "content", 16000, true)?;
            text(&data, "source", 2000, false)?;
            let mut out = selected(
                &data,
                &[
                    "title",
                    "content",
                    "source",
                    "enabled",
                    "archived",
                    "pinned",
                    "expires_at",
                ],
            );
            for (key, default) in [("enabled", true), ("archived", false), ("pinned", false)] {
                out[key] = json!(data.get(key).and_then(Value::as_bool).unwrap_or(default));
            }
            Ok(out)
        }
        "schedules" => {
            let mut out = crate::schedule::validate(data)?;
            if let Some(previous) = previous {
                if matches!(
                    previous.data["status"].as_str(),
                    Some("unknown" | "needs_reconciliation")
                ) && out["enabled"] == true
                {
                    return Err(AppError::conflict(
                        "Reconcile the schedule before enabling it",
                    ));
                }
                for key in [
                    "status",
                    "claim_id",
                    "claimed_at",
                    "scheduled_for",
                    "run_id",
                    "last_run",
                    "last_error",
                    "last_result",
                ] {
                    if let Some(v) = previous.data.get(key) {
                        out[key] = v.clone();
                    }
                }
            }
            Ok(out)
        }
        "plugins" => {
            let package_id = text(&data, "package_id", 120, true)?;
            if !state.packages.read().await.contains_key(&package_id) {
                return Err(AppError::bad_request(
                    "Plugin package is not installed by the instance operator",
                ));
            }
            let mut out = selected(&data, &["name", "package_id", "enabled", "config"]);
            out["enabled"] = json!(data["enabled"].as_bool().unwrap_or(false));
            if serde_json::to_vec(&out["config"])?.len() > 32 * 1024 {
                return Err(AppError::bad_request("Plugin configuration exceeds 32 KiB"));
            }
            out["status"] = json!(if out["enabled"] == true {
                "ready"
            } else {
                "installed"
            });
            out["generation"] = json!(
                previous
                    .and_then(|p| p.data["generation"].as_u64())
                    .unwrap_or(0)
                    + 1
            );
            Ok(out)
        }
        "agents" => {
            text(&data, "name", 200, true)?;
            text(&data, "system_prompt", 16000, false)?;
            let steps = data["max_steps"].as_u64().unwrap_or(6);
            if !(1..=12).contains(&steps) {
                return Err(AppError::bad_request("max_steps must be 1–12"));
            }
            let mut out = selected(
                &data,
                &[
                    "name",
                    "system_prompt",
                    "model_id",
                    "max_steps",
                    "knowledge",
                    "memory",
                ],
            );
            out["max_steps"] = json!(steps);
            Ok(out)
        }
        "routes" => {
            text(&data, "name", 200, true)?;
            let url = text(&data, "url", 2048, true)?;
            let parsed =
                url::Url::parse(&url).map_err(|_| AppError::bad_request("Invalid webhook URL"))?;
            if !matches!(parsed.scheme(), "https" | "http")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(AppError::bad_request("Invalid webhook URL"));
            }
            // Only the instance operator can authorize an outbound target. Workspace administrators may disable it.
            let destination_unchanged = previous.is_some_and(|previous| {
                previous.data["adapter"].as_str() == Some("webhook")
                    && same_url(previous.data["url"].as_str(), Some(&url))
            });
            if !user.instance_admin
                && (!destination_unchanged
                    || data["enabled"] == true
                        && previous.is_some_and(|p| p.data["enabled"] != true))
            {
                return Err(AppError::forbidden());
            }
            let allow = data["allow_private_network"].as_bool().unwrap_or(false);
            let was_allowed = destination_unchanged
                && previous.is_some_and(|previous| previous.data["allow_private_network"] == true);
            if allow
                && (!state.config.read().await.allow_private_network
                    || (!user.instance_admin && !was_allowed))
            {
                return Err(AppError::forbidden());
            }
            let mut out = selected(&data, &["name", "url", "enabled", "allow_private_network"]);
            out["adapter"] = json!("webhook");
            out["enabled"] = json!(data["enabled"].as_bool().unwrap_or(false));
            secret_field(
                state,
                &data,
                previous,
                &mut out,
                "token",
                destination_unchanged,
            )?;
            Ok(out)
        }
        _ => Err(AppError::bad_request(
            "Resource type is read-only or unsupported",
        )),
    }
}
