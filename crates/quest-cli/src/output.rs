//! Output discipline: stdout carries the payload, stderr carries everything a
//! human reads. Never interleave the two.

use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct Out {
    pub json: bool,
}

impl Out {
    /// Print the payload. In `--json` mode, exactly one JSON document; in human
    /// mode, whatever `human` renders.
    pub fn emit<T: Serialize>(&self, value: &T, human: impl FnOnce(&T) -> String) {
        if self.json {
            // Unwrap: our own model types are infallible to serialize.
            println!("{}", serde_json::to_string_pretty(value).unwrap());
        } else {
            println!("{}", human(value));
        }
    }

    /// Progress and advisory text. Always stderr.
    // Unused until `auth login` starts relaying worker Progress lines.
    #[allow(dead_code)]
    pub fn note(&self, msg: impl AsRef<str>) {
        eprintln!("{}", msg.as_ref());
    }

    /// Terminal error report. JSON mode still writes the error as JSON to
    /// stderr so agents can parse a failure without guessing.
    pub fn error(&self, err: &quest_core::Error, code: i32) {
        if self.json {
            let body = serde_json::json!({
                "error": err.to_string(),
                "exit_code": code,
                "needs_reauth": code == crate::exit::NEEDS_REAUTH,
            });
            eprintln!("{body}");
        } else {
            eprintln!("error: {err}");
            if code == crate::exit::NEEDS_REAUTH {
                eprintln!("hint: run `quest auth login` to establish a new session");
            }
        }
    }
}
