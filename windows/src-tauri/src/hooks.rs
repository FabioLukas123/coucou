// Claude Code hook installation.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read ~/.claude/settings.json (%USERPROFILE% on Windows, $HOME on Linux), take a dated backup, merge without
// touching anybody else's hooks, show the diff, and write only after an explicit
// click. Uninstall removes Coucou's entries and nothing else.
//
// The command is only the quoted exe path in forward slashes plus the event name:
// on Windows Claude Code runs hook commands through Git Bash, and anything with
// PowerShell or cmd in it breaks.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::settings;

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// What Codex is told to forward. Its hooks.json takes the same shape and the
/// same event names as Claude Code's settings.json.
pub const CODEX_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// Marker that identifies a Coucou entry inside settings.json.
const MARKER: &str = "coucou-hook";

/// The coding agents Coucou can watch. Claude Code and Codex take command hooks
/// in a JSON file; OpenCode takes a plugin file that calls the same relay.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Agent {
    Claude,
    Codex,
    OpenCode,
}

impl Agent {
    /// `None` keeps the original single-agent commands meaning Claude Code.
    pub fn parse(name: Option<&str>) -> Result<Agent, String> {
        match name.unwrap_or("claude") {
            "claude" => Ok(Agent::Claude),
            "codex" => Ok(Agent::Codex),
            "opencode" => Ok(Agent::OpenCode),
            other => Err(format!("unknown agent {other}")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::OpenCode => "opencode",
        }
    }

    /// The file Coucou edits for this agent.
    pub fn path(self) -> PathBuf {
        match self {
            Agent::Claude => settings_path(),
            Agent::Codex => std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".codex"))
                .join("hooks.json"),
            Agent::OpenCode => {
                #[cfg(windows)]
                let config = home().join(".config");
                #[cfg(not(windows))]
                let config = match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
                    Some(p) if p.is_absolute() => p,
                    _ => home().join(".config"),
                };
                config.join("opencode").join("plugin").join("coucou.js")
            }
        }
    }

    /// Whether the agent looks installed: its config directory exists.
    fn available(self) -> bool {
        match self {
            Agent::Claude => true,
            Agent::Codex => self.path().parent().map(Path::exists).unwrap_or(false),
            Agent::OpenCode => self
                .path()
                .parent()
                .and_then(Path::parent)
                .map(Path::exists)
                .unwrap_or(false),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub agent: String,
    /// The agent's own config directory exists, so it is worth offering.
    pub available: bool,
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

fn home() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

/// Reads one agent's JSON settings (`~/.claude/settings.json`, `~/.codex/hooks.json`).
///
/// The only error that means "start from nothing" is the file not being there.
/// Everything else — a lock held by another process, a permission problem, JSON
/// we cannot parse — is reported, because the alternative is treating somebody's
/// unreadable settings as an empty object and then writing that back over them.
fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read(&path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        // A lock, a permission problem, a bad drive: all of them mean we do not
        // know what is in there, and not knowing is not the same as empty.
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

/// The parsing half of `read_settings`, split out so it can be tested without a
/// home directory.
fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`, and
    // serde_json refuses it. Stripping it is safe and well defined; guessing at
    // anything else is not.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Coucou won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again — Coucou won't overwrite it."
        )),
    }
}

/// The settings as they are, or an empty object when we cannot tell. Only for
/// read-only paths like `status()`, which must never fail loudly; anything that
/// writes uses `read_settings()` and surfaces the error instead.
fn read_json_lossy(path: &Path) -> Value {
    read_json(path).unwrap_or_else(|_| json!({}))
}

/// Claude Code's command stays exactly what it always was; the others say who
/// they are, so the island can tell the sessions apart.
fn hook_command_for(agent: Agent, event: &str) -> String {
    let exe = settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    match agent {
        Agent::Claude => format!("\"{exe}\" {event}"),
        _ => format!("\"{exe}\" --agent {} {event}", agent.id()),
    }
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Settings with Coucou's hooks added; everything else is left untouched.
#[cfg(test)]
fn merged(existing: &Value) -> Value {
    merged_for(Agent::Claude, existing)
}

fn merged_for(agent: Agent, existing: &Value) -> Value {
    let events = if agent == Agent::Codex { CODEX_EVENTS } else { HOOK_EVENTS };
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    for (event, timeout) in events {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(json!({
            "hooks": [{
                "type": "command",
                "command": hook_command_for(agent, event),
                "timeout": timeout,
            }]
        }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// Settings with every Coucou entry removed, and nothing else changed.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> =
                    list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// Down to the second: installing then uninstalling in the same minute must not
/// quietly overwrite the first backup.
fn stamp() -> String {
    let (y, mo, d, h, mi, s) = crate::clock::local_now();
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!("{name}.bak-{}", stamp()))
}

/// Identifies the exact bytes a preview was computed from. FNV-1a is plenty:
/// the question is only "is this still the file I showed the user?".
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_fingerprint(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> HookStatus {
    status_for(Agent::Claude)
}

pub fn status_for(agent: Agent) -> HookStatus {
    let path = agent.path();
    let installed = match agent {
        Agent::OpenCode => std::fs::read_to_string(&path)
            .map(|t| t.contains(MARKER))
            .unwrap_or(false),
        _ => read_json_lossy(&path)
            .get("hooks")
            .and_then(Value::as_object)
            .map(|hooks| {
                hooks
                    .values()
                    .filter_map(Value::as_array)
                    .flatten()
                    .any(entry_is_ours)
            })
            .unwrap_or(false),
    };
    let hook_path = settings::hook_exe_path();
    HookStatus {
        agent: agent.id().to_string(),
        available: agent.available(),
        installed,
        settings_path: path.to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

/// The file's text as it is and as it would be after the change.
fn before_after(agent: Agent, install: bool) -> Result<(String, String), String> {
    let path = agent.path();
    if agent == Agent::OpenCode {
        let current = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(format!("Can't read {}: {e}", path.display())),
        };
        let next = if install { opencode_plugin() } else { String::new() };
        return Ok((current, next));
    }
    let current = read_json(&path)?;
    let next = if install { merged_for(agent, &current) } else { without_ours(&current) };
    let mut text = pretty(&next);
    text.push('\n');
    Ok((pretty(&current), text))
}

#[cfg(test)]
pub fn preview(install: bool) -> Result<HookPreview, String> {
    preview_for(Agent::Claude, install)
}

pub fn preview_for(agent: Agent, install: bool) -> Result<HookPreview, String> {
    let path = agent.path();
    let (before, after) = before_after(agent, install)?;
    Ok(HookPreview {
        diff: unified_diff(&before, &after),
        backup: backup_path(&path).to_string_lossy().to_string(),
        settings_path: path.to_string_lossy().to_string(),
        fingerprint: current_fingerprint(&path),
    })
}

/// Writes the merged (or cleaned) settings after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file changed
/// in between — another tool, another window, the user's own editor — we stop
/// and make them look at a fresh diff, because the only thing worse than not
/// installing the hooks is silently reverting somebody else's edit.
#[cfg(test)]
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    write_for(Agent::Claude, install, fingerprint)
}

pub fn write_for(agent: Agent, install: bool, fingerprint: &str) -> Result<String, String> {
    let path = agent.path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Read before the backup: an unreadable file must abort before we touch
    // anything at all.
    let (_, next) = before_after(agent, install)?;
    if current_fingerprint(&path) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let backup = backup_path(&path);
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }

    // Uninstalling the OpenCode plugin is deleting the file Coucou wrote.
    if agent == Agent::OpenCode && !install {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove failed: {e}"))?;
        }
        return Ok(backup.to_string_lossy().to_string());
    }

    // Write beside the target and rename over it: a crash or a full disk leaves
    // the original settings.json intact rather than half a file.
    let temp = path.with_extension(format!("coucou-{}", std::process::id()));
    std::fs::write(&temp, next.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup.to_string_lossy().to_string())
}

/// The OpenCode plugin: turns OpenCode's plugin hooks into the same events
/// Claude Code sends, and hands them to coucou-hook. A permission prompt waits
/// for the island exactly like Claude Code's does; anything else is fire and
/// forget, and a missing Coucou costs OpenCode nothing.
fn opencode_plugin() -> String {
    let exe = settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    OPENCODE_PLUGIN.replace("\"@HOOK@\"", &serde_json::to_string(&exe).unwrap_or_default())
}

const OPENCODE_PLUGIN: &str = include_str!("opencode-plugin.js");

/// Copies coucou-hook.exe into %LOCALAPPDATA%\Coucou\bin on launch (on Linux:
/// coucou-hook into ~/.local/share/coucou/bin). In a bundled install it comes
/// from the app resources; in `tauri dev` it sits next to coucou.exe in the
/// workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: `resources` used to be a glob, which made NSIS
/// mirror the source path into `_up_\target\release\`, no candidate matched, and
/// the relay was simply never installed. It only looked healthy on a developer
/// machine, where a leftover copy from `tauri dev` was already sitting in bin/.
pub fn ensure_hook_exe(app: &AppHandle) {
    let dest = settings::hook_exe_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }

    let name = settings::HOOK_EXE_NAME;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(name, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release hook the pre-build step produces.
            candidates.push(parent.join(name));
            candidates.push(parent.join("../release").join(name));
            // Belt and braces: where the old glob form used to land it.
            candidates.push(parent.join("_up_/target/release").join(name));
            // Arch package layout: /usr/bin/coucou next to /usr/lib/coucou/.
            #[cfg(target_os = "linux")]
            candidates.push(parent.join("../lib/coucou").join(name));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        crate::log::line(format!(
            "{name} not found — Claude Code hooks cannot work. Looked in: {}",
            tried.join(", ")
        ));
        return;
    };

    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    // A hook may be running right now and hold the file open; keeping the old
    // copy is fine, it is the same relay.
    #[cfg(windows)]
    let copied = std::fs::copy(&src, &dest).map(|_| ());
    // Linux refuses to write over a binary that is running (ETXTBSY), but lets
    // us rename a fresh copy over it. The mtime is carried over so the
    // "already up to date" check above holds on the next launch.
    #[cfg(not(windows))]
    let copied = (|| {
        let temp = dest.with_extension(format!("new-{}", std::process::id()));
        std::fs::copy(&src, &temp)?;
        if let Ok(modified) = std::fs::metadata(&src).and_then(|m| m.modified()) {
            let _ = std::fs::File::options().write(true).open(&temp)?.set_modified(modified);
        }
        std::fs::rename(&temp, &dest).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })
    })();
    if let Err(err) = copied {
        if !dest.exists() {
            crate::log::line(format!("could not install {name}: {err}"));
        }
    }
}

// ── Minimal unified diff (LCS) ────────────────────────────────────────────────

/// settings.json is short, so a plain O(n·m) LCS is the simplest honest diff.
fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    // Keep three lines of context around each change so the panel stays readable.
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        for k in lo..hi {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHERE: &str = "settings.json";

    #[test]
    fn a_utf8_bom_is_stripped_not_treated_as_corruption() {
        // PowerShell 5's `Set-Content -Encoding utf8` produces exactly this.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus","hooks":{}}"#);
        let parsed = parse_settings(&bytes, WHERE).expect("a BOM must not defeat the parser");
        assert_eq!(parsed["model"], "opus");
    }

    #[test]
    fn unreadable_content_is_an_error_never_an_empty_object() {
        // This is the whole bug: returning {} here meant `merged()` produced a
        // file containing nothing but Coucou's hooks, and the write replaced
        // everything the user had.
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"a string\""[..]] {
            assert!(
                parse_settings(bad, WHERE).is_err(),
                "content we cannot use must refuse, not come back empty"
            );
        }
    }

    #[test]
    fn empty_and_whitespace_files_start_from_nothing() {
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
        assert_eq!(parse_settings(b"  
	 ", WHERE).unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        let after = merged(&existing);
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("someone-elses-tool.exe")),
            "another tool's hook was dropped"
        );
        assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
        assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());

        // And removing ours puts it back exactly as it was.
        let cleaned = without_ours(&after);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn codex_hooks_say_who_they_are_and_keep_the_rest() {
        let existing = json!({ "hooks": { "Stop": [
            { "hooks": [{ "type": "command", "command": "notify-send done" }] }
        ] } });
        let next = merged_for(Agent::Codex, &existing);
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "the user's own Stop hook must survive");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains("--agent codex Stop"));
        // Codex has no Notification event; nothing is invented for it.
        assert!(next["hooks"].get("Notification").is_none());
        assert_eq!(without_ours(&next), existing);
    }

    #[test]
    fn the_opencode_plugin_carries_the_relay_path() {
        let plugin = opencode_plugin();
        assert!(!plugin.contains("@HOOK@"));
        assert!(plugin.contains(MARKER), "status() finds the plugin by the relay name");
    }

    #[test]
    fn a_fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
        assert_ne!(fingerprint(b""), fingerprint(b"{}"));
    }

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// USERPROFILE (HOME on Linux) at a temp directory, and that is process-wide.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        let tmp = std::env::temp_dir().join(format!("coucou-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        std::env::set_var("HOME", &tmp);

        let path = settings_path();
        assert!(path.starts_with(&tmp), "the test must not touch the real home");

        // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
        let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(original.as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        // Install.
        let plan = preview(true).expect("a BOM must not stop the preview");
        assert!(plan.diff.contains("coucou-hook"), "the diff must show what changes");
        let backup = write(true, &plan.fingerprint).expect("install should succeed");

        // The backup holds the original bytes, BOM and all.
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);

        // Everything else survived, and so did the other tool's hook.
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["tui"]["x"], 1);
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
        assert!(status().installed);

        // A file that moved since the preview is refused, and left alone.
        let stale = preview(false).unwrap();
        std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
        let err = write(false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(untouched["model"], "someone-else-edited-this");

        // Content we cannot parse is refused before anything is written.
        std::fs::write(&path, b"{ broken").unwrap();
        assert!(preview(true).is_err());
        assert!(write(true, "whatever").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
