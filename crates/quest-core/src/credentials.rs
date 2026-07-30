//! Password handling. Keychain-or-prompt, never a file.
//!
//! Rules encoded here:
//!   * plaintext storage is not an option the API can express;
//!   * retrieval is best-effort — a missing entry is a normal state that means
//!     "prompt the human", not an error;
//!   * Duo passcodes are *never* stored, cached, or passed through this module.
//!     They are typed into the live browser by the human, once.

use std::time::Duration;

use crate::{Error, Result};

const SERVICE: &str = "ca.uwaterloo.quest";

/// Ceiling on a keychain read for non-interactive callers. Generous for an
/// already-authorised read (microseconds) and short enough that an agent is not
/// left hanging.
pub const NON_INTERACTIVE_TIMEOUT: Duration = Duration::from_secs(10);

fn entry(username: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, username)?)
}

/// Fetch the stored WatIAM password. `Ok(None)` means "nothing stored" — a
/// normal state, not a failure.
pub fn get_password(username: &str) -> Result<Option<String>> {
    match entry(username)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Like [`get_password`], but it cannot block forever.
///
/// The OS keychain is not a plain data store: on macOS, a read from a binary that
/// has not been granted access pops a `SecurityAgent` dialog and blocks until
/// somebody clicks it. Observed in practice — `auth refresh` sat indefinitely on
/// an invisible prompt, which is precisely the hang the non-interactive contract
/// exists to prevent.
///
/// So callers that must not block get a deadline, and a timeout is reported as
/// [`Error::NeedsReauth`] → exit 77: a human is required, which is true. The
/// worker thread is abandoned rather than cancelled (there is no way to cancel a
/// blocked keychain call); it dies with the process.
pub fn get_password_non_blocking(username: &str) -> Result<Option<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let username = username.to_owned();

    std::thread::spawn(move || {
        // A send failure just means we already timed out and nobody is listening.
        let _ = tx.send(get_password(&username));
    });

    match rx.recv_timeout(NON_INTERACTIVE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(Error::NeedsReauth(format!(
            "timed out after {}s reading the password from the OS keychain — it is \
             probably waiting on an access-permission dialog. Run `quest auth login` \
             once and choose \"Always Allow\" to grant access.",
            NON_INTERACTIVE_TIMEOUT.as_secs()
        ))),
    }
}

pub fn set_password(username: &str, password: &str) -> Result<()> {
    entry(username)?.set_password(password)?;
    Ok(())
}

/// Remove the stored password. Deleting something that is already absent is
/// success, not an error — `auth logout --forget-password` should be idempotent.
pub fn delete_password(username: &str) -> Result<()> {
    match entry(username)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property that matters: a non-interactive keychain read always returns.
    /// If it ever blocks on a `SecurityAgent` dialog again, this test hangs the
    /// suite rather than shipping a CLI that hangs an agent.
    #[test]
    fn non_blocking_read_is_bounded() {
        let start = std::time::Instant::now();
        let result = get_password_non_blocking("quest-test-account-that-does-not-exist");
        let elapsed = start.elapsed();

        assert!(
            elapsed < NON_INTERACTIVE_TIMEOUT + Duration::from_secs(5),
            "keychain read took {elapsed:?}, which is past the deadline"
        );

        // Either "nothing stored" or the timeout surfaced as NeedsReauth. Both are
        // acceptable; blocking forever is not.
        match result {
            Ok(None) => {}
            Err(Error::NeedsReauth(_)) => {}
            other => panic!("unexpected result from a missing entry: {other:?}"),
        }
    }
}
