// API keys live in the Windows Credential Manager (Linux: the Secret Service —
// GNOME Keyring, KWallet, KeePassXC…), never on disk and never in the front
// end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
        || (key == "github-token" && gh_cli_token().is_some())
        || (key == "vercel-token" && vercel_cli_auth().is_some())
}

/// The Vercel token to use: the one saved in Coucou, or else the Vercel CLI's
/// own login. Its tokens are short-lived; when the one on disk has expired the
/// CLI itself is run once (`vercel whoami`), which renews it the way the CLI
/// always does — Coucou only ever reads that file.
pub fn vercel_token() -> Option<String> {
    if let Some(t) = get("vercel-token") {
        return Some(t);
    }
    let (token, expires_at) = vercel_cli_auth()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if expires_at == 0 || expires_at > now + 60 {
        return Some(token);
    }
    renew_vercel_login();
    vercel_cli_auth().map(|(t, _)| t)
}

/// ~/.local/share/com.vercel.cli/auth.json → (token, expiresAt).
fn vercel_cli_auth() -> Option<(String, u64)> {
    #[cfg(windows)]
    let base = std::path::PathBuf::from(std::env::var_os("APPDATA")?);
    #[cfg(not(windows))]
    let base = match std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from) {
        Some(p) if p.is_absolute() => p,
        _ => std::path::PathBuf::from(std::env::var_os("HOME")?).join(".local/share"),
    };
    let text = std::fs::read_to_string(base.join("com.vercel.cli/auth.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    let expires = v.get("expiresAt").and_then(|e| e.as_u64()).unwrap_or(0);
    // expiresAt is in seconds in current CLIs; tolerate milliseconds.
    let expires = if expires > 10_000_000_000 { expires / 1000 } else { expires };
    (!token.is_empty()).then_some((token, expires))
}

/// Lets the Vercel CLI refresh its own login: `vercel`, or `npx vercel`.
fn renew_vercel_login() {
    let quiet = |cmd: &mut std::process::Command| {
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if quiet(std::process::Command::new("vercel").arg("whoami")) {
        return;
    }
    quiet(std::process::Command::new("npx").args(["-y", "vercel@latest", "whoami"]));
}

/// The GitHub token to use: the one saved in Coucou, or else the login the
/// GitHub CLI already has (`gh auth token`). Nothing is copied anywhere — the
/// CLI is asked each time.
pub fn github_token() -> Option<String> {
    get("github-token").or_else(gh_cli_token)
}

fn gh_cli_token() -> Option<String> {
    let out = std::process::Command::new("gh")
        .args(["auth", "token"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let token = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !token.is_empty()).then_some(token)
}
