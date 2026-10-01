// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json on
// Windows and ~/.config/coucou/settings.json on Linux.
// No secret ever lands here — API keys live in the Windows Credential Manager
// or the Linux Secret Service.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on,
    /// "all" = one island per display (Linux).
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            // Linux has the coding agents' pills where Windows has Resend and n8n.
            active_integrations: if cfg!(windows) {
                vec![
                    "integration_resend".into(),
                    "integration_n8n".into(),
                    "integration_vercel".into(),
                    "integration_github".into(),
                ]
            } else {
                vec![
                    "integration_codex".into(),
                    "integration_opencode".into(),
                    "integration_vercel".into(),
                    "integration_github".into(),
                ]
            },
            // Linux puts an island on every display; Windows keeps one.
            screen: if cfg!(windows) { "primary" } else { "all" }.into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
        }
    }
}

/// %APPDATA%\Coucou
#[cfg(windows)]
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// %LOCALAPPDATA%\Coucou — where coucou-hook.exe and the log live.
#[cfg(windows)]
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// $XDG_CONFIG_HOME/coucou, ~/.config/coucou by default.
#[cfg(not(windows))]
pub fn config_dir() -> PathBuf {
    xdg_dir("XDG_CONFIG_HOME", ".config").join("coucou")
}

/// $XDG_DATA_HOME/coucou, ~/.local/share/coucou by default — where coucou-hook
/// and the log live.
#[cfg(not(windows))]
pub fn local_dir() -> PathBuf {
    xdg_dir("XDG_DATA_HOME", ".local/share").join("coucou")
}

#[cfg(not(windows))]
fn xdg_dir(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var).map(PathBuf::from) {
        // The spec says relative paths are invalid and must be ignored.
        Some(p) if p.is_absolute() => p,
        _ => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(fallback),
    }
}

/// `coucou-hook.exe` on Windows, `coucou-hook` elsewhere.
pub const HOOK_EXE_NAME: &str = if cfg!(windows) { "coucou-hook.exe" } else { "coucou-hook" };

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(HOOK_EXE_NAME)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
