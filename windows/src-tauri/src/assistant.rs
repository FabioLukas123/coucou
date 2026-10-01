// The chat's brain: the coding agents already installed on this machine.
//
// Each turn goes to the first one that answers, in this order:
//
//   1. Claude Code  — `claude -p`, the user's own default model and login
//   2. Codex        — `codex exec`, read-only sandbox
//   3. OpenCode     — `opencode run`, the user's default model
//   4. OpenCode Go  — the Go API directly, with the key OpenCode stored
//   5. Anthropic    — the original API path, only when a key was saved
//
// A conversation sticks to the agent that answered it, resuming the same
// session so the agent keeps its own context. If that agent stops answering,
// the next one takes over with the transcript so far, so the chat never resets
// under the user's feet.
//
// Every agent runs with COUCOU_HOOK_SKIP=1: coucou-hook sees it and stays
// silent, so Mochi's own chat never shows up as a coding session on the island.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::claude::{self, Chat, ChatContext, ChatReply};

/// Long enough for a web search or two; past that the next agent is tried.
const TURN_TIMEOUT: Duration = Duration::from_secs(150);
/// OpenCode Go's OpenAI-compatible endpoint.
const GO_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/chat/completions";
/// Go model when COUCOU_GO_MODEL says nothing: fast, and on every Go plan.
const GO_DEFAULT_MODEL: &str = "deepseek-v4-flash";

const PERSONA: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
Help with absolutely anything — research, coding, recommendations, tasks, questions. \
Respond in the user's language. Be complete but concise. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks. \
You are chatting, not coding: do not edit files or run commands unless the user explicitly asks.";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Claude,
    Codex,
    OpenCode,
    Go,
}

impl Backend {
    fn label(self) -> &'static str {
        match self {
            Backend::Claude => "Claude Code",
            Backend::Codex => "Codex",
            Backend::OpenCode => "OpenCode",
            Backend::Go => "OpenCode Go",
        }
    }
}

