//! Spawning and talking to the Node session worker.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use crate::session::protocol::{ErrorCode, Op, Request, Response, Stage};
use crate::{Error, Result};

/// A live Node worker process. Dropping it shuts the child down, so no orphaned
/// Chromium is left holding the lock on the profile dir.
pub struct Worker {
    child: Child,
    /// `None` once closed — dropping the pipe is how we ask for a clean exit.
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Worker {
    /// Locate and start the worker.
    pub fn spawn() -> Result<Self> {
        let script = resolve_script()?;
        let node = std::env::var_os("QUEST_NODE").unwrap_or_else(|| "node".into());

        let mut child = Command::new(&node)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The worker's stderr is human-readable log text; let it flow
            // straight through to the terminal rather than buffering it.
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| {
                Error::WorkerUnavailable(format!(
                    "could not run `{} {}`: {e}",
                    node.to_string_lossy(),
                    script.display()
                ))
            })?;

        // Both are `Some` because we asked for pipes above.
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout was piped"));

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout,
            next_id: 1,
        })
    }

    /// Send one request and pump responses until its terminal line arrives.
    /// `on_progress` is called for each intermediate `Progress`.
    ///
    /// Blocks for as long as the worker takes — during `auth login` that is as
    /// long as the human needs for Duo. The worker owns the timeout, not us, so
    /// there is no second deadline here to disagree with it.
    pub fn call(
        &mut self,
        op: Op,
        on_progress: &mut dyn FnMut(Stage, &str),
    ) -> Result<serde_json::Value> {
        let id = self.next_id;
        self.next_id += 1;

        {
            let stdin = self
                .stdin
                .as_mut()
                .ok_or_else(|| Error::WorkerUnavailable("worker stdin is closed".into()))?;
            let line = serde_json::to_string(&Request { id, op })?;
            stdin.write_all(line.as_bytes())?;
            stdin.write_all(b"\n")?;
            stdin.flush()?;
        }

        loop {
            let mut buf = String::new();
            if self.stdout.read_line(&mut buf)? == 0 {
                return Err(Error::WorkerUnavailable(
                    "worker exited before answering".into(),
                ));
            }
            let line = buf.trim();
            if line.is_empty() {
                continue;
            }

            let response: Response = serde_json::from_str(line)
                .map_err(|e| Error::WorkerFailed(format!("unparseable response: {e}")))?;

            match response {
                Response::Progress {
                    id: rid,
                    stage,
                    message,
                } if rid == id => on_progress(stage, &message),
                Response::Result { id: rid, data } if rid == id => return Ok(data),
                Response::Error {
                    id: rid,
                    code,
                    message,
                } if rid == id => return Err(worker_error(code, message)),
                // A response for some other request id. Nothing sends
                // concurrent requests, so this is only ever noise.
                _ => {}
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Closing stdin gives the worker EOF, which ends its read loop and lets
        // it exit normally. Only escalate to a kill if it does not.
        self.stdin = None;

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => break,
            }
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn worker_error(code: ErrorCode, message: String) -> Error {
    match code {
        ErrorCode::NeedsReauth => Error::NeedsReauth(message),
        ErrorCode::BadCredentials => Error::BadCredentials(message),
        ErrorCode::DuoTimeout => Error::DuoTimeout(message),
        ErrorCode::UnexpectedPage => Error::Parse {
            context: "Quest page".into(),
            detail: message,
        },
        ErrorCode::BrowserLaunchFailed => Error::WorkerUnavailable(message),
        ErrorCode::Internal => Error::WorkerFailed(message),
    }
}

/// Find `worker/dist/index.js`: explicit override, then alongside an installed
/// binary, then the repo layout for `cargo run`.
fn resolve_script() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("QUEST_WORKER_JS") {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(Error::WorkerUnavailable(format!(
                "QUEST_WORKER_JS points at {}, which does not exist",
                path.display()
            )));
        }
        return Ok(path);
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for up in ["", "..", "../.."] {
                candidates.push(dir.join(up).join("worker/dist/index.js"));
            }
        }
    }
    // Development fallback: repo root relative to this crate.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../worker/dist/index.js"));

    candidates
        .into_iter()
        .find(|p| p.exists())
        // Tidy up the `../..` hops so error messages name a readable path.
        .map(|p| p.canonicalize().unwrap_or(p))
        .ok_or_else(|| {
            Error::WorkerUnavailable(
                "session worker not built — run `npm --prefix worker install && \
                 npm --prefix worker run build`, or set QUEST_WORKER_JS"
                    .into(),
            )
        })
}
