//! `quest auth login | status | logout`.

use std::io::{IsTerminal, Write};

use quest_core::config::Config;
use quest_core::model::auth::AuthStatus;
use quest_core::session::protocol::{Display, LoginParams, Op, StatusParams};
use quest_core::session::Worker;
use quest_core::{credentials, model, paths, Error, Result};
use serde::Serialize;

use crate::cli::{LoginArgs, LogoutArgs, RefreshArgs};
use crate::output::Out;

/// Interactive by design: this is the one command allowed to block on a human,
/// so it prompts regardless of the global `--interactive` flag.
pub fn login(args: &LoginArgs, out: Out) -> Result<AuthStatus> {
    let mut config = Config::load()?;

    let username = match args.username.clone().or_else(|| config.username.clone()) {
        Some(username) => username,
        None => prompt_line("WatIAM username (e.g. jdoe@uwaterloo.ca): ")?,
    };

    // UW's ADFS wants the full address, not the bare 8-character userid. Passing the
    // short form gets you a rejected sign-in *and* a keychain entry filed under the
    // wrong account, so it is worth saying before we spend a browser launch on it.
    if !username.contains('@') {
        out.note(format!(
            "note: ADFS expects a full address — try `{username}@uwaterloo.ca` if sign-in fails"
        ));
    }

    // Changing the recorded username orphans any password stored under the old one.
    if let Some(previous) = config.username.as_deref() {
        if previous != username && config.store_password_in_keychain {
            out.note(format!(
                "note: username changed from `{previous}`; its keychain entry is now unused. \
                 Remove it with `security delete-generic-password -s ca.uwaterloo.quest \
                 -a {previous}`"
            ));
        }
    }

    let password = resolve_password(&config, &username, args.save_password, out)?;

    let profile_dir = config.resolved_profile_dir()?;
    paths::ensure_private_dir(&profile_dir)?;

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Login(LoginParams {
            profile_dir,
            username: Some(username.clone()),
            password: password.clone(),
            duo_timeout_secs: args.duo_timeout,
            // A human is about to use this window, so it must be visible.
            display: Display::Headed,
            allow_human: true,
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let mut status: AuthStatus = serde_json::from_value(data)?;
    status.username = Some(username.clone());

    // Only persist settings once the login actually worked.
    config.username = Some(username.clone());
    if args.save_password {
        match &password {
            Some(password) => {
                credentials::set_password(&username, password)?;
                config.store_password_in_keychain = true;
                out.note("password saved to the OS keychain");
            }
            None => {
                out.note("note: --save-password had nothing to save (no password was entered here)")
            }
        }
    }
    config.save()?;

    Ok(status)
}

/// Fully non-interactive. Reports the state of the persisted session without
/// ever attempting to repair it.
pub fn status(out: Out) -> Result<AuthStatus> {
    let config = Config::load()?;
    let profile_dir = config.resolved_profile_dir()?;

    // Short-circuit: no profile means no session, and no reason to pay for a
    // browser launch to find that out.
    if !profile_dir.exists() {
        return Ok(AuthStatus::never_logged_in(config.username));
    }
    paths::assert_private_dir(&profile_dir)?;

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Status(StatusParams { profile_dir }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let mut status: AuthStatus = serde_json::from_value(data)?;
    status.username = config.username;
    Ok(status)
}

/// Establish a session with no human involved. This is the mechanism every data
/// command will sit on, so its contract is strict: it never prompts, never blocks
/// on a person, and turns "a human is required" into
/// [`Error::NeedsReauth`] → exit 77.
///
/// UW disables ADFS keep-me-signed-in (ADR 0003), so this needs the keychain
/// password. Duo passes silently on the 30-day device trust.
pub fn refresh(args: &RefreshArgs, out: Out) -> Result<AuthStatus> {
    let config = Config::load()?;

    let username = config.username.clone().ok_or_else(|| {
        Error::NeedsReauth("no username on record — run `quest auth login`".into())
    })?;

    // Never prompt here, whatever the terminal looks like, and never block: the
    // keychain read is bounded because macOS can put an access dialog in front of
    // it. A missing password is NeedsReauth, not a question.
    let password = credentials::get_password_non_blocking(&username)?.ok_or_else(|| {
        Error::NeedsReauth(
            "no stored password — run `quest auth login --save-password` to enable \
             unattended sign-in"
                .into(),
        )
    })?;

    let profile_dir = config.resolved_profile_dir()?;
    paths::ensure_private_dir(&profile_dir)?;

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Login(LoginParams {
            profile_dir,
            username: Some(username.clone()),
            password: Some(password),
            duo_timeout_secs: args.timeout,
            display: args.display.into(),
            allow_human: false,
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let mut status: AuthStatus = serde_json::from_value(data)?;
    status.username = Some(username);
    Ok(status)
}

#[derive(Debug, Serialize)]
pub struct LogoutReport {
    pub schema_version: u32,
    /// False when there was nothing to remove — `logout` is idempotent.
    pub profile_removed: bool,
    pub password_forgotten: bool,
}

/// Deleting the profile dir *is* dropping the session: the Quest cookies and the
/// Duo device trust both live there, so the next login needs a fresh passcode.
///
/// We deliberately do not visit Quest's own sign-out page. That would need a
/// working session to be useful, and the local secret is the thing that actually
/// matters — anyone holding this profile dir holds the whole student record.
pub fn logout(args: &LogoutArgs, out: Out) -> Result<LogoutReport> {
    let mut config = Config::load()?;
    let profile_dir = config.resolved_profile_dir()?;

    let profile_removed = if profile_dir.exists() {
        std::fs::remove_dir_all(&profile_dir)?;
        out.note(format!("removed session profile {}", profile_dir.display()));
        true
    } else {
        out.note("no session profile to remove");
        false
    };

    let mut password_forgotten = false;
    if args.forget_password {
        match &config.username {
            Some(username) => {
                credentials::delete_password(username)?;
                config.store_password_in_keychain = false;
                config.save()?;
                password_forgotten = true;
                out.note("removed stored password from the OS keychain");
            }
            None => out.note("no username on record, so no keychain entry to remove"),
        }
    }

    Ok(LogoutReport {
        schema_version: model::SCHEMA_VERSION,
        profile_removed,
        password_forgotten,
    })
}

/// Get the password to type into the login page, or `None` to let the human type
/// it into the browser themselves.
fn resolve_password(
    config: &Config,
    username: &str,
    save_password: bool,
    out: Out,
) -> Result<Option<String>> {
    if config.store_password_in_keychain {
        if let Some(password) = credentials::get_password(username)? {
            return Ok(Some(password));
        }
    }
    if !std::io::stdin().is_terminal() {
        // Not fatal: the browser is headed, so the human can still type it there.
        return Ok(None);
    }
    if save_password {
        out.note("the password will be stored in the OS keychain");
    }
    out.note("press Enter to skip and type your password in the browser window instead");
    let password = rpassword::prompt_password(format!("WatIAM password for {username}: "))
        .map_err(|e| Error::NeedsInput(format!("could not read password: {e}")))?;

    Ok(if password.is_empty() {
        None
    } else {
        Some(password)
    })
}

fn prompt_line(prompt: &str) -> Result<String> {
    if !std::io::stdin().is_terminal() {
        return Err(Error::NeedsInput(
            "no WatIAM username — pass --username, or set it in the config file".into(),
        ));
    }
    eprint!("{prompt}");
    std::io::stderr().flush()?;

    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let line = line.trim().to_owned();
    if line.is_empty() {
        return Err(Error::NeedsInput("no username entered".into()));
    }
    Ok(line)
}
