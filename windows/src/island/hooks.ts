// Coding agent hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows and Linux the hook fires
// from any terminal and all of them are handled. Claude Code, Codex and OpenCode
// all speak Claude Code's hook format; `agent` says which pill an event is for.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { AGENT_TASK_IDS, State } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Codex / OpenCode pills leave this long after their last turn ends. */
const AGENT_LINGER_MS = 3 * 60_000;
const lingerTimers = new Map<string, number>();

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  /** "claude" (also when missing), "codex" or "opencode" — set by coucou-hook. */
  agent?: string;
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Linux: the hook's parent processes, nearest first. */
  ancestor_pids?: number[];
  /** Upstream's agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(id: string, projectName: string, cwd: string, pids?: number[]) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
  if (pids?.length) t.sessionPids = pids;
}

function clearSession(id: string) {
  if (id.startsWith("agent_")) {
    State.removeTask(id);
    return;
  }
  if (id !== CLAUDE_ID) {
    State.dropAgent(id);
    return;
  }
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

/** A Codex / OpenCode pill stays while its agent is busy, then leaves. */
function keepAgent(id: string, linger: boolean) {
  if (id === CLAUDE_ID) return;
  const t = lingerTimers.get(id);
  if (t != null) window.clearTimeout(t);
  lingerTimers.delete(id);
  if (linger) {
    lingerTimers.set(id, window.setTimeout(() => {
      lingerTimers.delete(id);
      if (State.pendingApproval?.taskId === id) return;
      State.dropAgent(id);
    }, AGENT_LINGER_MS));
  }
}

/**
 * The island shows one agent at a time. Activity from another agent takes the
 * view only when the one on screen has nothing going on.
 */
function claimFocus(id: string) {
  if (State.focusId === id) return;
  const current = State.focusTask;
  const busy = current && current.state !== "idle" && current.state !== "finished";
  if (!busy && !State.pendingApproval) State.setFocus(id);
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // Another island (another display) answered the card this one shows too.
  void onEvent<string>("approval-resolved", (requestId) => {
    if (State.pendingApproval?.requestId !== requestId) return;
    island.resolveApproval();
  });
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  // Claude Code, Codex and OpenCode have pills of their own; any other agent
  // that tags its events (upstream's coucou_agent) gets a dynamic agent_<name>.
  const tag = payload.agent ?? payload.coucou_agent ?? "claude";
  const known = AGENT_TASK_IDS[tag];
  const external = known ? null : validateAgent(tag);
  const id = known ?? (external ? `agent_${external}` : CLAUDE_ID);
  if (external) State.upsertExternalAgent(id, external, agentColor(external));
  if (id !== CLAUDE_ID && !external && name !== "SessionEnd") {
    State.ensureAgent(id);
    keepAgent(id, name === "Stop" || name === "StopFailure");
    if (name === "SessionStart" || name === "UserPromptSubmit" || name === "PermissionRequest") {
      claimFocus(id);
    }
  }
  const focused = State.focusId === id;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      upsert(id, projectName, cwd, payload.ancestor_pids);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(id, projectName, cwd, payload.ancestor_pids);
      State.updateTask(id, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(id, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(id, projectName, cwd, payload.ancestor_pids);
      State.updateTask(id, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(id, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(id, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(id, "working");
      State.appendStep(id, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(id, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(id, "question");
        State.appendStep(id, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(id, "finished");
      if (payload.message) State.appendStep(id, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(id, "finished");
      window.setTimeout(() => {
        State.updateTask(id, "idle");
        State.setPillBadge(id, null);
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(id, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(id, "error");
      break;

    case "SessionEnd":
      State.updateTask(id, "idle");
      clearSession(id);
      break;

    case "SubagentStart":
      State.appendStep(id, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(id, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(id, projectName, cwd, payload.ancestor_pids);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        taskId: id,
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(id, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(id, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(id, "working");
        State.setPillBadge(id, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
