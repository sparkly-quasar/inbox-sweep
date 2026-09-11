//! Persistence for the desktop build's long-lived credentials.
//!
//! This is the one place where the desktop app is meaningfully different from
//! the browser build in security terms. The browser keeps its access token in
//! `sessionStorage`, so it dies with the tab and nothing survives on disk. A
//! refresh token is the whole point of the desktop app — it is what stops the
//! hourly re-authentication — so it necessarily outlives the process.
//!
//! It is written to the OS application-data directory with `0600` permissions,
//! meaning only the logged-in user can read it. That is the same posture as
//! tools like `gcloud` and `npm`. The macOS Keychain would be stronger still;
//! the trade-off is recorded in the README rather than hidden here.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Credentials that must survive a restart.
#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    /// Google OAuth "Desktop app" client ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Matching client secret. Not a true secret for installed apps — Google
    /// documents it as non-confidential in this flow — but still user data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl Stored {
    pub fn is_configured(&self) -> bool {
        self.client_id.as_ref().is_some_and(|v| !v.is_empty())
            && self.client_secret.as_ref().is_some_and(|v| !v.is_empty())
    }
}

fn credentials_path(dir: &Path) -> PathBuf {
    dir.join("credentials.json")
}

/// Read stored credentials, treating any problem as "nothing stored".
///
/// A corrupt or unreadable file should land the user on the sign-in screen,
/// never on an error they cannot act on.
pub fn load(dir: &Path) -> Stored {
    let Ok(raw) = fs::read_to_string(credentials_path(dir)) else {
        return Stored::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Write credentials, creating the directory and tightening permissions.
pub fn save(dir: &Path, stored: &Stored) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = credentials_path(dir);
    let json = serde_json::to_string_pretty(stored)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(&path, json)?;
    restrict(&path)
}

/// Remove stored credentials. Missing file is success, not an error.
pub fn clear(dir: &Path) -> std::io::Result<()> {
    match fs::remove_file(credentials_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Owner read/write only. A no-op off Unix, where the app-data directory is
/// already per-user.
#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("inbox-sweep-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir), Stored::default());
        assert!(!load(&dir).is_configured());
    }

    #[test]
    fn saves_and_reloads() {
        let dir = temp_dir("roundtrip");
        let stored = Stored {
            client_id: Some("cid".into()),
            client_secret: Some("secret".into()),
            refresh_token: Some("refresh".into()),
        };

        save(&dir, &stored).expect("save");
        assert_eq!(load(&dir), stored);
        assert!(load(&dir).is_configured());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_reads_as_empty_rather_than_failing() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(credentials_path(&dir), "{ not json").expect("write");

        // The user must land on the sign-in screen, not an unactionable error.
        assert_eq!(load(&dir), Stored::default());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_and_is_idempotent() {
        let dir = temp_dir("clear");
        save(
            &dir,
            &Stored {
                client_id: Some("cid".into()),
                ..Default::default()
            },
        )
        .expect("save");

        clear(&dir).expect("first clear");
        assert_eq!(load(&dir), Stored::default());
        clear(&dir).expect("clearing twice is not an error");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_configured_requires_both_halves() {
        let only_id = Stored {
            client_id: Some("cid".into()),
            ..Default::default()
        };
        assert!(!only_id.is_configured());

        let blank_secret = Stored {
            client_id: Some("cid".into()),
            client_secret: Some(String::new()),
            ..Default::default()
        };
        assert!(!blank_secret.is_configured());
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("perms");
        save(
            &dir,
            &Stored {
                refresh_token: Some("secret".into()),
                ..Default::default()
            },
        )
        .expect("save");

        let mode = fs::metadata(credentials_path(&dir))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "group/other must have no access");

        let _ = fs::remove_dir_all(&dir);
    }
}
