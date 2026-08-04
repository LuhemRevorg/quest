//! `quest transcript` — download the unofficial transcript.
//!
//! The one data command whose payload is a file. Everything about *where* that
//! file goes is decided here, before the browser is launched, so a bad path fails
//! in milliseconds instead of after a twenty-second sign-in.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use quest_core::config::Config;
use quest_core::model::transcript::{
    default_file_name, RawTranscript, TranscriptDownload, TranscriptFormat,
};
use quest_core::session::protocol::{LoginParams, Op, TranscriptParams};
use quest_core::session::Worker;
use quest_core::{credentials, paths, Error, Result};

use crate::cli::TranscriptArgs;
use crate::output::Out;

/// Where the report is going. The name can only be settled once the format is
/// known, so a directory destination stays open until then.
enum Destination {
    /// The user named a file.
    Exact(PathBuf),
    /// A directory: the dated default name goes inside it.
    InDir(PathBuf),
}

/// Fully non-interactive, like every data command.
pub fn transcript(args: &TranscriptArgs, out: Out) -> Result<TranscriptDownload> {
    // Resolved and checked first: there is no point signing in to produce bytes we
    // have nowhere to put.
    let destination = resolve_destination(args.output.as_deref())?;
    preflight(&destination, args.force)?;

    let config = Config::load()?;
    let username = config.username.clone().ok_or_else(|| {
        Error::NeedsReauth("no username on record — run `quest auth login`".into())
    })?;
    let password = credentials::get_password_non_blocking(&username)?.ok_or_else(|| {
        Error::NeedsReauth(
            "no stored password — run `quest auth login --save-password` to enable \
             unattended access"
                .into(),
        )
    })?;

    let profile_dir = config.resolved_profile_dir()?;
    paths::ensure_private_dir(&profile_dir)?;

    out.note("downloading your unofficial transcript");

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Transcript(TranscriptParams {
            login: LoginParams {
                profile_dir,
                username: Some(username),
                password: Some(password),
                duo_timeout_secs: args.timeout,
                display: args.display.into(),
                allow_human: false,
            },
            report_type: args.report_type.clone(),
            report_timeout_secs: args.report_timeout,
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let raw: RawTranscript = serde_json::from_value(data)?;
    let bytes = raw.decode()?;

    let path = match &destination {
        Destination::Exact(path) => path.clone(),
        Destination::InDir(dir) => dir.join(default_file_name(
            raw.format,
            chrono::Local::now().date_naive(),
        )),
    };
    // Re-checked here because the name of a directory destination was not knowable
    // until the format came back.
    refuse_existing(&path, args.force)?;
    write_private(&path, &bytes, args.force)?;

    if raw.format != TranscriptFormat::Pdf {
        out.note(format!(
            "note: Quest returned {} rather than a PDF — saved as-is",
            match raw.format {
                TranscriptFormat::Html => "a web page",
                _ => "something unrecognised",
            }
        ));
    }

    Ok(raw.into_typed(path))
}

/// A directory (existing, or given with a trailing separator) collects the default
/// name; anything else is taken as the filename itself.
///
/// With no `--output` at all the report goes to the OS Downloads folder — the same
/// place the browser this replaces would have put it — rather than to whatever
/// directory the command happened to be run from. See [`paths::downloads_dir`].
fn resolve_destination(output: Option<&Path>) -> Result<Destination> {
    let Some(output) = output else {
        return Ok(Destination::InDir(paths::downloads_dir()?));
    };
    if output.is_dir() {
        return Ok(Destination::InDir(output.to_path_buf()));
    }
    Ok(Destination::Exact(output.to_path_buf()))
}

/// Everything about the destination that can be known before the download.
fn preflight(destination: &Destination, force: bool) -> Result<()> {
    match destination {
        Destination::Exact(path) => {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
            if let Some(parent) = parent {
                if !parent.is_dir() {
                    return Err(Error::Config(format!(
                        "cannot write {}: {} is not a directory",
                        path.display(),
                        parent.display()
                    )));
                }
            }
            refuse_existing(path, force)
        }
        Destination::InDir(dir) => {
            if !dir.is_dir() {
                return Err(Error::Config(format!(
                    "cannot write into {}: not a directory",
                    dir.display()
                )));
            }
            // The real name depends on the format, which is not known yet. PDF is
            // what Quest sends, so checking that name now catches the common
            // "already downloaded it today" case before the sign-in rather than
            // after; the authoritative check happens again at write time.
            refuse_existing(
                &dir.join(default_file_name(
                    TranscriptFormat::Pdf,
                    chrono::Local::now().date_naive(),
                )),
                force,
            )
        }
    }
}

fn refuse_existing(path: &Path, force: bool) -> Result<()> {
    if force || !path.exists() {
        return Ok(());
    }
    Err(Error::Config(format!(
        "{} already exists — pass --force to overwrite, or --output to choose another name",
        path.display()
    )))
}

/// Write the report `0600`.
///
/// A transcript is the whole academic record; it gets the same treatment as the
/// profile dir rather than whatever the umask happens to be. `create_new` unless
/// `--force`, so the pre-flight check cannot be raced.
fn write_private(path: &Path, bytes: &[u8], force: bool) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).truncate(true);
    if force {
        options.create(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            Error::Config(format!(
                "{} appeared while the transcript was downloading — pass --force to overwrite",
                path.display()
            ))
        } else {
            Error::Io(e)
        }
    })?;

    // `mode` above only applies when the file is created, so `--force` over an
    // existing world-readable file would otherwise keep its permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }

    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Human-readable summary. `--json` bypasses this entirely.
