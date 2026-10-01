// Coucou for Windows and Linux — app wiring and the commands the island calls.

mod assistant;
mod claude;
mod clock;
mod files;
mod hooks;
mod integrations;
mod island;
#[cfg(target_os = "linux")]
mod islands;
#[cfg(target_os = "linux")]
mod linux;
mod log;
mod pipe;
mod secrets;
mod settings;
mod tray;
#[cfg(windows)]
mod win_user;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

/// Keeps spawned helpers from flashing a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Linux has no console to hide; this keeps the call sites identical.
#[cfg(not(windows))]
trait CommandExt {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self;
}
#[cfg(not(windows))]
impl CommandExt for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}
#[cfg(not(windows))]
const CREATE_NO_WINDOW: u32 = 0;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// "windows" or "linux" — only for wording (where keys are kept, and so on).
    platform: &'static str,
    /// No global cursor to read (most Wayland compositors): the island follows
    /// the webview's own mouse events instead of the `cursor` event.
    dom_cursor: bool,
    /// This window's label. Only the primary island (`island`) plays sounds.
    label: String,
    /// Linux: the top bar the minimised island sits in, or null.
    bar: serde_json::Value,
    /// Linux bar mode: the bar is away, so this island starts out quiet.
    suppressed: bool,
}

/// The poll gate of the island window `label`. Windows has a single island.
fn gate_of(app: &AppHandle, shared: &Shared, label: &str) -> Arc<PollGate> {
    #[cfg(target_os = "linux")]
    if let Some(gate) = islands::gate(app, label) {
        return gate;
    }
    let _ = (app, label);
    shared.gate.clone()
}

/// The bar island `label` was last placed against, as JSON for the page.
fn bar_of(#[allow(unused_variables)] gate: &PollGate) -> serde_json::Value {
    #[cfg(target_os = "linux")]
    return serde_json::to_value(gate.bar.lock().unwrap().clone()).unwrap_or_default();
    #[cfg(not(target_os = "linux"))]
    serde_json::Value::Null
}

/// Places island `label` again (display, size, bar).
fn place_island(app: &AppHandle, shared: &Shared, label: &str, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    #[cfg(target_os = "linux")]
    island::place(app, label, &gate_of(app, shared, label), &pref, collapsed);
    #[cfg(windows)]
    {
        let _ = label;
        island::apply_geometry(app, &pref, collapsed);
    }
}

#[tauri::command]
fn boot(app: AppHandle, window: WebviewWindow, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        platform: if cfg!(windows) { "windows" } else { "linux" },
        #[cfg(target_os = "linux")]
        dom_cursor: linux::dom_cursor(),
        #[cfg(not(target_os = "linux"))]
        dom_cursor: false,
        bar: bar_of(&gate_of(&app, &shared, window.label())),
        #[cfg(target_os = "linux")]
        suppressed: gate_of(&app, &shared, window.label()).suppressed.load(Ordering::Relaxed),
        #[cfg(not(target_os = "linux"))]
        suppressed: false,
        label: window.label().to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        #[cfg(target_os = "linux")]
        islands::request_sync(&app);
        #[cfg(windows)]
        island::apply_geometry(&app, &settings.screen, shared.gate.collapsed.load(Ordering::Relaxed));
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, window: WebviewWindow, shared: State<Shared>, collapsed: bool) {
    let label = window.label();
    let gate = gate_of(&app, &shared, label);
    gate.collapsed.store(collapsed, Ordering::Relaxed);
    if collapsed {
        island::set_activating(&window, false);
    }
    place_island(&app, &shared, label, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    #[cfg(windows)]
    island::set_ignore_cursor(&app, false);
    #[cfg(target_os = "linux")]
    island::apply_input_region(&app, label, &gate);
    gate.forget_ignore_state();
    gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(
    app: AppHandle,
    window: WebviewWindow,
    shared: State<Shared>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    let gate = gate_of(&app, &shared, window.label());
    gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Linux has no cursor-driven click-through; the input region follows the shape.
    #[cfg(target_os = "linux")]
    island::apply_input_region(&app, window.label(), &gate);
}

#[tauri::command]
fn focus_window(window: WebviewWindow, focused: bool) {
    island::set_activating(&window, focused);
    if focused {
        let _ = window.set_focus();
    }
}

/// Places the calling island again and returns the bar it now sits in.
#[tauri::command]
fn reposition(app: AppHandle, window: WebviewWindow, shared: State<Shared>) -> serde_json::Value {
    let label = window.label();
    let gate = gate_of(&app, &shared, label);
    place_island(&app, &shared, label, gate.collapsed.load(Ordering::Relaxed));
    bar_of(&gate)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(windows)]
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    #[cfg(not(windows))]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to Explorer (Linux: the default file manager) otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No `cmd /C` anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and cmd would happily read `&`, `^` and `%`
    // in a folder name as syntax. Finding the launcher ourselves and handing the
    // path over as a separate argument keeps it a path.
    if let Some(code) = find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg(p);
        }
        if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        #[cfg(windows)]
        let _ = Command::new("explorer").arg(p).spawn();
        #[cfg(not(windows))]
        let _ = Command::new("xdg-open").arg(p).spawn();
    }
    false
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
#[cfg(windows)]
fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Our own `which`: the first executable file called `stem` on $PATH. The
/// Arch packages name VS Code `code`, `code-oss` or `codium`.
#[cfg(not(windows))]
fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dirs = std::env::var_os("PATH")?;
    for name in [stem, "code-oss", "codium", "vscodium"] {
        if stem != "code" && name != stem {
            continue;
        }
        for dir in std::env::split_paths(&dirs) {
            let candidate = dir.join(name);
            let runnable = std::fs::metadata(&candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if runnable {
                return Some(candidate);
            }
        }
    }
    None
}

