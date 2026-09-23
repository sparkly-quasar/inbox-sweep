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
//!
//! One OAuth client serves every mailbox — the client identifies *this app* to
//! Google, not the user — so only the refresh tokens are per-account.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What is held for a single signed-in mailbox.
#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub refresh_token: String,
}

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

    /// Signed-in mailboxes, keyed by email address. A BTreeMap so the order
    /// the account switcher shows is stable rather than hash-random.
    #[serde(default)]
    pub accounts: BTreeMap<String, Account>,

    /// Which mailbox the UI had selected. `None` means the combined view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,

    /// Single refresh token written by versions before multi-account support.
    ///
    /// Kept only so an existing install is not silently signed out: the app
    /// exchanges it once, learns which address it belongs to, moves it into
    /// `accounts`, and clears this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl Stored {
    pub fn is_configured(&self) -> bool {
        self.client_id.as_ref().is_some_and(|v| !v.is_empty())
            && self.client_secret.as_ref().is_some_and(|v| !v.is_empty())
    }

    /// The OAuth client, if both halves are present.
    pub fn client(&self) -> Option<(String, String)> {
        match (self.client_id.clone(), self.client_secret.clone()) {
            (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Some((id, secret)),
            _ => None,
        }
    }

    pub fn emails(&self) -> Vec<String> {
        self.accounts.keys().cloned().collect()
    }

    pub fn refresh_token_for(&self, email: &str) -> Option<String> {
        self.accounts.get(email).map(|a| a.refresh_token.clone())
    }

    /// Add or replace a mailbox, and select it.
    pub fn upsert_account(&mut self, email: &str, refresh_token: String) {
        self.accounts
            .insert(email.to_string(), Account { refresh_token });
        self.active = Some(email.to_string());
    }

    /// Forget one mailbox, keeping the rest and the OAuth client.
    pub fn remove_account(&mut self, email: &str) {
        self.accounts.remove(email);
        if self.active.as_deref() == Some(email) {
            // Fall back to any remaining mailbox rather than leaving a
            // selection that no longer exists.
            self.active = self.accounts.keys().next().cloned();
        }
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

    fn with_account(email: &str, token: &str) -> Stored {
        let mut s = Stored {
            client_id: Some("cid".into()),
            client_secret: Some("secret".into()),
            ..Default::default()
        };
        s.upsert_account(email, token.into());
        s
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir), Stored::default());
        assert!(!load(&dir).is_configured());
    }

    #[test]
    fn saves_and_reloads_several_accounts() {
        let dir = temp_dir("roundtrip");
        let mut stored = with_account("a@example.com", "refresh-a");
        stored.upsert_account("b@example.com", "refresh-b".into());

        save(&dir, &stored).expect("save");
        let back = load(&dir);
        assert_eq!(back, stored);
        assert_eq!(back.emails(), vec!["a@example.com", "b@example.com"]);
        assert_eq!(
            back.refresh_token_for("b@example.com").as_deref(),
            Some("refresh-b")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn accounts_are_listed_in_a_stable_order() {
        // A hash-ordered map would shuffle the switcher between launches.
        let mut stored = with_account("z@example.com", "t");
        stored.upsert_account("a@example.com", "t".into());
        stored.upsert_account("m@example.com", "t".into());
        assert_eq!(
            stored.emails(),
            vec!["a@example.com", "m@example.com", "z@example.com"]
        );
    }

    #[test]
    fn adding_an_account_selects_it() {
        let mut stored = with_account("a@example.com", "t");
        assert_eq!(stored.active.as_deref(), Some("a@example.com"));
        stored.upsert_account("b@example.com", "t".into());
        assert_eq!(stored.active.as_deref(), Some("b@example.com"));
    }

    #[test]
    fn signing_in_again_replaces_the_token_without_duplicating() {
        let mut stored = with_account("a@example.com", "old");
        stored.upsert_account("a@example.com", "new".into());
        assert_eq!(stored.accounts.len(), 1);
        assert_eq!(
            stored.refresh_token_for("a@example.com").as_deref(),
            Some("new")
        );
    }

    #[test]
    fn removing_the_active_account_falls_back_to_another() {
        let mut stored = with_account("a@example.com", "t");
        stored.upsert_account("b@example.com", "t".into());
        assert_eq!(stored.active.as_deref(), Some("b@example.com"));

        stored.remove_account("b@example.com");
        assert_eq!(stored.emails(), vec!["a@example.com"]);
        // Never leave a selection pointing at a mailbox that is gone.
        assert_eq!(stored.active.as_deref(), Some("a@example.com"));

        stored.remove_account("a@example.com");
        assert!(stored.accounts.is_empty());
        assert_eq!(stored.active, None);
    }

    #[test]
    fn removing_a_background_account_leaves_the_selection_alone() {
        let mut stored = with_account("a@example.com", "t");
        stored.upsert_account("b@example.com", "t".into());
        stored.remove_account("a@example.com");
        assert_eq!(stored.active.as_deref(), Some("b@example.com"));
    }

    #[test]
    fn reads_a_pre_multi_account_file_without_losing_the_token() {
        // Written by v0.1.2 and earlier. The token must survive to be migrated
        // rather than the whole file failing to parse.
        let dir = temp_dir("legacy");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(
            credentials_path(&dir),
            r#"{"clientId":"cid","clientSecret":"secret","refreshToken":"legacy-token"}"#,
        )
        .expect("write");

        let stored = load(&dir);
        assert!(stored.is_configured());
        assert_eq!(stored.refresh_token.as_deref(), Some("legacy-token"));
        assert!(stored.accounts.is_empty());

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
        save(&dir, &with_account("a@example.com", "t")).expect("save");

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
        assert!(only_id.client().is_none());

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
        save(&dir, &with_account("a@example.com", "secret")).expect("save");

        let mode = fs::metadata(credentials_path(&dir))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "group/other must have no access");

        let _ = fs::remove_dir_all(&dir);
    }
}
