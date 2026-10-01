// Coucou — shows this OpenCode session on Mochi's island.
//
// Written by Coucou (Settings → Coding agents). Uninstalling there, or deleting
// this file, disconnects it. Every event goes through coucou-hook, the same
// relay Claude Code and Codex use; if Coucou is closed the relay exits at once
// and OpenCode carries on untouched.

const HOOK = "@HOOK@";

/** OpenCode's tool names → the ones the island knows how to label. */
const TOOLS = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  // GPT models edit through a patch, as in Codex: the relay reads which files.
  patch: "apply_patch",
  apply_patch: "apply_patch",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
};

/** OpenCode's argument names → Claude Code's, which the relay and the island read. */
const FIELDS = { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" };

function toolInput(args) {
  const input = { ...(args ?? {}) };
  for (const [from, to] of Object.entries(FIELDS)) if (input[from] !== undefined) input[to] = input[from];
  return input;
}

/** Tools whose files the relay copies before they run: it must be done first. */
const EDITS = new Set(["Edit", "Write", "MultiEdit", "apply_patch"]);

/** What a tool gave back, in the shape the relay reads for Claude Code's. */
function toolResponse(tool, output) {
  const text = typeof output?.output === "string" ? output.output : "";
  if (!text) return undefined;
  if (tool === "Bash") return { stdout: text };
  if (tool === "Grep") return { content: text };
  if (tool === "Glob") return { filenames: text.split("\n").filter(Boolean) };
  return undefined;
}

/** Hands one event to coucou-hook. `wait` reads its answer back. */
async function relay(event, body, wait = false) {
  // Coucou's own chat runs OpenCode too; those sessions stay off the island.
  if (process.env.COUCOU_HOOK_SKIP) return null;
  try {
    const proc = Bun.spawn([HOOK, "--agent", "opencode", event], {
      stdin: "pipe",
      stdout: wait ? "pipe" : "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(JSON.stringify({ hook_event_name: event, ...body }));
    proc.stdin.end();
    if (wait === "exit") {
      await proc.exited;
      return null;
    }
    if (!wait) return null;
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim() ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

export const Coucou = async ({ directory }) => {
  const cwd = directory ?? process.cwd();
  /** Each tool call's input, from its start to its end, which does not repeat it. */
  const calls = new Map();
  /** Who wrote each message, and each session's last words from the assistant. */
  const roles = new Map();
  const said = new Map();
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const sid = p.sessionID ?? p.info?.id ?? "";
      switch (event.type) {
        case "message.updated":
          if (p.info?.id) roles.set(p.info.id, p.info.role);
          break;
        case "message.part.updated": {
          const part = p.part;
          if (part?.type === "text" && !part.synthetic && part.text?.trim()) {
            said.set(part.sessionID, { message: part.messageID, text: part.text });
          }
          break;
        }
        case "session.created":
          if (!p.info?.parentID) relay("SessionStart", { session_id: sid, cwd });
          break;
        case "session.idle": {
          const last = said.get(sid);
          const words = last && roles.get(last.message) === "assistant" ? last.text : undefined;
          said.delete(sid);
          relay("Stop", { session_id: sid, cwd, last_assistant_message: words });
          break;
        }
        case "session.error":
          relay("StopFailure", { session_id: sid, cwd });
          break;
        case "session.deleted":
          relay("SessionEnd", { session_id: sid, cwd });
          break;
      }
    },

    "chat.message": async (input, output) => {
      const prompt = (output?.parts ?? [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join(" ");
      relay("UserPromptSubmit", { session_id: input.sessionID, cwd, prompt });
    },

    "tool.execute.before": async (input, output) => {
      const tool = TOOLS[input.tool] ?? input.tool;
      const toolInputNow = toolInput(output?.args);
      if (input.callID) calls.set(input.callID, toolInputNow);
      // An edit waits for the relay to have copied its files.
      await relay(
        "PreToolUse",
        { session_id: input.sessionID, cwd, tool_name: tool, tool_input: toolInputNow, tool_use_id: input.callID },
        EDITS.has(tool) ? "exit" : false,
      );
    },

    "tool.execute.after": async (input, output) => {
      const tool = TOOLS[input.tool] ?? input.tool;
      const toolInputThen = calls.get(input.callID) ?? toolInput(input.args);
      calls.delete(input.callID);
      relay("PostToolUse", {
        session_id: input.sessionID,
        cwd,
        tool_name: tool,
        tool_input: toolInputThen,
        tool_use_id: input.callID,
        tool_response: toolResponse(tool, output),
      });
    },

    // Approve or deny from the island. No answer leaves the status alone, so
    // OpenCode asks in the terminal as usual.
    "permission.ask": async (info, output) => {
      const kind = info.permission ?? info.type ?? "permission";
      const patterns = info.patterns ?? (info.pattern ? [].concat(info.pattern) : []);
      const target = info.metadata?.command ?? (patterns.length ? patterns.join(", ") : info.title);
      const answer = await relay(
        "PermissionRequest",
        {
          session_id: info.sessionID,
          cwd,
          tool_name: TOOLS[kind] ?? kind,
          tool_input: target ? { command: String(target) } : {},
        },
        true,
      );
      const behavior = answer?.hookSpecificOutput?.decision?.behavior;
      if (behavior === "allow" || behavior === "deny") output.status = behavior;
    },
  };
};