/// Clicking an agent session: on Linux bring its terminal forward (or open a
/// terminal in its folder); on Windows, as before, VS Code.
#[tauri::command]
fn open_session(path: Option<String>, pids: Option<Vec<u32>>) -> bool {
    #[cfg(target_os = "linux")]
    {
        if linux::focus_session_window(&pids.unwrap_or_default()) {
            return true;
        }
        linux::open_terminal(path.as_deref())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pids;
        open_in_vscode(path)
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Linux bar mode: the island opened or closed, so the bar hides or comes back.
#[tauri::command]
fn island_open(#[allow(unused_variables)] window: WebviewWindow, #[allow(unused_variables)] open: bool) {
    #[cfg(target_os = "linux")]
    {
        // A closed island never keeps the keyboard.
        if !open {
            island::set_activating(&window, false);
        }
        linux::island_open(window.label(), open);
    }
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Coding agent hooks (Claude Code, Codex, OpenCode) ───────────────────────

/// `agent` is "claude" (the default), "codex" or "opencode".
#[tauri::command]
fn hooks_status(agent: Option<String>) -> Result<HookStatus, String> {
    Ok(hooks::status_for(hooks::Agent::parse(agent.as_deref())?))
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool, agent: Option<String>) -> Result<HookPreview, String> {
    hooks::preview_for(hooks::Agent::parse(agent.as_deref())?, install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
    agent: Option<String>,
) -> Result<String, String> {
    let agent = hooks::Agent::parse(agent.as_deref())?;
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write_for(agent, install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        if agent == hooks::Agent::Claude {
            current.hooks_installed = install;
            let _ = settings::save(&current);
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
    // Any island can answer; the others drop the card.
    island::emit_islands(&app, "approval-resolved", request_id);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, window: WebviewWindow, request_id: String) {
    // Every island sees the card; only the primary one speaks for them.
    if window.label() == island::WINDOW_LABEL {
        pipe::acknowledge(&app, &request_id);
    }
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, window: WebviewWindow, request_id: String) {
    if window.label() == island::WINDOW_LABEL {
        pipe::decline(&app, &request_id);
    }
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    conv: State<'_, assistant::Conversation>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let model = shared.settings.lock().unwrap().model.clone();
    // Claude Code, Codex, OpenCode, OpenCode Go — then the API key, if any.
    assistant::send(&conv, &chat, &model, query, context).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>, conv: State<assistant::Conversation>) {
    chat.reset();
    conv.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

/// Entry point. Linux has to pick the GDK backend before GTK starts.
pub fn main() {
    #[cfg(target_os = "linux")]
    linux::pick_backend();
    run();
}

#[cfg(target_os = "linux")]
fn islands_state() -> islands::Islands {
    islands::Islands::default()
}

/// Nothing to keep track of with a single island.
#[cfg(not(target_os = "linux"))]
fn islands_state() {}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            island::emit_islands(app, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(islands_state())
        .manage(Chat::default())
        .manage(assistant::Conversation::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            open_session,
            quit_app,
            island_open,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                island::make_non_activating(&win);
                #[cfg(windows)]
                island::apply_geometry(&handle, &loaded.screen, false);
                #[cfg(target_os = "linux")]
                island::place(&handle, island::WINDOW_LABEL, &gate, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            #[cfg(windows)]
            island::spawn_cursor_poll(handle.clone(), gate.clone());
            #[cfg(target_os = "linux")]
            {
                handle
                    .state::<islands::Islands>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(island::WINDOW_LABEL.to_string(), gate.clone());
                island::spawn_cursor_poll(handle.clone(), island::WINDOW_LABEL.to_string(), gate.clone());
                // The other displays get their islands now, and whenever they change.
                islands::sync(&handle);
                islands::watch_displays(&handle);
                linux::init_bar_control(&handle);
                linux::refresh_suppression();
            }

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Coucou")
        .run(|_app, event| {
            // Never leave the bar hidden behind us.
            #[cfg(target_os = "linux")]
            if let tauri::RunEvent::Exit = event {
                linux::restore_bar_now();
            }
            let _ = event;
        });
}
