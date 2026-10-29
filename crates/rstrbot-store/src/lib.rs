//! Durable identities, authorization, resources and accounting for RstrBot.
//!
//! SQLite and PostgreSQL execute the same business operations. Every resource
//! operation checks current membership; workspace administrators cannot read
//! another member's private resources through this API.

mod auth;
mod backup;
mod budget;
mod identity;
mod probe;
mod resources;
mod workspaces;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Any, AnyPool, Row, Transaction, any::AnyPoolOptions};
use std::time::Duration;
use thiserror::Error;

pub use backup::Backup;
pub use identity::{
    AuthAccount, AuthChallenge, GoogleIdentity, IdentitySetting, PasskeyCredential, VerifiedEmail,
};
pub use probe::Probe;
pub use resources::{ResourceCursor, ResourcePage, VisibleResourceCursor, VisibleResourcePage};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("authentication required or expired")]
    Unauthorized,
    #[error("operation is not permitted")]
    Forbidden,
    #[error("verify a sign-in method again before changing account security")]
    RecentAuthRequired,
    #[error("too many authentication requests; try again later")]
    RateLimited,
    #[error("resource not found")]
    NotFound,
    #[error("the record changed; reload before retrying")]
    Conflict,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("workspace budget cannot cover this reservation")]
    BudgetExceeded,
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("stored data is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub username: String,
    pub instance_admin: bool,
}

#[derive(Serialize, Deserialize)]
pub struct TokenSession {
    pub token: String,
    pub user: User,
    pub expires_at: i64,
}

impl std::fmt::Debug for TokenSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenSession")
            .field("token", &"[REDACTED]")
            .field("user", &self.user)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Member,
    Operator,
    Admin,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Member => "member",
            Self::Operator => "operator",
            Self::Admin => "admin",
            Self::Owner => "owner",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "viewer" => Ok(Self::Viewer),
            "member" => Ok(Self::Member),
            "operator" => Ok(Self::Operator),
            "admin" => Ok(Self::Admin),
            "owner" => Ok(Self::Owner),
            _ => Err(Error::Invalid("unknown role".into())),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Private,
    Workspace,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Workspace => "workspace",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub role: Role,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub user_id: String,
    pub username: String,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub workspace_id: String,
    pub owner_id: String,
    pub kind: String,
    pub visibility: Visibility,
    pub version: i64,
    pub data: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Core-supplied run intent. Admission resolves current resource ownership and
/// snapshots the model/agent inside the same transaction as the history write.
pub struct RunAdmissionRequest {
    pub conversation_id: String,
    pub model_id: String,
    pub agent_id: Option<String>,
    pub operation_key: String,
    pub fingerprint: String,
    pub content: String,
}

