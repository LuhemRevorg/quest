//! The Phase 1 contract: what `quest auth status` reports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Result of probing the persisted session against Quest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub schema_version: u32,

    pub state: SessionState,

    /// Whether a profile dir exists on disk at all.
    pub profile_present: bool,

    /// WatIAM username the profile belongs to, if known from config.
    pub username: Option<String>,

    /// Expiry of the Duo "remember this device for 30 days" trust, derived from
    /// the cookie's own expiry rather than guessed from the login date.
    ///
    /// When this is live, a re-login needs no passcode.
    pub device_trust_expires_at: Option<DateTime<Utc>>,

    /// Expiry of the ADFS single-sign-on cookie, which is persistent only when
    /// "keep me signed in" was ticked.
    ///
    /// This is the one that decides whether a command can re-authenticate with no
    /// human at all. `None` means the next command needs a password typed, even if
    /// Duo device trust is still valid.
    pub sso_expires_at: Option<DateTime<Utc>>,

    /// Expiry of the shortest-lived cookie the Quest session actually depends
    /// on. Quest's own session cookie is typically session-scoped, so this is
    /// often `None` even for a live session.
    pub session_expires_at: Option<DateTime<Utc>>,

    /// When we last successfully proved the session by loading an
    /// authenticated page.
    pub last_verified_at: Option<DateTime<Utc>>,
}

impl AuthStatus {
    /// The answer when no profile dir exists. Reportable without launching a
    /// browser at all.
    pub fn never_logged_in(username: Option<String>) -> Self {
        Self {
            schema_version: super::SCHEMA_VERSION,
            state: SessionState::NeverLoggedIn,
            profile_present: false,
            username,
            device_trust_expires_at: None,
            sso_expires_at: None,
            session_expires_at: None,
            last_verified_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// Loaded an authenticated Quest page and confirmed we are past login.
    Live,
    /// The Quest session is dead, but Duo device trust is still valid — a
    /// re-login will not require a fresh passcode.
    ExpiredTrustValid,
    /// Nothing usable: full interactive login with a Duo passcode required.
    Expired,
    /// No profile dir has ever been established.
    NeverLoggedIn,
}

impl SessionState {
    /// Only `Live` lets a data command proceed. Everything else is
    /// `NEEDS_REAUTH`.
    pub fn is_usable(self) -> bool {
        matches!(self, SessionState::Live)
    }
}
