mod cli;
mod commands;
mod exit;
mod output;

use clap::Parser;

use cli::{AuthCommand, Cli, Command};
use output::Out;
use quest_core::model::auth::{AuthStatus, SessionState};

fn main() -> std::process::ExitCode {
    let args = Cli::parse();
    let out = Out { json: args.json };

    let code = match run(&args, out) {
        Ok(code) => code,
        Err(err) => {
            let code = exit::code_for(&err);
            out.error(&err, code);
            code
        }
    };
    // All our codes fit in a u8; clamp defensively rather than wrap silently.
    std::process::ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn run(args: &Cli, out: Out) -> quest_core::Result<i32> {
    match &args.command {
        Command::Auth { command } => match command {
            AuthCommand::Login(login_args) => {
                let status = commands::auth::login(login_args, out)?;
                out.emit(&status, render_status);
                Ok(exit::OK)
            }
            AuthCommand::Status => {
                let status = commands::auth::status(out)?;
                out.emit(&status, render_status);
                // A report, not an assertion: `status` exits 0 having
                // successfully answered the question. Data commands are the ones
                // that turn a dead session into NEEDS_REAUTH.
                Ok(exit::OK)
            }
            AuthCommand::Refresh(refresh_args) => {
                let status = commands::auth::refresh(refresh_args, out)?;
                out.emit(&status, render_status);
                // Unlike `status`, this one asserts. A caller running `refresh`
                // wants a usable session, so anything else is a failure — and any
                // failure path in `refresh` already returns NeedsReauth.
                Ok(if status.state.is_usable() {
                    exit::OK
                } else {
                    exit::NEEDS_REAUTH
                })
            }
            AuthCommand::Logout(logout_args) => {
                let report = commands::auth::logout(logout_args, out)?;
                out.emit(&report, |report| {
                    if report.profile_removed {
                        "session cleared".to_owned()
                    } else {
                        "nothing to clear".to_owned()
                    }
                });
                Ok(exit::OK)
            }
        },

        Command::Grades(grades_args) => {
            let grades = commands::grades::grades(grades_args, out)?;
            out.emit(&grades, commands::grades::render);
            Ok(exit::OK)
        }
    }
}

fn render_status(status: &AuthStatus) -> String {
    let state = match status.state {
        SessionState::Live => "live",
        SessionState::ExpiredTrustValid => "expired (Duo device trust still valid)",
        SessionState::Expired => "expired",
        SessionState::NeverLoggedIn => "never logged in",
    };

    let mut lines = vec![format!("session: {state}")];
    if let Some(username) = &status.username {
        lines.push(format!("user:    {username}"));
    }
    if let Some(trust) = status.device_trust_expires_at {
        lines.push(format!(
            "duo trust expires: {}   (no passcode needed until then)",
            trust.format("%Y-%m-%d %H:%M UTC")
        ));
    }
    match status.sso_expires_at {
        Some(sso) => lines.push(format!(
            "sso expires:       {}   (no password needed until then)",
            sso.format("%Y-%m-%d %H:%M UTC")
        )),
        // The difference between "works unattended" and "needs a human".
        None if status.profile_present => lines.push(
            "sso:               not persisted — the next command needs a password".to_owned(),
        ),
        None => {}
    }
    if let Some(session) = status.session_expires_at {
        lines.push(format!(
            "session expires:   {}",
            session.format("%Y-%m-%d %H:%M UTC")
        ));
    }
    if !status.state.is_usable() {
        lines.push("\nrun `quest auth login` to establish a session".to_owned());
    }
    lines.join("\n")
}
