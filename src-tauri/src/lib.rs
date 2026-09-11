//! Tauri commands backing the desktop build.
//!
//! The frontend is the same React app the browser build serves. Only
//! authentication differs, and it differs because it has to — see `oauth.rs`.
//! Gmail requests still go straight from the webview to Google; nothing
//! proxies mail through here.

mod oauth;
mod store;

use std::path::PathBuf;

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
    access_token: String,
    /// Seconds until the access token expires.
    expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    /// A client ID and secret have been saved.
    configured: bool,
    /// A refresh token is held, so sign-in can be silent.
    signed_in: bool,
}

/// What the frontend has stored, so it can pick the right screen on launch.
#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Status {
    let stored = store::load(&state.data_dir);
    Status {
        configured: stored.is_configured(),
        signed_in: stored.refresh_token.is_some(),
    }
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

/// Run the interactive browser sign-in and persist the refresh token.
#[tauri::command]
async fn sign_in(state: State<'_, AppState>) -> Result<Session, String> {
    let dir = state.data_dir.clone();
    let stored = store::load(&dir);

    let (client_id, client_secret) = match (stored.client_id.clone(), stored.client_secret.clone())
    {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => (id, secret),
        _ => return Err("Add your Google client ID and secret first.".into()),
    };

    let tokens = oauth::sign_in(&client_id, &client_secret, SCOPES)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(refresh_token) = tokens.refresh_token.clone() {
        let mut updated = store::load(&dir);
        updated.refresh_token = Some(refresh_token);
        // Failing to persist costs the user a re-authentication next launch;
        // it must not fail the sign-in they just completed.
        if let Err(e) = store::save(&dir, &updated) {
            eprintln!("could not persist refresh token: {e}");
        }
    }

    Ok(Session {
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
    })
}

/// Mint a fresh access token from the stored refresh token, with no user
/// interaction. This is what makes the desktop build stop nagging.
#[tauri::command]
async fn refresh_session(state: State<'_, AppState>) -> Result<Session, String> {
    let dir = state.data_dir.clone();
    let stored = store::load(&dir);

    let (Some(client_id), Some(client_secret), Some(refresh_token)) = (
        stored.client_id.clone(),
        stored.client_secret.clone(),
        stored.refresh_token.clone(),
    ) else {
        return Err("Not signed in.".into());
    };

    match oauth::refresh(&client_id, &client_secret, &refresh_token).await {
        Ok(tokens) => Ok(Session {
            access_token: tokens.access_token,
            expires_in: tokens.expires_in,
        }),
        Err(e) => {
            // A revoked or expired refresh token can never succeed again, so
            // drop it and let the UI fall back to interactive sign-in.
            if matches!(e, oauth::OAuthError::Token(_)) {
                let mut updated = store::load(&dir);
                updated.refresh_token = None;
                let _ = store::save(&dir, &updated);
            }
            Err(e.to_string())
        }
    }
}

/// Forget the refresh token, keeping the client credentials so the user does
/// not have to re-enter them to sign back in.
#[tauri::command]
fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
    let mut stored = store::load(&state.data_dir);
    stored.refresh_token = None;
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
            sign_out,
            forget_all,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inbox Sweep");
}
