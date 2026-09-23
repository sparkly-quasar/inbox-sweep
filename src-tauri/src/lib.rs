//! Tauri commands backing the desktop build.
//!
//! The frontend is the same React app the browser build serves. Only
//! authentication differs, and it differs because it has to — see `oauth.rs`.
//! Gmail requests still go straight from the webview to Google; nothing
//! proxies mail through here.

mod oauth;
mod store;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, State};

/// Gmail scopes, matching the browser build.
const SCOPES: &str = "https://www.googleapis.com/auth/gmail.modify \
https://www.googleapis.com/auth/gmail.settings.basic";

struct AppState {
    /// Where credentials live; resolved once at startup.
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    /// Which mailbox this token is for.
    email: String,
    access_token: String,
    /// Seconds until the access token expires.
    expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    /// A client ID and secret have been saved.
    configured: bool,
    /// Every signed-in mailbox, in a stable order.
    accounts: Vec<String>,
    /// The mailbox the UI had selected, if any.
    active: Option<String>,
}

fn load_client(dir: &Path) -> Result<(String, String), String> {
    store::load(dir)
        .client()
        .ok_or_else(|| "Add your Google client ID and secret first.".to_string())
}

/// Migrate a credentials file written before multi-account support.
///
/// Older versions stored a single refresh token with no record of which
/// mailbox it belonged to. Rather than silently signing the user out, exchange
/// it once to learn the address, then file it under that address. A failure
/// here is not fatal — the user just signs in again.
async fn migrate_legacy(dir: &Path) {
    let stored = store::load(dir);
    let (Some(legacy), true) = (stored.refresh_token.clone(), stored.accounts.is_empty()) else {
        return;
    };
    let Some((client_id, client_secret)) = stored.client() else {
        return;
    };

    match oauth::refresh(&client_id, &client_secret, &legacy).await {
        Ok(tokens) => match oauth::fetch_email(&tokens.access_token).await {
            Ok(email) => {
                let mut updated = store::load(dir);
                updated.upsert_account(&email, legacy);
                updated.refresh_token = None;
                let _ = store::save(dir, &updated);
            }
            Err(e) => eprintln!("could not identify the existing account: {e}"),
        },
        Err(e) => {
            // The old token is dead; drop it so the migration is not retried
            // on every launch.
            eprintln!("existing sign-in could not be renewed: {e}");
            let mut updated = store::load(dir);
            updated.refresh_token = None;
            let _ = store::save(dir, &updated);
        }
    }
}

/// What the frontend has stored, so it can pick the right screen on launch.
#[tauri::command]
async fn auth_status(state: State<'_, AppState>) -> Result<Status, String> {
    let dir = state.data_dir.clone();
    migrate_legacy(&dir).await;

    let stored = store::load(&dir);
    Ok(Status {
        configured: stored.is_configured(),
        accounts: stored.emails(),
        active: stored.active.clone(),
    })
}

/// Save the Google "Desktop app" client credentials entered on the setup screen.
#[tauri::command]
fn save_client(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    let mut stored = store::load(&state.data_dir);
    stored.client_id = Some(client_id.trim().to_string());
    stored.client_secret = Some(client_secret.trim().to_string());
    store::save(&state.data_dir, &stored).map_err(|e| e.to_string())
}

/// Run the interactive browser sign-in and add the resulting mailbox.
///
/// Signing in with an address that is already present replaces its token
/// rather than adding a duplicate, because accounts are keyed by address.
#[tauri::command]
async fn sign_in(state: State<'_, AppState>) -> Result<Session, String> {
    let dir = state.data_dir.clone();
    let (client_id, client_secret) = load_client(&dir)?;

    let tokens = oauth::sign_in(&client_id, &client_secret, SCOPES)
        .await
        .map_err(|e| e.to_string())?;

    let email = oauth::fetch_email(&tokens.access_token)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(refresh_token) = tokens.refresh_token.clone() {
        let mut updated = store::load(&dir);
        updated.upsert_account(&email, refresh_token);
        // Failing to persist costs the user a re-authentication next launch;
        // it must not fail the sign-in they just completed.
        if let Err(e) = store::save(&dir, &updated) {
            eprintln!("could not persist refresh token: {e}");
        }
    }

    Ok(Session {
        email,
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
    })
}

/// Mint a fresh access token for one mailbox, with no user interaction. This
/// is what makes the desktop build stop nagging.
#[tauri::command]
async fn refresh_session(state: State<'_, AppState>, email: String) -> Result<Session, String> {
    let dir = state.data_dir.clone();
    let (client_id, client_secret) = load_client(&dir)?;
    let refresh_token = store::load(&dir)
        .refresh_token_for(&email)
        .ok_or_else(|| format!("Not signed in to {email}."))?;

    match oauth::refresh(&client_id, &client_secret, &refresh_token).await {
        Ok(tokens) => Ok(Session {
            email,
            access_token: tokens.access_token,
            expires_in: tokens.expires_in,
        }),
        Err(e) => {
            // A revoked or expired refresh token can never succeed again, so
            // drop that account and let the UI offer to sign in again. Other
            // mailboxes are untouched.
            if matches!(e, oauth::OAuthError::Token(_)) {
                let mut updated = store::load(&dir);
                updated.remove_account(&email);
                let _ = store::save(&dir, &updated);
            }
            Err(e.to_string())
        }
    }
}

/// Remember which mailbox (or the combined view, when `None`) is selected.
#[tauri::command]
fn set_active(state: State<'_, AppState>, email: Option<String>) -> Result<(), String> {
    let mut stored = store::load(&state.data_dir);
    stored.active = email;
    store::save(&state.data_dir, &stored).map_err(|e| e.to_string())
}

/// Forget one mailbox, keeping the others and the client credentials.
#[tauri::command]
fn sign_out(state: State<'_, AppState>, email: String) -> Result<(), String> {
    let mut stored = store::load(&state.data_dir);
    stored.remove_account(&email);
    store::save(&state.data_dir, &stored).map_err(|e| e.to_string())
}

/// Forget everything, including the client credentials.
#[tauri::command]
fn forget_all(state: State<'_, AppState>) -> Result<(), String> {
    store::clear(&state.data_dir).map_err(|e| e.to_string())
}

/// Open a URL in the user's real browser or mail client.
///
/// `window.open` does nothing useful inside a Tauri webview, and unsubscribe
/// pages must not load in-app anyway — they are third-party pages that often
/// need a confirming click, and the app has no business rendering them.
///
/// Only schemes that make sense for this app are accepted, so a malicious
/// `List-Unsubscribe` header can't talk the app into executing something: a
/// header is attacker-controlled input, and this hands it to the OS.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let allowed = url.starts_with("https://") || url.starts_with("mailto:");
    if !allowed {
        return Err("Refusing to open that link.".into());
    }
    oauth::open_in_browser(&url).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState { data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            save_client,
            sign_in,
            refresh_session,
            set_active,
            sign_out,
            forget_all,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inbox Sweep");
}