pub struct RunAdmission {
    pub run: Resource,
    pub conversation: Resource,
    /// Present only for a newly admitted run; replay does not dispatch a model.
    pub model: Option<Resource>,
    pub agent: Option<Resource>,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub workspace_id: String,
    pub resource_id: String,
    pub kind: String,
    pub data: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Budget {
    pub workspace_id: String,
    pub limit_microusd: Option<i64>,
    pub spent_microusd: i64,
    pub reserved_microusd: i64,
    pub unknown_reservations: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reservation {
    pub id: String,
    pub workspace_id: String,
    pub operation_id: String,
    pub amount_microusd: i64,
    pub actual_microusd: Option<i64>,
    pub state: String,
}

#[derive(Clone)]
pub struct Store {
    pool: AnyPool,
    backend: &'static str,
}

impl Store {
    /// Connect and apply idempotent schema migrations. SQLite is single-core:
    /// one connection bounds concurrent writes; network calls must happen outside transactions.
    pub async fn connect(url: &str) -> Result<Self> {
        sqlx::any::install_default_drivers();
        let sqlite = url.starts_with("sqlite:");
        if !sqlite && !url.starts_with("postgres:") && !url.starts_with("postgresql:") {
            return Err(Error::Invalid(
                "use a SQLite or PostgreSQL database URL".into(),
            ));
        }
        let pool = AnyPoolOptions::new()
            .max_connections(if sqlite { 1 } else { 8 })
            .acquire_timeout(Duration::from_secs(10))
            .after_connect(move |connection, _| {
                Box::pin(async move {
                    if sqlite {
                        for pragma in [
                            "PRAGMA foreign_keys = ON",
                            "PRAGMA journal_mode = WAL",
                            "PRAGMA synchronous = FULL",
                            "PRAGMA busy_timeout = 5000",
                        ] {
                            sqlx::query(pragma).execute(&mut *connection).await?;
                        }
                    }
                    Ok(())
                })
            })
            .connect(url)
            .await?;
        let store = Self {
            pool,
            backend: if sqlite { "sqlite" } else { "postgresql" },
        };
        let probe = Self::probe(url).await?;
        if probe.has_user_tables && !probe.rstrbot_schema {
            store.close().await;
            return Err(Error::Invalid(
                "target contains unrelated tables or an unsupported schema version; select an empty database or a supported RstrBot database".into(),
            ));
        }
        store.migrate().await?;
        Ok(store)
    }

    pub fn backend(&self) -> &'static str {
        self.backend
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn health(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn initialized(&self) -> Result<bool> {
        let value: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM instance_state WHERE key = 'initialized'")
                .fetch_one(&self.pool)
                .await?;
        Ok(value != 0)
    }

    pub async fn recovery_mode(&self) -> Result<bool> {
        let value: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM instance_state WHERE key = 'recovery_mode' AND value = 'true'",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(value != 0)
    }

    /// Explicitly leave restore quarantine after an instance administrator has reviewed pending effects.
    pub async fn finish_recovery(&self, user: &User) -> Result<()> {
        self.require_instance_admin(&user.id).await?;
        sqlx::query("DELETE FROM instance_state WHERE key = 'recovery_mode'")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn migrate(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for statement in SCHEMA {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query(
            "INSERT INTO counters (name, value) VALUES ('event', 0) ON CONFLICT (name) DO NOTHING",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO counters (name, value) VALUES ('identity', 0) ON CONFLICT (name) DO NOTHING")
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO instance_state (key, value) VALUES ('schema_version', '2') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn require_instance_admin(&self, user_id: &str) -> Result<()> {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT instance_admin FROM users WHERE id = $1 AND disabled = 0")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        if found == Some(1) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn checked_label(value: &str, field: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(Error::Invalid(format!(
            "{field} must contain 1–{max} bytes without control characters"
        )));
    }
    Ok(value.to_owned())
}

fn resource_from_row(row: &sqlx::any::AnyRow) -> Result<Resource> {
    let visibility: String = row.try_get("visibility")?;
    Ok(Resource {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        owner_id: row.try_get("owner_id")?,
        kind: row.try_get("kind")?,
        visibility: if visibility == "private" {
            Visibility::Private
        } else {
            Visibility::Workspace
        },
        version: row.try_get("version")?,
        data: serde_json::from_str(&row.try_get::<String, _>("data")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn lock_workspace(tx: &mut Transaction<'_, Any>, workspace: &str) -> Result<()> {
    let changed = sqlx::query("UPDATE workspaces SET revision = revision + 1 WHERE id = $1")
        .bind(workspace)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    if changed == 0 {
        Err(Error::NotFound)
    } else {
        Ok(())
    }
}

async fn role_in(tx: &mut Transaction<'_, Any>, workspace: &str, user: &str) -> Result<Role> {
    let role: Option<String> = sqlx::query_scalar("SELECT m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.disabled = 0")
        .bind(workspace).bind(user).fetch_optional(&mut **tx).await?;
    role.map(|v| Role::parse(&v))
        .transpose()?
        .ok_or(Error::Forbidden)
}

fn unique_error(error: sqlx::Error) -> Error {
    if error
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        Error::Conflict
    } else {
        Error::Database(error)
    }
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS instance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, instance_admin BIGINT NOT NULL DEFAULT 0, disabled BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS members (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK (role IN ('owner','admin','operator','member','viewer')), PRIMARY KEY (workspace_id, user_id))",
    "CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('private','workspace')), version BIGINT NOT NULL, data TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS resources_lookup ON resources(workspace_id, kind, created_at, id)",
    "CREATE INDEX IF NOT EXISTS resources_scan ON resources(kind, created_at, id)",
    "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS events (id BIGINT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL, visibility TEXT NOT NULL, resource_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS events_lookup ON events(workspace_id, id)",
    "CREATE TABLE IF NOT EXISTS budgets (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), limit_microusd BIGINT NOT NULL DEFAULT -1, spent_microusd BIGINT NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0), reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0))",
    "CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL, amount_microusd BIGINT NOT NULL CHECK (amount_microusd >= 0), actual_microusd BIGINT, state TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE(workspace_id, operation_id))",
    "CREATE TABLE IF NOT EXISTS operations (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(workspace_id, user_id, operation_key))",
    "CREATE TABLE IF NOT EXISTS auth_emails (user_id TEXT PRIMARY KEY REFERENCES users(id), email TEXT UNIQUE NOT NULL, verified_at BIGINT NOT NULL, version BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS auth_google (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), subject TEXT UNIQUE NOT NULL, email TEXT, created_at BIGINT NOT NULL, last_used_at BIGINT)",
    "CREATE INDEX IF NOT EXISTS auth_google_user ON auth_google(user_id)",
    "CREATE TABLE IF NOT EXISTS auth_passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), credential_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, credential TEXT NOT NULL, version BIGINT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT)",
    "CREATE INDEX IF NOT EXISTS auth_passkeys_user ON auth_passkeys(user_id)",
    "CREATE TABLE IF NOT EXISTS auth_session_security (token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE, reauthenticated_at BIGINT NOT NULL, auth_method TEXT NOT NULL, credential_id TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS auth_challenges (token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, payload TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges(expires_at)",
    "CREATE INDEX IF NOT EXISTS auth_challenges_user ON auth_challenges(user_id, purpose)",
    "CREATE TABLE IF NOT EXISTS auth_delivery_limits (scope TEXT PRIMARY KEY, last_issued_at BIGINT NOT NULL, hour_started_at BIGINT NOT NULL, hour_count BIGINT NOT NULL, day_started_at BIGINT NOT NULL, day_count BIGINT NOT NULL)",
];
