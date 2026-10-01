// The AI usage panel: how much of each coding agent's plan is spent, side by
// side — Claude (its 5-hour and weekly limits), Codex (the same two, read from
// its own session logs) and OpenCode Go (5 hours, week, month). Reached from
// its tab in the header, between Ask and Drop.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { h, clear, dot } from "./dom";
import type { ViewHost } from "./views";

interface Window {
  label: string;
  percent: number;
  /** When it starts over, in ms since the epoch; 0 when unknown. */
  resetsAt: number;
}

interface Column {
  id: string;
  name: string;
  color: string;
  plan: string;
  windows: Window[];
  error: string | null;
}

/** ISO date or epoch seconds → ms. */
function toMs(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v) return Date.parse(v) || 0;
  return 0;
}

/** "2h 10m", "3d" — until a window starts over. */
function resetsIn(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, (ms - Date.now()) / 1000);
  // Rounded once, in minutes: 4 h 59 min 40 s is 5h00, never 4h60.
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(s / 86400)}d`;
}

function data(id: string): Record<string, Record<string, unknown>> {
  return (State.integrations[id]?.data ?? {}) as Record<string, Record<string, unknown>>;
}

function columns(): Column[] {
  const claude = data("usage_claude");
  const codex = data("integration_codex");
  const go = data("integration_opencode");
  const win = (label: string, w?: Record<string, unknown>): Window => {
    const resetsAt = toMs(w?.resetsAt);
    // Codex's numbers come from its last session's log: once the window has
    // started over since, they are stale, and the window is in fact empty.
    if (resetsAt && resetsAt < Date.now()) return { label, percent: 0, resetsAt: 0 };
    return { label, percent: Number(w?.percent ?? 0), resetsAt };
  };
  const plan = String((State.integrations.usage_claude?.data as Record<string, unknown> | undefined)?.plan ?? "");
  return [
    {
      id: "usage_claude", name: "Claude", color: "#F5F6F8",
      plan: plan ? plan[0].toUpperCase() + plan.slice(1) : "",
      windows: [win("5h", claude.fiveHour), win("Week", claude.week)],
      error: State.integrations.usage_claude?.error ?? null,
    },
    {
      id: "integration_codex", name: "Codex", color: "#10A37F", plan: "",
      windows: [win("5h", codex.primary), win("Week", codex.secondary)],
      error: State.integrations.integration_codex?.error ?? null,
    },
    {
      id: "integration_opencode", name: "OpenCode", color: "#FAB283", plan: "Go",
      windows: [win("5h", go.rolling), win("Week", go.weekly), win("Month", go.monthly)],
      error: State.integrations.integration_opencode?.error ?? null,
    },
  ];
}

function bar(color: string, w: Window): HTMLElement {
  const pct = Math.max(0, Math.min(100, w.percent));
  // The agent's own colour, until the window is nearly spent.
  const fill = pct >= 85 ? "#F4505E" : pct >= 70 ? "#F5A524" : color;
  return h(
    "div",
    { class: "use-row" },
    h("span", { class: "use-label", text: w.label }),
    h("div", { class: "use-track" }, h("i", { style: `width:${pct}%;background:${fill}` })),
    h("span", { class: "use-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "use-reset", text: resetsIn(w.resetsAt) }),
  );
}

function column(c: Column): HTMLElement {
  const loaded = State.integrations[c.id]?.loaded ?? false;
  const head = h(
    "div",
    { class: "use-head" },
    dot(c.color, 6),
    h("span", { class: "use-name", text: c.name }),
    c.plan ? h("span", { class: "use-plan", text: c.plan }) : h("span", {}),
  );
  const body = c.error && !loaded
    ? h("div", { class: "use-note", text: c.error })
    : !loaded
      ? h("div", { class: "use-note", text: "Loading…" })
      : h("div", { class: "use-rows" }, ...c.windows.map((w) => bar(c.color, w)));
  return h("div", { class: "use-col" }, head, body);
}

const USAGE_IDS = ["usage_claude", "integration_codex", "integration_opencode"];

export function buildUsage(): ViewHost {
  const cols = h("div", { class: "use-cols" });
  const el = h("div", { class: "view" }, h("div", { class: "card" }, cols));
  let key = "";
  let askedAt = 0;
  return {
    el,
    sync() {
      // A poll that ran before the island was listening is lost until the
      // next one: whatever is still missing is asked for when the panel opens.
      if (State.view === "usage" && Date.now() - askedAt > 30_000) {
        const missing = USAGE_IDS.filter((id) => !State.integrations[id]?.loaded);
        if (missing.length) {
          askedAt = Date.now();
          for (const id of missing) void Bridge.refreshIntegration(id);
        }
      }
      const all = columns();
      const next = JSON.stringify(all) + Math.floor(Date.now() / 60000);
      if (next === key) return;
      key = next;
      clear(cols);
      for (const c of all) cols.append(column(c));
    },
  };
}
