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
  patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
};

function toolInput(args) {
  const input = { ...(args ?? {}) };
  if (typeof input.filePath === "string") input.file_path = input.filePath;
  return input;
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
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const sid = p.sessionID ?? p.info?.id ?? "";
      switch (event.type) {
        case "session.created":
          if (!p.info?.parentID) relay("SessionStart", { session_id: sid, cwd });
          break;
        case "session.idle":
          relay("Stop", { session_id: sid, cwd });
          break;
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
      relay("PreToolUse", {
        session_id: input.sessionID,
        cwd,
        tool_name: TOOLS[input.tool] ?? input.tool,
        tool_input: toolInput(output?.args),
      });
    },

    "tool.execute.after": async (input) => {
      relay("PostToolUse", {
        session_id: input.sessionID,
        cwd,
        tool_name: TOOLS[input.tool] ?? input.tool,
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
