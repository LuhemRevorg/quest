//! Non-secret, user-editable settings.
//!
//! Invariant: nothing secret is ever serialized here. The WatIAM password lives
//! in the OS keychain ([`crate::credentials`]) or nowhere at all.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{paths, Error, Result};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// WatIAM username (8-char userid). Not a secret; saved for convenience so
    /// `auth login` only has to prompt for the password.
    pub username: Option<String>,

    /// Opt-in: store the password in the OS keychain instead of prompting.
    /// Defaults to false — a cold login is ~monthly and the Duo passcode is
    /// being typed anyway, so prompting costs nothing.
    pub store_password_in_keychain: bool,

    /// Override for the Playwright profile dir. Must be on a local,
    /// non-cloud-synced disk.
    pub profile_dir: Option<PathBuf>,
}

impl Config {
    /// Read the config file. A missing file is the normal first-run state and
    /// yields defaults; a *malformed* file is an error, so a typo never silently
    /// resets settings.
    pub fn load() -> Result<Self> {
        let path = paths::config_file()?;
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                toml::from_str(&text).map_err(|e| Error::Config(format!("{}: {e}", path.display())))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Write the config file at `0600`, atomically via a temp file + rename so an
    /// interrupted write cannot leave a truncated config behind.
    pub fn save(&self) -> Result<()> {
        let path = paths::config_file()?;
        let dir = path
            .parent()
            .ok_or_else(|| Error::Config("config path has no parent".into()))?;
        paths::ensure_private_dir(dir)?;

        let text = toml::to_string_pretty(self)
            .map_err(|e| Error::Config(format!("could not serialize config: {e}")))?;

        let tmp = path.with_extension("toml.tmp");
        write_private(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Where the persistent browser context lives, honouring any override.
    pub fn resolved_profile_dir(&self) -> Result<PathBuf> {
        match &self.profile_dir {
            Some(dir) => Ok(dir.clone()),
            None => paths::profile_dir(),
        }
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
