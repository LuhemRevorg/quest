//! Stable exit codes. These are a public API — agents branch on them.
//!
//! Values follow `sysexits.h` so they read sensibly to anything already
//! familiar with that convention.

use quest_core::Error;

/// Success.
pub const OK: i32 = 0;
/// Generic, unclassified failure.
pub const FAILURE: i32 = 1;
/// Bad invocation. Documented here for completeness; clap exits with it itself,
/// so nothing in this crate references it.
#[allow(dead_code)]
pub const USAGE: i32 = 2;
/// `EX_NOUSER` — WatIAM rejected the credentials.
pub const BAD_CREDENTIALS: i32 = 67;
/// `EX_UNAVAILABLE` — the session worker or browser could not be started.
pub const UNAVAILABLE: i32 = 69;
/// `EX_TEMPFAIL` — the human ran out of time at the Duo prompt. Retryable.
pub const DUO_TIMEOUT: i32 = 75;
/// `EX_NOINPUT`-ish — input was required but no terminal was available.
pub const NEEDS_INPUT: i32 = 66;
/// `EX_SOFTWARE` — a Quest page did not parse. Quest probably changed.
pub const PARSE_FAILED: i32 = 70;
/// `EX_NOPERM` — **the important one.** No usable session; a human must run
/// `quest auth login`. Never returned for a transient network blip.
pub const NEEDS_REAUTH: i32 = 77;
/// `EX_CONFIG` — config or profile-dir problem.
pub const CONFIG: i32 = 78;

pub fn code_for(err: &Error) -> i32 {
    match err {
        Error::NeedsReauth(_) => NEEDS_REAUTH,
        Error::BadCredentials(_) => BAD_CREDENTIALS,
        Error::DuoTimeout(_) => DUO_TIMEOUT,
        Error::NeedsInput(_) => NEEDS_INPUT,
        Error::WorkerUnavailable(_) => UNAVAILABLE,
        Error::Parse { .. } => PARSE_FAILED,
        Error::Config(_) | Error::InsecureProfile { .. } => CONFIG,
        Error::WorkerFailed(_) | Error::Keyring(_) | Error::Io(_) | Error::Json(_) => FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract an agent depends on: a dead session is 77 and nothing else
    /// is. Worth pinning, because everything downstream branches on it.
    #[test]
    fn dead_session_maps_to_needs_reauth() {
        assert_eq!(
            code_for(&Error::NeedsReauth("expired".into())),
            NEEDS_REAUTH
        );
        assert_eq!(code_for(&Error::NeedsReauth(String::new())), 77);
    }

    #[test]
    fn every_error_maps_to_a_distinct_meaningful_code() {
        let cases = [
            (Error::NeedsReauth(String::new()), NEEDS_REAUTH),
            (Error::BadCredentials(String::new()), BAD_CREDENTIALS),
            (Error::DuoTimeout(String::new()), DUO_TIMEOUT),
            (Error::NeedsInput(String::new()), NEEDS_INPUT),
            (Error::WorkerUnavailable(String::new()), UNAVAILABLE),
            (Error::WorkerFailed(String::new()), FAILURE),
            (
                Error::Parse {
                    context: String::new(),
                    detail: String::new(),
                },
                PARSE_FAILED,
            ),
            (Error::Config(String::new()), CONFIG),
            (
                Error::InsecureProfile {
                    path: "/tmp/p".into(),
                    mode: 0o777,
                },
                CONFIG,
            ),
        ];

        for (err, expected) in cases {
            assert_eq!(code_for(&err), expected, "wrong code for {err:?}");
        }
    }

    /// Codes have to survive the `i32` -> `u8` narrowing in `main`.
    #[test]
    fn all_codes_fit_in_an_exit_status() {
        for code in [
            OK,
            FAILURE,
            USAGE,
            NEEDS_INPUT,
            BAD_CREDENTIALS,
            UNAVAILABLE,
            PARSE_FAILED,
            DUO_TIMEOUT,
            NEEDS_REAUTH,
            CONFIG,
        ] {
            assert!(u8::try_from(code).is_ok(), "{code} does not fit in a u8");
        }
    }
}