/// What the agents need to carry a conversation across turns.
#[derive(Default)]
pub struct Conversation {
    /// Plain transcript (user / assistant), for handing over between agents.
    transcript: Mutex<Vec<(&'static str, String)>>,
    /// The agent holding the conversation and its own session id.
    session: Mutex<Option<(Backend, String)>>,
}

impl Conversation {
    pub fn reset(&self) {
        self.transcript.lock().unwrap().clear();
        *self.session.lock().unwrap() = None;
    }
}

/// One chat turn through the agents, then the API as a last resort.
pub async fn send(
    conv: &Conversation,
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let held = conv.session.lock().unwrap().clone();
    let mut order = vec![Backend::Claude, Backend::Codex, Backend::OpenCode, Backend::Go];
    // The agent already holding the conversation goes first.
    if let Some((b, _)) = &held {
        order.retain(|x| x != b);
        order.insert(0, *b);
    }

    let mut failures: Vec<String> = Vec::new();
    for backend in order {
        let resume = held.as_ref().filter(|(b, _)| *b == backend).map(|(_, id)| id.clone());
        let prompt = build_prompt(conv, backend, resume.is_some(), &query, context.as_ref());
        match run(backend, &prompt, resume.as_deref(), context.as_ref(), conv).await {
            Ok((text, session)) => {
                crate::log::line(format!("chat answered by {}", backend.label()));
                *conv.session.lock().unwrap() = Some((backend, session));
                let mut t = conv.transcript.lock().unwrap();
                t.push(("user", query.clone()));
                t.push(("assistant", text.clone()));
                return Ok(ChatReply { text });
            }
            Err(err) => {
                crate::log::line(format!("chat: {} failed — {err}", backend.label()));
                failures.push(format!("{}: {err}", backend.label()));
            }
        }
    }

    // Nothing local answered: the original API path, if the user gave a key.
    if crate::secrets::present("anthropic-api-key") {
        return claude::send(chat, model, query, context).await;
    }
    Err(format!("No assistant answered. {}", failures.join(" · ")))
}

/// The text one agent gets for this turn.
fn build_prompt(
    conv: &Conversation,
    backend: Backend,
    resuming: bool,
    query: &str,
    context: Option<&ChatContext>,
) -> String {
    if resuming {
        return query.to_string();
    }
    let mut out = String::new();
    // Claude Code takes the persona as a system prompt; the others read it.
    if backend != Backend::Claude && backend != Backend::Go {
        out.push_str(PERSONA);
        out.push_str("\n\n");
    }
    let transcript = conv.transcript.lock().unwrap();
    if !transcript.is_empty() {
        out.push_str("Conversation so far:\n");
        for (role, text) in transcript.iter() {
            let who = if *role == "user" { "User" } else { "Mochi" };
            out.push_str(&format!("{who}: {text}\n"));
        }
        out.push('\n');
    }
    match context {
        Some(ChatContext::File { name, path }) => {
            out.push_str(&format!("The user dropped a file on you: {name} ({path}). Read it to answer.\n\n"));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            out.push_str(&format!("Context — App: {app_name}, Window: {title}"));
            if let Some(url) = url {
                out.push_str(&format!(", URL: {url}"));
            }
            out.push_str("\n\n");
        }
        None => {}
    }
    out.push_str(query);
    out
}

/// A quiet place for the agents to run in, away from any project.
fn workdir() -> PathBuf {
    let dir = crate::settings::local_dir().join("chat");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

async fn run(
    backend: Backend,
    prompt: &str,
    resume: Option<&str>,
    context: Option<&ChatContext>,
    conv: &Conversation,
) -> Result<(String, String), String> {
    match backend {
        Backend::Claude => claude_code(prompt, resume, context).await,
        Backend::Codex => codex(prompt, resume).await,
        Backend::OpenCode => opencode(prompt, resume, context).await,
        Backend::Go => opencode_go(prompt, resume, context, conv).await,
    }
}

/// Runs an agent CLI to completion under the turn timeout.
async fn exec(mut cmd: Command) -> Result<String, String> {
    cmd.current_dir(workdir())
        .env("COUCOU_HOOK_SKIP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("not available ({e})"))?;
    let out = tokio::time::timeout(TURN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("exit {} {}", out.status.code().unwrap_or(-1), last.chars().take(160).collect::<String>()));
    }
    Ok(stdout)
}

async fn claude_code(prompt: &str, resume: Option<&str>, context: Option<&ChatContext>) -> Result<(String, String), String> {
    let mut cmd = Command::new("claude");
    cmd.args(["-p", prompt, "--output-format", "json", "--append-system-prompt", PERSONA]);
    let mut tools = String::from("WebSearch,WebFetch");
    if matches!(context, Some(ChatContext::File { .. })) {
        tools.push_str(",Read");
    }
    cmd.args(["--allowedTools", &tools]);
    if let Some(id) = resume {
        cmd.args(["--resume", id]);
    }
    let out = exec(cmd).await?;
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| "unreadable output".to_string())?;
    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(v.get("result").and_then(Value::as_str).unwrap_or("error").chars().take(160).collect());
    }
    let text = v.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let session = v.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
    if text.is_empty() {
        return Err("empty answer".into());
    }
    Ok((text, session))
}

async fn codex(prompt: &str, resume: Option<&str>) -> Result<(String, String), String> {
    let mut cmd = Command::new("codex");
    match resume {
        Some(id) => {
            cmd.args(["exec", "resume", "--skip-git-repo-check", "--json", id, prompt]);
        }
        None => {
            cmd.args(["exec", "--skip-git-repo-check", "-s", "read-only", "--json", prompt]);
        }
    }
    let out = exec(cmd).await?;
    let mut session = resume.unwrap_or("").to_string();
    let mut text = String::new();
    let mut error = None;
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                if let Some(id) = v.get("thread_id").and_then(Value::as_str) {
                    session = id.to_string();
                }
            }
            Some("item.completed") => {
                let item = &v["item"];
                if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                    text = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                }
            }
            Some("turn.failed") | Some("error") => {
                error = v.pointer("/error/message").or_else(|| v.get("message")).and_then(Value::as_str).map(str::to_string);
            }
            _ => {}
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(error.unwrap_or_else(|| "empty answer".into()));
    }
    Ok((text, session))
}

