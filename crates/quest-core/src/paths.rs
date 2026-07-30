//! Filesystem layout, and the permission discipline around the profile dir.
//!
//! ```text
//! ~/Library/Application Support/quest/     (macOS; XDG dirs elsewhere)
//! ├── config.toml            0600   non-secret settings (username, profile dir override)
//! ├── profile/               0700   Playwright persistent context — THE credential
//! └── audit.log              0600   append-only record of every mutation (phase 4)
//! ```
//!
//! The password is *not* here. It lives in the OS keychain, and only if
//! explicitly opted in. See [`crate::credentials`].

use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// Root of Quest's own state. Overridable with `QUEST_DATA_DIR` (useful for
/// tests, and for keeping a throwaway profile during development).
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("QUEST_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    directories::ProjectDirs::from("ca", "uwaterloo", "quest")
        .map(|d| d.data_dir().to_path_buf())
        .ok_or_else(|| Error::Config("could not determine a home directory".into()))
}

pub fn config_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("config.toml"))
}

/// The Playwright `launchPersistentContext` user-data dir.
pub fn profile_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("profile"))
}

pub fn audit_log() -> Result<PathBuf> {
    Ok(data_dir()?.join("audit.log"))
}

/// Create `path` if absent and force `0700`, then verify it. Used for the data
/// and profile dirs before anything writes a cookie into them.
pub fn ensure_private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    set_private_dir(path)?;
    assert_private_dir(path)
}

/// Reject a profile dir that is group- or world-accessible. Better to fail than
/// to write session cookies somewhere another local user can read them.
pub fn assert_private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(Error::InsecureProfile {
                path: path.to_path_buf(),
                mode,
            });
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
