//! Google OAuth for a desktop app (RFC 8252, "OAuth 2.0 for Native Apps").
//!
//! The browser build of this app uses the implicit token flow inside the page.
//! A desktop app cannot: since February 2023 Google rejects any authorization
//! request coming from an embedded webview with `disallowed_useragent`, and
//! spoofing the user agent to get around that violates Google's terms.
//!
//! So the desktop flow does what Google actually wants:
//!
//!   1. bind a listener on a random loopback port — `http://127.0.0.1:<port>`
//!      is a redirect target Google permits for "Desktop app" clients,
//!   2. open the consent page in the user's *real* browser,
//!   3. catch the redirect back to that port and read the authorization code,
//!   4. exchange the code for tokens, proving possession with PKCE.
//!
//! The payoff over the browser build is a refresh token, so the app stops
//! asking the user to sign in every hour.
//!
//! Everything that parses or builds a string lives in pure functions with unit
//! tests; the socket and HTTP work is kept deliberately thin.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

/// How long to wait for the user to finish consenting in their browser.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    /// Absent on a refresh: Google only returns this on the initial exchange.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Seconds until `access_token` expires.
    pub expires_in: u64,
}

#[derive(Debug)]
pub enum OAuthError {
    Io(String),
    Timeout,
    /// The user hit "Cancel", or Google refused.
    Denied(String),
    /// The redirect did not carry the `state` we generated.
    StateMismatch,
    Http(String),
    /// Google's token endpoint returned an error body.
    Token(String),
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(m) => write!(f, "Could not start the local sign-in listener: {m}"),
            Self::Timeout => write!(f, "Timed out waiting for you to finish signing in."),
            Self::Denied(m) => write!(f, "Google refused the sign-in: {m}"),
            Self::StateMismatch => write!(
                f,
                "The sign-in response didn't match this request and was rejected."
            ),
            Self::Http(m) => write!(f, "Could not reach Google: {m}"),
            Self::Token(m) => write!(f, "Google rejected the token request: {m}"),
        }
    }
}

impl std::error::Error for OAuthError {}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/// Percent-encode for `application/x-www-form-urlencoded` query values,
/// keeping only the RFC 3986 unreserved set.
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Inverse of [`percent_encode`], tolerant of malformed input (a stray `%` is
/// kept verbatim rather than dropped).
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => match u8::from_str_radix(&input[i + 1..i + 3], 16) {
                Ok(value) => {
                    out.push(value);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pull the request target out of an HTTP request line (`GET /x?y=1 HTTP/1.1`).
pub fn parse_request_target(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    let _method = parts.next()?;
    parts.next()
}

/// Decode the query string of a request target into key/value pairs.
pub fn query_params(target: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let Some((_, query)) = target.split_once('?') else {
        return params;
    };

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(percent_decode(key), percent_decode(value));
    }
    params
}

/// Build the Google consent URL.
///
/// `access_type=offline` plus `prompt=consent` is what makes Google issue a
/// refresh token; without both, a repeat sign-in returns only an access token
/// and the app would be back to hourly re-authentication.
pub fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    code_challenge: &str,
    state: &str,
) -> String {
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", scope),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];

    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{AUTH_ENDPOINT}?{query}")
}

/// The S256 PKCE challenge for a verifier: base64url(sha256(verifier)), unpadded.
pub fn code_challenge_for(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// A URL-safe random string of `bytes` entropy, for verifiers and state.
pub fn random_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// The page the browser lands on after consent. Kept tiny and self-contained —
/// it is served from a one-shot socket, so it cannot reference any assets.
fn success_page() -> String {
    let body = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>Signed in</title></head>\
<body style=\"font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:60px 20px;color:#14161a\">\
<h1 style=\"font-size:20px\">Signed in</h1>\
<p style=\"color:#666e7a\">You can close this tab and return to Inbox Sweep.</p>\
</body></html>";

    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

/// Open the user's browser at `url`.
///
/// Deliberately shelling out rather than taking a dependency: the set of
/// commands is tiny and stable, and this keeps the crate compiling unchanged on
/// every platform.
pub fn open_in_browser(url: &str) -> Result<(), OAuthError> {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(url)
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };

    result
        .map(|_| ())
        .map_err(|e| OAuthError::Io(e.to_string()))
}

/// Wait on `listener` until a request carrying `code` or `error` arrives.
///
/// Browsers cheerfully issue extra requests to a loopback port (favicon being
/// the usual culprit), so anything without the parameters we care about is
/// answered and ignored rather than treated as the callback.
fn await_callback(listener: &TcpListener, state: &str) -> Result<String, OAuthError> {
    let deadline = std::time::Instant::now() + CONSENT_TIMEOUT;

    loop {
        if std::time::Instant::now() >= deadline {
            return Err(OAuthError::Timeout);
        }

        let (mut stream, _) = listener.accept().map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                OAuthError::Timeout
            } else {
                OAuthError::Io(e.to_string())
            }
        })?;

        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();

        let mut request_line = String::new();
        let read = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| OAuthError::Io(e.to_string()))?,
        )
        .read_line(&mut request_line);

        if read.is_err() {
            continue;
        }

        let params = parse_request_target(&request_line)
            .map(query_params)
            .unwrap_or_default();

        // Always answer, so the browser shows something rather than hanging.
        let _ = stream.write_all(success_page().as_bytes());
        let _ = stream.flush();

        if let Some(error) = params.get("error") {
            return Err(OAuthError::Denied(error.clone()));
        }

        if let Some(code) = params.get("code") {
            // Reject a callback that didn't originate from this request.
            if params.get("state").map(String::as_str) != Some(state) {
                return Err(OAuthError::StateMismatch);
            }
            return Ok(code.clone());
        }
        // Anything else (favicon, a stray probe) — keep waiting.
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
}