async fn opencode(prompt: &str, resume: Option<&str>, context: Option<&ChatContext>) -> Result<(String, String), String> {
    let mut cmd = Command::new("opencode");
    cmd.args(["run", "--format", "json"]);
    if let Some(id) = resume {
        cmd.args(["--session", id]);
    }
    if let Some(ChatContext::File { path, .. }) = context {
        cmd.args(["-f", path]);
    }
    cmd.arg(prompt);
    let out = exec(cmd).await?;
    let mut session = resume.unwrap_or("").to_string();
    let mut parts: Vec<String> = Vec::new();
    let mut error = None;
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(id) = v.get("sessionID").and_then(Value::as_str) {
            session = id.to_string();
        }
        match v.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = v.pointer("/part/text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            }
            Some("error") => {
                error = v.pointer("/error/data/message")
                    .or_else(|| v.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
    }
    let text = parts.join("\n").trim().to_string();
    if text.is_empty() {
        return Err(error.unwrap_or_else(|| "empty answer".into()));
    }
    Ok((text, session))
}

/// The OpenCode Go key, as OpenCode stored it.
pub fn go_key() -> Option<String> {
    let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(p) if p.is_absolute() => p,
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".local/share"),
    };
    let auth: Value = serde_json::from_slice(&std::fs::read(base.join("opencode/auth.json")).ok()?).ok()?;
    auth.pointer("/opencode-go/key").and_then(Value::as_str).map(str::to_string)
}

async fn opencode_go(
    prompt: &str,
    resume: Option<&str>,
    context: Option<&ChatContext>,
    conv: &Conversation,
) -> Result<(String, String), String> {
    let key = go_key().ok_or("no OpenCode Go key")?;
    let model = std::env::var("COUCOU_GO_MODEL").unwrap_or_else(|_| GO_DEFAULT_MODEL.into());
    // Go wants a stable id per conversation for routing and caching.
    let session = resume.map(str::to_string).unwrap_or_else(|| {
        format!("coucou-{}-{}", std::process::id(), std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))
    });

    let mut messages = vec![json!({ "role": "system", "content": PERSONA })];
    if resume.is_some() {
        for (role, text) in conv.transcript.lock().unwrap().iter() {
            messages.push(json!({ "role": role, "content": text }));
        }
    }
    let mut user = prompt.to_string();
    // No file tools here: text files ride along inline.
    if let Some(ChatContext::File { path, .. }) = context {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() < 200_000 {
                if let Ok(text) = std::fs::read_to_string(path) {
                    user = format!("File contents:\n{text}\n\n{user}");
                }
            }
        }
    }
    messages.push(json!({ "role": "user", "content": user }));

    let client = reqwest::Client::builder().timeout(TURN_TIMEOUT).build().map_err(|e| e.to_string())?;
    let response = client
        .post(GO_ENDPOINT)
        .bearer_auth(key)
        .header("x-opencode-session", &session)
        .json(&json!({ "model": model, "messages": messages }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = response.status();
    let v: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("error");
        return Err(format!("{status} {msg}"));
    }
    let text = v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("empty answer".into());
    }
    Ok((text, session))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to the real agents — run by hand with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn every_agent_answers() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let conv = Conversation::default();
        for backend in [Backend::Claude, Backend::Codex, Backend::OpenCode, Backend::Go] {
            let prompt = build_prompt(&conv, backend, false, "Answer with one word: hello", None);
            let result = rt.block_on(run(backend, &prompt, None, None, &conv));
            eprintln!("{:<12} {:?}", backend.label(), result.as_ref().map(|(t, _)| t));
            assert!(result.is_ok(), "{} failed: {:?}", backend.label(), result.err());
        }
    }
}