pub fn render(download: &TranscriptDownload) -> String {
    let format = match download.format {
        TranscriptFormat::Pdf => "PDF",
        TranscriptFormat::Html => "HTML",
        TranscriptFormat::Unknown => "unrecognised",
    };

    let mut lines = vec!["saved your unofficial transcript".to_owned()];
    if let Some(report) = &download.report_type {
        lines.push(format!("  report:  {report}"));
    }
    if let Some(institution) = &download.institution {
        lines.push(format!("  from:    {institution}"));
    }
    lines.push(format!(
        "  format:  {format}, {}",
        human_bytes(download.byte_length)
    ));
    lines.push(format!("  sha256:  {}", download.sha256));
    lines.push(format!("  path:    {}", download.path.display()));
    lines.join("\n")
}

fn human_bytes(bytes: usize) -> String {
    #[allow(clippy::cast_precision_loss)]
    let size = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", size / 1024.0)
    } else {
        format!("{:.1} MB", size / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_destination_keeps_the_default_name() {
        let dir = std::env::temp_dir();
        assert!(matches!(
            resolve_destination(Some(&dir)).unwrap(),
            Destination::InDir(_)
        ));
        assert!(matches!(
            resolve_destination(Some(Path::new("/tmp/my-transcript.pdf"))).unwrap(),
            Destination::Exact(_)
        ));
    }

    /// No `--output` means the Downloads folder, not the working directory: a
    /// report saved wherever the shell happened to be is a report you have to go
    /// looking for.
    ///
    /// Uses `QUEST_DOWNLOAD_DIR` rather than reading the real one, and runs
    /// single-threaded (`--test-threads=1` is not assumed — the variable is set and
    /// removed around one call, and no other test reads it).
    #[test]
    fn no_output_goes_to_the_downloads_folder() {
        let wanted = std::env::temp_dir().join("quest-downloads-test");
        std::fs::create_dir_all(&wanted).unwrap();

        // SAFETY: single mutation, immediately read back; no other test touches it.
        unsafe { std::env::set_var("QUEST_DOWNLOAD_DIR", &wanted) };
        let destination = resolve_destination(None).unwrap();
        unsafe { std::env::remove_var("QUEST_DOWNLOAD_DIR") };

        match destination {
            Destination::InDir(dir) => assert_eq!(dir, wanted),
            Destination::Exact(path) => {
                panic!(
                    "expected the downloads dir, got the exact path {}",
                    path.display()
                )
            }
        }

        std::fs::remove_dir_all(&wanted).ok();
    }

    #[test]
    fn refuses_an_existing_file_unless_forced() {
        let path = std::env::temp_dir().join("quest-transcript-preflight-test");
        std::fs::write(&path, b"x").unwrap();

        let err = refuse_existing(&path, false).unwrap_err();
        assert!(err.to_string().contains("--force"), "{err}");
        assert!(refuse_existing(&path, true).is_ok());

        std::fs::remove_file(&path).ok();
    }

    /// A transcript is the whole academic record; the umask does not get a vote.
    #[cfg(unix)]
    #[test]
    fn writes_the_report_privately() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join("quest-transcript-write-test.pdf");
        std::fs::remove_file(&path).ok();

        write_private(&path, b"%PDF-1.4\n", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");

        // Without --force the existing file is left alone.
        assert!(write_private(&path, b"other", false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4\n");

        // With it, the contents are replaced and the mode is re-asserted.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"new", true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sizes_read_sensibly() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(2048), "2.0 KB");
        assert_eq!(human_bytes(3 * 1024 * 1024), "3.0 MB");
    }
}