async fn post_token(form: Vec<(&str, String)>) -> Result<Tokens, OAuthError> {
    let response = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    if !status.is_success() {
        let detail = serde_json::from_str::<TokenErrorResponse>(&body)
            .ok()
            .and_then(|e| e.error_description.or(e.error))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(OAuthError::Token(detail));
    }

    let parsed: TokenResponse =
        serde_json::from_str(&body).map_err(|e| OAuthError::Token(e.to_string()))?;

    Ok(Tokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_in: parsed.expires_in.unwrap_or(3600),
    })
}

/// Run the full interactive sign-in and return the resulting tokens.
pub async fn sign_in(
    client_id: &str,
    client_secret: &str,
    scope: &str,
) -> Result<Tokens, OAuthError> {
    // Bind first: the port is part of the redirect URI we have to advertise.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| OAuthError::Io(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| OAuthError::Io(e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_token(64);
    let challenge = code_challenge_for(&verifier);
    let state = random_token(24);

    open_in_browser(&build_auth_url(
        client_id,
        &redirect_uri,
        scope,
        &challenge,
        &state,
    ))?;

    // Blocking accept, moved off the async runtime's worker threads.
    let code = tokio::task::spawn_blocking(move || await_callback(&listener, &state))
        .await
        .map_err(|e| OAuthError::Io(e.to_string()))??;

    post_token(vec![
        ("code", code),
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".to_string()),
        ("code_verifier", verifier),
    ])
    .await
}

/// Trade a stored refresh token for a fresh access token.
pub async fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<Tokens, OAuthError> {
    let mut tokens = post_token(vec![
        ("client_id", client_id.to_string()),
        ("client_secret", client_secret.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ])
    .await?;

    // A refresh response omits the refresh token; keep the one we already hold
    // so the caller can store the result verbatim.
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(percent_encode("aZ0-._~"), "aZ0-._~");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(
            percent_encode("https://x/y?z=1"),
            "https%3A%2F%2Fx%2Fy%3Fz%3D1"
        );
    }

    #[test]
    fn percent_decode_round_trips() {
        for original in ["plain", "a b", "https://x/y?z=1", "sym+bols&=%"] {
            assert_eq!(percent_decode(&percent_encode(original)), original);
        }
    }

    #[test]
    fn percent_decode_tolerates_malformed_input() {
        // A trailing or invalid escape must not panic or truncate.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("a+b"), "a b");
    }

    #[test]
    fn parses_the_request_target() {
        assert_eq!(
            parse_request_target("GET /?code=abc&state=xyz HTTP/1.1"),
            Some("/?code=abc&state=xyz")
        );
        assert_eq!(parse_request_target(""), None);
    }

    #[test]
    fn extracts_query_params() {
        let params = query_params("/?code=4%2F0Ab&state=xyz&scope=a%20b");
        assert_eq!(params.get("code"), Some(&"4/0Ab".to_string()));
        assert_eq!(params.get("state"), Some(&"xyz".to_string()));
        // Google's real codes contain slashes, which must survive decoding.
        assert_eq!(params.get("scope"), Some(&"a b".to_string()));
    }

    #[test]
    fn query_params_handles_no_query_and_empty_values() {
        assert!(query_params("/").is_empty());
        let params = query_params("/?a=&b");
        assert_eq!(params.get("a"), Some(&String::new()));
        assert_eq!(params.get("b"), Some(&String::new()));
    }

    #[test]
    fn auth_url_carries_everything_google_needs() {
        let url = build_auth_url(
            "cid",
            "http://127.0.0.1:1234",
            "scope.a scope.b",
            "chal",
            "st",
        );

        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st"));
        // Both are required for Google to return a refresh token.
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        // The redirect and scopes must be encoded, not raw.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1234"));
        assert!(url.contains("scope=scope.a%20scope.b"));
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_test_vector() {
        // From RFC 7636 Appendix B.
        assert_eq!(
            code_challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_unique_and_url_safe() {
        let a = random_token(32);
        let b = random_token(32);
        assert_ne!(a, b);
        assert!(!a.is_empty());
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn success_page_declares_an_accurate_content_length() {
        let page = success_page();
        let (head, body) = page.split_once("\r\n\r\n").expect("headers and body");
        let declared: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .expect("content length header")
            .parse()
            .expect("numeric content length");
        // A mismatch here leaves the browser waiting on bytes that never come.
        assert_eq!(declared, body.len());
    }
}
