//! RstrBot's bounded JSON-RPC 2.0 plugin boundary.
//!
//! The host starts a fresh, isolated *process* for each invocation. This is a
//! fault boundary, not a sandbox: only an instance administrator may register
//! trusted executables. Workspace authorization remains the core's job.

mod host;
mod manifest;
pub mod provider;
pub mod sdk;
pub mod webhook;

pub use host::{InstanceContext, PluginHost, RpcEvent};
pub use manifest::{Manifest, Timeouts, validate_manifest};

/// The protocol version implemented by the host and SDKs.
pub const PROTOCOL_VERSION: &str = "1.0";
/// Maximum serialized size of one wire frame, excluding its newline.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Actionable failures that do not expose provider credentials or raw stderr.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("invalid plugin manifest: {0}")]
    InvalidManifest(String),
    #[error("plugin executable checksum does not match the installed manifest")]
    ChecksumMismatch,
    #[error("plugin capability does not allow method {0}")]
    CapabilityDenied(String),
    #[error("plugin could not start: {0}")]
    Spawn(String),
    #[error("plugin {0} timed out")]
    Timeout(&'static str),
    #[error("plugin invocation was cancelled; a write may still need reconciliation")]
    Cancelled,
    #[error("plugin protocol violation: {0}")]
    Protocol(String),
    #[error("plugin stream consumer is too slow; reconnect using persisted run events")]
    Backpressure,
    #[error("plugin returned {code}: {message}")]
    Remote { code: i64, message: String },
    #[error("plugin transport is unavailable on this platform")]
    UnsupportedPlatform,
    #[error("plugin I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

impl PluginError {
    /// Stable error code for API and diagnostic output.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidManifest(_) => "invalid_manifest",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::CapabilityDenied(_) => "capability_denied",
            Self::Spawn(_) => "plugin_start_failed",
            Self::Timeout(_) => "plugin_timeout",
            Self::Cancelled => "cancelled",
            Self::Protocol(_) => "protocol_error",
            Self::Backpressure => "slow_consumer",
            Self::Remote { code: -32041, .. } => "provider_authentication_failed",
            Self::Remote { code: -32043, .. } => "provider_access_denied",
            Self::Remote { code: -32029, .. } => "provider_rate_limited",
            Self::Remote { .. } => "plugin_error",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::Io(_) => "plugin_io_error",
        }
    }
}
