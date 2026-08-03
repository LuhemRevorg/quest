//! Wire format between the Rust CLI and the Node session worker.
//!
//! Newline-delimited JSON over the worker's stdin/stdout; the worker's stderr is
//! plain human/log text and is never parsed. stdio is used rather than a unix
//! socket deliberately — there is no socket file for another local process to
//! connect to, and worker lifetime is exactly the parent's lifetime.
//!
//! **This file and `worker/src/protocol.ts` are two halves of one contract.**
//! Change them together; `worker/src/protocol.ts` carries the same comment.

use serde::{Deserialize, Serialize};

/// Rust -> Node. One request per line.
#[derive(Debug, Clone, Serialize)]
pub struct Request {
    /// Correlates responses to this request. Monotonic per worker process.
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "op", content = "params", rename_all = "snake_case")]
pub enum Op {
    /// Drive the sign-in chain. Attended or unattended, visible or not, per
    /// [`LoginParams`]. Never touches the Duo prompt itself beyond opting into
    /// device trust.
    Login(LoginParams),
    /// Headless. Loads one authenticated Quest page and reports what it found.
    Status(StatusParams),
    /// Sign in, then read one term's grades.
    Grades(GradesParams),
    /// Sign in, then read the classes enrolled in for one term.
    Schedule(ScheduleParams),
    /// Sign in, then search the class schedule for one course's sections.
    Search(SearchParams),
    /// Sign in, then download the *unofficial* transcript.
    ///
    /// There is deliberately no official-transcript op: that is a paid ($20)
    /// order, and nothing in this tool places one.
    Transcript(TranscriptParams),
    /// Clean shutdown of the worker process.
    ///
    /// There is deliberately no `logout` op: dropping the session means deleting
    /// the profile dir, which Rust does directly. Nothing needs a browser.
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusParams {
    pub profile_dir: std::path::PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct GradesParams {
    /// Grades authenticate first, so they carry the full sign-in parameters.
    pub login: LoginParams,
    /// Term as Quest labels it, e.g. "Winter 2026".
    pub term_label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleParams {
    pub login: LoginParams,
    /// Term as Quest labels it, e.g. "Spring 2026".
    pub term_label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchParams {
    pub login: LoginParams,
    /// Term as Quest labels it, e.g. "Fall 2026".
    pub term_label: String,
    /// The same term as its UW code, e.g. "1269". Sent as well as the label because
    /// the search page's term control is a `<select>` whose option *values* are the
    /// codes — so a label the page words differently still resolves.
    pub term_code: String,
    /// Subject code, e.g. "CS".
    pub subject: String,
    /// Catalog number, e.g. "246". Searched with "is exactly".
    pub catalog_number: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptParams {
    pub login: LoginParams,
    /// Which report type to request, matched case-insensitively as a substring of
    /// the option label. `None` takes the sole option, and refuses to guess
    /// between several.
    ///
    /// This cannot order an official transcript whatever it is set to: ordering
    /// lives on a different component, and the worker proves it is on the
    /// unofficial one before pressing anything.
    pub report_type: Option<String>,
    /// How long to wait for the report after pressing "View Report". Separate from
    /// the sign-in timeout — PeopleSoft generates the PDF on demand, and that is
    /// slow in a way that has nothing to do with authentication.
    pub report_timeout_secs: u64,
}

/// How the browser window is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Display {
    /// Visible window. Required for `auth login`, where a human uses it.
    Headed,
    /// No window. The default for everything unattended, and verified to carry the
    /// full sign-in chain end to end.
    Headless,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoginParams {
    pub profile_dir: std::path::PathBuf,
    pub username: Option<String>,
    /// The worker types it into the page and does not log or persist it.
    pub password: Option<String>,
    /// How long to wait before giving up.
    pub duo_timeout_secs: u64,
    /// How to render the browser. Only `auth login` needs a window; the sign-in
    /// chain itself completes headless. See ADR 0004.
    pub display: Display,

    /// Whether a human is watching.
    ///
    /// `true` (`auth login`): wait for someone to complete Duo.
    /// `false` (`auth refresh`): the worker must never block on a human — if one is
    /// needed it fails with `needs_reauth` instead. This is the flag that keeps
    /// data commands from hanging an agent. Independent of [`Display`].
    pub allow_human: bool,
}

/// Node -> Rust. Zero or more `Progress` lines, then exactly one `Result` or
/// `Error` line per request id.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    /// Human-facing status during a long interactive step. Printed to stderr by
    /// the CLI so `--json` stdout stays clean.
    Progress {
        id: u64,
        stage: Stage,
        message: String,
    },
    Result {
        id: u64,
        data: serde_json::Value,
    },
    Error {
        id: u64,
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    LaunchingBrowser,
    NavigatingToQuest,
    /// Already authenticated — a valid session was reused, no login needed.
    SessionReused,
    FillingCredentials,
    /// Handed control to the human for the Duo passcode. The long wait.
    AwaitingDuo,
    /// Clicking through an interstitial that has no credential fields — UW's chain
    /// ends with a "Sign in" page after Duo.
    Continuing,
    RememberingDevice,
    PersistingSession,
    Verifying,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Session dead/absent — maps to [`crate::Error::NeedsReauth`].
    NeedsReauth,
    /// WatIAM rejected the username/password.
    BadCredentials,
    /// The human did not complete Duo in time.
    DuoTimeout,
    /// A page did not look the way the worker expected — Quest likely changed.
    UnexpectedPage,
    BrowserLaunchFailed,
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;

    // These pin the exact JSON that `worker/src/protocol.ts` is written against.
    // If one fails, the two halves of the contract have drifted apart.

    #[test]
    fn login_request_shape() {
        let json = serde_json::to_value(Request {
            id: 7,
            op: Op::Login(LoginParams {
                profile_dir: "/tmp/profile".into(),
                username: Some("jdoe".into()),
                password: None,
                duo_timeout_secs: 300,
                display: Display::Headed,
                allow_human: true,
            }),
        })
        .unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "id": 7,
                "op": "login",
                "params": {
                    "profile_dir": "/tmp/profile",
                    "username": "jdoe",
                    "password": null,
                    "duo_timeout_secs": 300,
                    "display": "headed",
                    "allow_human": true,
                }
            })
        );
    }

    /// The unattended variant, which the worker must never let block on a human.
    #[test]
    fn unattended_login_request_shape() {
        let json = serde_json::to_value(Request {
            id: 2,
            op: Op::Login(LoginParams {
                profile_dir: "/tmp/profile".into(),
                username: Some("jdoe".into()),
                password: Some("hunter2".into()),
                duo_timeout_secs: 60,
                display: Display::Headless,
                allow_human: false,
            }),
        })
        .unwrap();

        assert_eq!(json["params"]["allow_human"], false);
        // Headless is the unattended default: with no window, a passing run proves
        // no human was involved.
        assert_eq!(json["params"]["display"], "headless");
        assert_eq!(json["params"]["password"], "hunter2");
    }

    #[test]
    fn status_request_shape() {
        let json = serde_json::to_value(Request {
            id: 1,
            op: Op::Status(StatusParams {
                profile_dir: "/tmp/profile".into(),
            }),
        })
        .unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "id": 1,
                "op": "status",
                "params": { "profile_dir": "/tmp/profile" }
            })
        );
    }

    /// The class search sends both spellings of the term — see [`SearchParams`] —
    /// plus the two criteria. `worker/src/handlers/search.ts` reads exactly these
    /// names.
    #[test]
    fn search_request_shape() {
        let json = serde_json::to_value(Request {
            id: 11,
            op: Op::Search(SearchParams {
                login: LoginParams {
                    profile_dir: "/tmp/profile".into(),
                    username: Some("jdoe".into()),
                    password: Some("hunter2".into()),
                    duo_timeout_secs: 60,
                    display: Display::Headless,
                    allow_human: false,
                },
                term_label: "Fall 2026".into(),
                term_code: "1269".into(),
                subject: "CS".into(),
                catalog_number: "246".into(),
            }),
        })
        .unwrap();

        assert_eq!(json["op"], "search");
        assert_eq!(json["params"]["term_label"], "Fall 2026");
        assert_eq!(json["params"]["term_code"], "1269");
        assert_eq!(json["params"]["subject"], "CS");
        assert_eq!(json["params"]["catalog_number"], "246");
        // A data command signs in itself, and never waits on a human to do it.
        assert_eq!(json["params"]["login"]["allow_human"], false);
    }

    /// The transcript op nests `login` the same way `grades` does, and carries its
    /// own report deadline. `report_type: null` is the normal case — it means "the
    /// unofficial one", which the worker resolves.
    #[test]
    fn transcript_request_shape() {
        let json = serde_json::to_value(Request {
            id: 9,
            op: Op::Transcript(TranscriptParams {
                login: LoginParams {
                    profile_dir: "/tmp/profile".into(),
                    username: Some("jdoe".into()),
                    password: Some("hunter2".into()),
                    duo_timeout_secs: 60,
                    display: Display::Headless,
                    allow_human: false,
                },
                report_type: None,
                report_timeout_secs: 120,
            }),
        })
        .unwrap();

        assert_eq!(json["op"], "transcript");
        assert_eq!(json["params"]["report_type"], serde_json::Value::Null);
        assert_eq!(json["params"]["report_timeout_secs"], 120);
        // The whole point of nesting `login`: a data command signs in itself.
        assert_eq!(json["params"]["login"]["allow_human"], false);
    }

    /// The literal bytes `Worker::drop` writes, so the shutdown path cannot rot.
    #[test]
    fn shutdown_request_is_recognised_by_the_worker() {
        let json = serde_json::to_value(Request {
            id: 0,
            op: Op::Shutdown,
        })
        .unwrap();
        assert_eq!(json["op"], "shutdown");
    }

    #[test]
    fn parses_each_response_kind() {
        let progress: Response = serde_json::from_str(
            r#"{"kind":"progress","id":3,"stage":"awaiting_duo","message":"go"}"#,
        )
        .unwrap();
        assert!(matches!(
            progress,
            Response::Progress {
                id: 3,
                stage: Stage::AwaitingDuo,
                ..
            }
        ));

        let result: Response =
            serde_json::from_str(r#"{"kind":"result","id":4,"data":{"state":"live"}}"#).unwrap();
        assert!(matches!(result, Response::Result { id: 4, .. }));

        let error: Response = serde_json::from_str(
            r#"{"kind":"error","id":5,"code":"needs_reauth","message":"dead"}"#,
        )
        .unwrap();
        assert!(matches!(
            error,
            Response::Error {
                id: 5,
                code: ErrorCode::NeedsReauth,
                ..
            }
        ));
    }

    /// Every `Stage` the worker can emit must deserialize; a typo on either side
    /// would otherwise only show up mid-login.
    #[test]
    fn every_stage_name_round_trips() {
        for name in [
            "launching_browser",
            "navigating_to_quest",
            "session_reused",
            "filling_credentials",
            "awaiting_duo",
            "continuing",
            "remembering_device",
            "persisting_session",
            "verifying",
        ] {
            let line = format!(r#"{{"kind":"progress","id":1,"stage":"{name}","message":""}}"#);
            serde_json::from_str::<Response>(&line)
                .unwrap_or_else(|e| panic!("stage {name} did not parse: {e}"));
        }
    }

    #[test]
    fn every_error_code_round_trips() {
        for name in [
            "needs_reauth",
            "bad_credentials",
            "duo_timeout",
            "unexpected_page",
            "browser_launch_failed",
            "internal",
        ] {
            let line = format!(r#"{{"kind":"error","id":1,"code":"{name}","message":""}}"#);
            serde_json::from_str::<Response>(&line)
                .unwrap_or_else(|e| panic!("code {name} did not parse: {e}"));
        }
    }
}
