use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

/// Every failure mode the core can produce.
///
/// The variants exist so that `quest-cli` can map them onto stable exit codes
/// without string-matching. In particular [`Error::NeedsReauth`] is the one an
/// agent keys off of to know "a human must run `quest auth login`".
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The persisted session is gone, expired, or Quest bounced us to the login
    /// page. Non-interactive commands must surface this and stop, never prompt.
    #[error("session is not authenticated: {0}")]
    NeedsReauth(String),

    /// WatIAM rejected the username/password during `auth login`.
    #[error("sign-in was rejected: {0}")]
    BadCredentials(String),

    /// The human did not finish Duo before the timeout. Distinct from
    /// [`Error::NeedsReauth`]: retrying `auth login` is the fix, and no state
    /// was lost.
    #[error("timed out waiting for Duo: {0}")]
    DuoTimeout(String),

    /// The Node session worker could not be started or died unexpectedly.
    #[error("session worker unavailable: {0}")]
    WorkerUnavailable(String),

    /// The worker answered, but with something we could not interpret, or it
    /// reported an internal failure.
    #[error("session worker error: {0}")]
    WorkerFailed(String),

    /// A Quest page did not look the way we expect. This is the "Quest changed
    /// and broke us" signal — it should be loud, never silently-wrong data.
    #[error("could not parse Quest page ({context}): {detail}")]
    Parse { context: String, detail: String },

    /// A command needed input but stdin is not a terminal, or `--interactive`
    /// was not given. Fail fast rather than hang.
    #[error("input required but not available: {0}")]
    NeedsInput(String),

    /// Config file or profile directory is malformed / unusable.
    #[error("configuration problem: {0}")]
    Config(String),

    /// The profile dir had unsafe permissions. Refuse rather than proceed.
    #[error("refusing to use profile dir {path} with insecure permissions ({mode:o})")]
    InsecureProfile { path: PathBuf, mode: u32 },

    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
