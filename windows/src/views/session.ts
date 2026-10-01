// The session panel — a Claude Code session, followed from the island.
//
// The layout the prototype draws for a session: Mochi's column on the left with
// the session's name and its last steps (Read, Edit, Bash… done, or going), and
// on the right the session's journal, read like a conversation: what was asked,
// then each thing Claude did in the order it did it — a file read with its
// first lines, an edit with its diff, typed as it lands, a command with what
// it printed, a question with what was picked, a permission with what was
// decided — and what Claude said to end its turn. Behind it, the files the
// session has changed and each one's whole diff. It is for watching: to
// answer, there is Claude Code.
//
// Windows only for now. It is the GitHub panel's layout and diff again, and
// nothing here is fetched: it is all in the hooks Claude Code already sends.
// An edit is shown the moment Claude Code says it is done, so the typing is a
// replay of it, a second behind. The session itself stays where it runs — the
// Claude app, VS Code, a terminal.

import { h, svg, clear, dot, replay } from "./dom";
import { diffLine, extBadge, fileKind, plusMinus, readPatch, splitPath, type FileKind } from "./code";
import { ICONS } from "./icons";
import { COLOR } from "./palette";
import { timeAgo } from "./integrations";
import { markdown } from "./markdown";
import { CLAUDE_ID, State, type ChangedFile, type ClaudeSession, type SessionStep } from "../core/state";
import { stepIcon, stepName, stepPreview, type ToType } from "./step";
import { botGlowColor } from "../core/layout";
import type { ViewActions, ViewHost } from "./views";

/** What a session is called until it has a project or a title to go by. */
const UNNAMED = "Claude Code";
/** Steps the column has room for: the last ones. */
const STEPS_SHOWN = 4;
/** An edit is typed out when it reached the island less than this ago; older, it is just shown. */
const FRESH_MS = 4_000;
/** However long the edit, typing it takes about this long, a tick at a time. */
const TYPE_MS = 1_800;
const TICK_MS = 16;

/** Lines of what a step did that its entry of the journal shows; an edit's whole diff is behind **N files**. */
const JOURNAL_LINES = 14;
/** This close to the journal's end, it is being followed: what comes next is scrolled to. */
const FOLLOW_PX = 24;

/** What is on screen: the journal, the list of changes, or one file's diff. */
type Screen = { kind: "live" } | { kind: "list" } | { kind: "file"; path: string };
let screen: Screen = { kind: "live" };
/** Bumped by every action: what the view shows has changed. */
let stamp = 0;

function go(next: Screen) {
  screen = next;
  stamp++;
  State.notify();
}

/** Back on the session's journal, at its end — or, asked for its changes, on their list. */
export function enterSessionPanel(changes = false) {
  screen = { kind: changes ? "list" : "live" };
  stamp++;
}

const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// ── Several sessions ──────────────────────────────────────────────────────────

/** A session by its name: the conversation's title, or untitled, the folder it works in. */
export const sessionName = (session: ClaudeSession) => session.title ?? session.project;

/** Where a session is at, as a colour and in words: what its tab shows and says. */
function standing(session: ClaudeSession): { color: string; words: string } {
  if (session.question) return { color: COLOR.cyan, words: "is asking a question" };
  if (session.approval) return { color: COLOR.amber, words: "needs permission" };
  if (session.news === "error" || session.state === "error") return { color: COLOR.red, words: "stopped on an error" };
  if (session.news === "finished" || session.state === "finished") return { color: COLOR.green, words: "finished" };
  if (session.state === "question") return { color: COLOR.cyan, words: "is waiting for you" };
  if (session.state === "idle" || session.state === "sleeping") return { color: COLOR.grey, words: "at rest" };
  return { color: botGlowColor(session.state), words: "at work" };
}

/**
 * Keeps a row of tabs in step with the sessions behind the one in front —
 * that one is named right above them. A tab is a dot for where its session is
 * at, and its name; one waiting for an answer, or with news nobody has seen,
 * stands out in its colour. Tabs are kept and updated where they are: a
 * session that changes state changes its dot's colour, a new one comes in, and
 * nothing is rebuilt between a mouse-down and its mouse-up.
 * Returns how many tabs it shows.
 */
export function sessionTabs(el: HTMLElement, onPick: (id: string) => void): () => number {
  const tabs = new Map<string, { tab: HTMLElement; mark: HTMLElement; label: HTMLElement }>();
  return () => {
    const behind = State.sessions.filter((s) => s.id !== State.frontId);
    for (const [id, { tab }] of tabs) {
      if (behind.some((s) => s.id === id)) continue;
      tab.remove();
      tabs.delete(id);
    }
    behind.forEach((session, i) => {
      let made = tabs.get(session.id);
      if (!made) {
        const mark = dot(COLOR.grey, 6);
        const label = h("span");
        const tab = h("button", { class: "sess-tab in", onclick: () => onPick(session.id) }, mark, label);
        made = { tab, mark, label };
        tabs.set(session.id, made);
      }
      const { color, words } = standing(session);
      const name = sessionName(session);
      made.mark.style.background = color;
      made.label.textContent = name;
      made.tab.title = `${name} — ${words}`;
      made.tab.style.setProperty("--c", color);
      made.tab.classList.toggle("calls", session.news != null || session.question != null || session.approval != null);
      if (el.children[i] !== made.tab) el.insertBefore(made.tab, el.children[i] ?? null);
    });
    el.style.display = behind.length > 0 ? "" : "none";
    return behind.length;
  };
}

/** What happened to the file, as the GitHub panel says it: "edited" in grey, "new" in green. */
function statusWord(file: ChangedFile): HTMLElement {
  const word = h("span", { class: "gh-file-status", text: file.created ? "new" : "edited" });
  if (file.created) word.style.color = COLOR.green;
  return word;
}

function fileRow(file: ChangedFile): HTMLElement {
  const { dir, base } = splitPath(file.path);
  return h(
    "button",
    { class: "gh-row gh-file", title: file.path, onclick: () => go({ kind: "file", path: file.path }) },
    h("i", { class: "gh-row-icon" }, extBadge(file.path)),
    h("span", { class: "gh-row-title", text: base }),
    h("span", { class: "gh-row-where", text: dir }),
    h("span", { class: "gh-right" }, statusWord(file), plusMinus(file.additions, file.deletions), h("span", { class: "int-ago", text: timeAgo(file.at) })),
  );
}

/** A quiet line across a diff: lines skipped, or the start of another edit. */
function diffBreak(text: string): HTMLElement {
  return h("div", { class: "gh-diff-line hunk" }, h("span", { class: "n", text: "⋯" }), h("span", { class: "s" }), h("span", { class: "t", text }));
}

/** Every edit to the file, oldest first, a quiet break between two of them. */
function diffView(file: ChangedFile, kind: FileKind): HTMLElement {
  const diff = h("div", { class: "gh-diff" });
  const several = file.edits.length > 1;
  file.edits.forEach((edit, i) => {
    let first = true;
    for (const line of readPatch(edit.patch)) {
      if ("hunk" in line) {
        // Between two edits, which one this is; inside one, where lines were skipped.
        const label = first && several ? `Edit ${i + 1} of ${file.edits.length} · ${timeAgo(edit.at)}` : "";
        if (!first || label) diff.append(diffBreak(label));
        first = false;
        continue;
      }
      diff.append(diffLine(line.new ?? line.old, line.sign, line.text, kind));
    }
    if (edit.truncated) diff.append(diffBreak("The rest of this edit is in Claude Code"));
  });
  return h("div", { class: "gh-code" }, diff);
}

// ── The journal ───────────────────────────────────────────────────────────────

/** When a line of the journal happened, as a clock shows it. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Several options picked for one question come back as one answer, joined like this. */
const ANSWER_JOIN = ", ";

/** Where a tool's permission request stands, in a word and a colour. */
const PERMISSIONS = {
  asked: { words: "needs permission", color: COLOR.amber },
  allowed: { words: "allowed", color: COLOR.green },
  denied: { words: "denied", color: COLOR.red },
} as const;

function chip(text: string, color: string): HTMLElement {
  const el = h("span", { class: "jr-chip", text });
  el.style.setProperty("--c", color);
  return el;
}

/** A question Claude asked, with its options — and, once it is answered, the ones picked lit. */
function askedView(step: SessionStep): HTMLElement {
  const el = h("div", { class: "jr-asks" });
  for (const q of step.questions ?? []) {
    const answer = step.answers?.[q.question] ?? null;
    const picked = new Set(answer == null ? [] : [answer, ...answer.split(ANSWER_JOIN)]);
    const options = h("div", { class: "jr-options" });
    let matched = false;
    for (const option of q.options) {
      const on = picked.has(option.label);
      matched ||= on;
      options.append(h("span", { class: on ? "jr-option on" : "jr-option", text: option.label, title: option.description ?? "" }));
    }
    // An answer typed rather than picked is none of the options: it is shown as it was written.
    if (answer && !matched) options.append(h("span", { class: "jr-option on typed", text: answer }));
    el.append(h("div", { class: "jr-q" }, h("div", { class: "jr-q-title", text: q.question }), options));
  }
  if (!step.answers) {
    el.append(h("div", { class: "jr-waiting", text: step.state === "running" ? "Waiting for an answer…" : step.state === "failed" ? "Left unanswered." : "Answered in Claude Code." }));
  }
  return el;
}

/**
 * One line of the journal. Something said is shown as it was said: the user's
 * words in a bubble, Claude's as it wrote them. A tool is its icon, its name
 * and what it was at, then a look at what it did.
 */
function journalEntry(step: SessionStep, typed?: ToType[]): HTMLElement {
  if (step.kind === "prompt") {
    return h("div", { class: "jr jr-asked" }, h("div", { class: "sess-asked", text: step.target ?? "", title: clock(step.at) }));
  }
  if (step.kind === "reply") {
    return h(
      "div",
      { class: "jr jr-reply" },
      h("div", { class: "sess-said" }, dot(COLOR.green, 6), h("b", { text: "Claude" }), h("span", { text: clock(step.at) })),
      step.target ? markdown(step.target) : h("div", { class: "jr-waiting", text: "The turn ended without a word." }),
    );
  }
  if (step.kind === "note") {
    return h("div", { class: step.state === "failed" ? "jr jr-note failed" : "jr jr-note", text: step.target ?? "" });
  }

  const target = step.target?.split("\n")[0] ?? "";
  const head = h(
    "div",
    { class: "jr-head" },
    h("i", {}, stepIcon(step, 11)),
    h("b", { text: stepName(step) }),
    h("span", { class: "at", text: target, title: step.target ?? "" }),
    h("div", { class: "grow" }),
  );
  if (step.permission) head.append(chip(PERMISSIONS[step.permission].words, PERMISSIONS[step.permission].color));
  if (step.state === "running") head.append(h("i", { class: "sess-mark run" }));
  else if (step.state === "failed" && !step.questions) head.append(chip("failed", COLOR.red));
  head.append(h("span", { class: "jr-time", text: clock(step.at) }));

  const el = h("div", { class: `jr jr-step ${step.state}` }, head);
  if (step.questions) el.append(askedView(step));
  else {
    const preview = stepPreview(step, JOURNAL_LINES, typed);
    if (preview) el.append(h("div", { class: "jr-body" }, preview));
  }
  return el;
}

/** What an entry is drawn from: when it changes, the entry is drawn again. */
const entryKey = (step: SessionStep) =>
  [step.state, step.result?.text.length, step.patch?.length, step.permission, step.answers ? Object.values(step.answers).join("|") : ""].join("~");

/** The kinds of journal line the column's short list leaves out: they are words, not steps. */
const NOT_A_STEP: ReadonlySet<SessionStep["kind"]> = new Set<SessionStep["kind"]>(["prompt", "note"]);

const STEP_ICONS: Record<SessionStep["state"], () => Element> = {
  running: () => h("i", { class: "sess-mark run" }),
  done: () => h("i", { class: "sess-mark done" }, svg(ICONS.check, 8, { stroke: 3.2 })),
  failed: () => h("i", { class: "sess-mark failed" }, svg(ICONS.xmark, 7)),
};

export function buildSession(actions: ViewActions): ViewHost {
  const who = h("b", { text: UNNAMED });
  const sub = h("span", { class: "gh-sub" });
  const badge = h("span", { class: "gh-head-badge" });
  const aside = h("span", { class: "gh-head-aside" });
  // One step back: from a file to the changes, from the changes to the journal.
  const backBtn = h("button", { class: "gh-icon sess-back", title: "Back" }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const filesBtn = h("button", { class: "sess-files", title: "Every file this session changed" });
  const openBtn = h(
    "button",
    { class: "gh-icon", title: "Open the session", onclick: () => actions.openTerminal() },
    svg(ICONS.arrowUpRight, 10),
  );
  const tab = h("div", { class: "gh-tab" }, badge, who);
  const head = h("div", { class: "gh-head" }, backBtn, tab, aside, h("div", { class: "grow" }), sub, filesBtn, openBtn);
  // The journal, and behind it the changes: one of the two is on screen.
  const journal = h("div", { class: "gh-list sess-journal" });
  const list = h("div", { class: "gh-list" });

  const main = h("div", { class: "gh-main" }, head, journal, list);
  const name = h("b", { text: UNNAMED });
  const nameSub = h("span", { text: UNNAMED });
  const steps = h("div", { class: "sess-steps" });
  // The sessions behind this one, at the foot of the column: a click puts one in front.
  const others = h("div", { class: "sess-others" });
  const syncOthers = sessionTabs(others, (id) => {
    screen = { kind: "live" };
    stamp++;
    actions.pickSession(id);
  });
  const side = h("div", { class: "gh-side" }, h("div", { class: "gh-side-who" }, name, nameSub), steps, others);
  const el = h("div", { class: "view gh-view session-view" }, h("div", { class: "card gh-card" }, side, h("div", { class: "gh-col" }, main)));

  backBtn.addEventListener("click", () => {
    actions.blip();
    go(screen.kind === "file" ? { kind: "list" } : { kind: "live" });
  });
  filesBtn.addEventListener("click", () => {
    actions.blip();
    go({ kind: "list" });
  });

  for (const scroller of [journal, list]) {
    const fade = () => scroller.classList.toggle("more", scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2);
    scroller.addEventListener("scroll", fade, { passive: true });
    new ResizeObserver(fade).observe(scroller);
  }

  // ── Typing ──────────────────────────────────────────────────────────────────

  let typing: number | null = null;
  /** Shows at once whatever the typing under way has left to type. */
  let finishTyping: (() => void) | null = null;

  function stopTyping() {
    if (typing != null) window.clearInterval(typing);
    typing = null;
    finishTyping?.();
    finishTyping = null;
    tab.classList.remove("writing");
  }

  /**
   * Types the new lines of an edit one after the other, a caret at the end,
   * each line taking its colours once it is whole. Out of sight — the island
   * folded, another view up — it has nobody to type for and ends at once.
   */
  function type(lines: ToType[], kind: FileKind) {
    stopTyping();
    if (lines.length === 0) return;
    const total = lines.reduce((n, l) => n + l.text.length + 1, 0);
    const perTick = Math.max(1, Math.ceil(total / (TYPE_MS / TICK_MS)));
    const caret = h("span", { class: "sess-caret" });
    let at = 0;
    let letters = 0;
    tab.classList.add("writing");

    const finish = (line: ToType) => line.row.replaceWith(diffLine(line.number, "+", line.text, kind));
    const begin = (line: ToType) => {
      line.row.classList.remove("untyped");
      line.row.scrollIntoView({ block: "nearest" });
    };
    begin(lines[0]);
    finishTyping = () => lines.slice(at).forEach(finish);

    typing = window.setInterval(() => {
      const seen = State.mode === "expanded" && State.view === "session" && lines[at].row.isConnected;
      let budget = seen ? perTick : total;
      while (budget > 0 && at < lines.length) {
        const line = lines[at];
        const step = Math.min(budget, line.text.length - letters);
        letters += step;
        budget -= step;
        if (letters < line.text.length) break;
        // The end of a line costs a letter: the pause of a carriage return.
        finish(line);
        budget -= 1;
        at++;
        letters = 0;
        if (at < lines.length) begin(lines[at]);
      }
      if (at >= lines.length) {
        stopTyping();
        journal.scrollTop = journal.scrollHeight;
        return;
      }
      const cell = lines[at].row.querySelector(".t");
      if (cell) {
        cell.textContent = lines[at].text.slice(0, letters);
        cell.append(caret);
      }
    }, TICK_MS);
  }

  // ── The journal ─────────────────────────────────────────────────────────────

  /** Each step's entry, kept: only one that changed is drawn again, and a scroll or a selection stays. */
  const entries = new WeakMap<SessionStep, { el: HTMLElement; key: string }>();
  /** The edits typed already: an edit is typed once. */
  const typedSteps = new WeakSet<SessionStep>();
  const empty = h("div", { class: "int-empty" });
  /** What the journal was last opened on: another session, or the panel entered again, starts at its end. */
  let opened = "";
  let shownSession = "";

  function syncJournal() {
    const session = State.session;
    const entering = opened !== `${session.id}:${stamp}`;
    opened = `${session.id}:${stamp}`;
    const following = entering || journal.scrollTop + journal.clientHeight >= journal.scrollHeight - FOLLOW_PX;

    let toType: { lines: ToType[]; kind: FileKind } | null = null;
    const wanted: HTMLElement[] = [];
    for (const step of session.steps) {
      const key = entryKey(step);
      let entry = entries.get(step);
      if (!entry || entry.key !== key) {
        const known = entry != null;
        // Typed once, and only while it is news: seen later, the edit is just there.
        const fresh = step.patch != null && !typedSteps.has(step) && !entering && Date.now() - step.at < FRESH_MS;
        if (step.patch != null) typedSteps.add(step);
        const lines: ToType[] = [];
        const drawn = journalEntry(step, fresh ? lines : undefined);
        // A line that is new comes in; one that got something more — what the
        // tool gave back, what was decided — only brings that in.
        if (!entering) drawn.classList.add(known ? "more" : "in");
        entry?.el.replaceWith(drawn);
        entry = { el: drawn, key };
        entries.set(step, entry);
        if (lines.length > 0) toType = { lines, kind: fileKind(step.target ?? "") };
      }
      wanted.push(entry.el);
    }
    if (wanted.length === 0) {
      empty.textContent = session.id ? "Nothing has happened in this session yet." : "No Claude Code session yet.";
      wanted.push(empty);
    }
    const same = journal.children.length === wanted.length && wanted.every((node, i) => journal.children[i] === node);
    if (!same) journal.replaceChildren(...wanted);

    // Another session's journal comes in from the side, as a sheet of the GitHub panel does.
    if (entering && session.id !== shownSession) {
      if (shownSession) replay(journal, "gh-from-right");
      shownSession = session.id;
    }
    if (toType) type(toType.lines, toType.kind);
    else if (following && typing == null) journal.scrollTo({ top: journal.scrollHeight, behavior: entering ? "auto" : "smooth" });
  }

  /** The steps the column has shown, and in what state: what is new, or just ended, is animated once. */
  const listed = new WeakMap<SessionStep, SessionStep["state"]>();
  let key = "";
  let headKey = "";
  let stepsKey = "";
  /** What the list last drew, to keep its scroll when it draws the same again. */
  let drawn = "";

  return {
    el,
    sync() {
      const task = State.tasks.find((t) => t.id === CLAUDE_ID) ?? null;
      const session = State.session;
      const files = State.sessionFiles;

      // The column: whose session, where it runs, and its last steps — fewer
      // of them when other sessions take a line each at its foot.
      const shown = session.steps.filter((s) => !NOT_A_STEP.has(s.kind)).slice(-Math.max(1, STEPS_SHOWN - syncOthers()));
      const nextSteps = [task?.name, session.title, ...shown.map((s) => `${s.tool}:${s.state}:${s.at}`)].join("~");
      if (nextSteps !== stepsKey) {
        stepsKey = nextSteps;
        // The conversation by its title, and under it the project it works in;
        // untitled, the project is its name.
        const project = task?.name ?? UNNAMED;
        name.textContent = session.title ?? project;
        name.title = session.title ?? "";
        nameSub.textContent = session.title ? project : UNNAMED;
        clear(steps);
        for (const s of shown) {
          const mark = STEP_ICONS[s.state]();
          const row = h("div", { class: `sess-step ${s.state}` }, mark, h("span", { text: stepName(s), title: s.kind === "reply" ? "" : (s.target ?? s.tool) }));
          // A step nobody has seen yet comes in; one that just ended gets its mark with a pop.
          const before = listed.get(s);
          if (before == null) row.classList.add("in");
          else if (before !== s.state) mark.classList.add("in");
          listed.set(s, s.state);
          steps.append(row);
        }
      }

      // A file opened and gone since (another session took over): the list.
      const opened = screen.kind === "file" ? screen.path : null;
      const picked = opened ? (files.find((f) => f.path === opened) ?? null) : null;
      if (screen.kind === "file" && !picked) screen = { kind: "list" };
      const live = screen.kind === "live";
      journal.style.display = live ? "" : "none";
      list.style.display = live ? "none" : "";
      if (!live) stopTyping();

      // The head: the journal is the journal, whatever file Claude is at; a
      // file opened from the changes has its name on the tab, as in an editor.
      const path = picked?.path ?? null;
      const nextHead = [session.id, screen.kind, path, files.length, picked?.edits.length].join("~");
      if (nextHead !== headKey) {
        headKey = nextHead;
        clear(badge);
        clear(aside);
        sub.classList.toggle("path", path != null);
        who.classList.toggle("file", path != null);
        backBtn.style.display = live ? "none" : "";
        filesBtn.style.display = live && files.length > 0 ? "" : "none";
        filesBtn.textContent = counted(files.length, "file");
        if (path) {
          who.textContent = splitPath(path).base;
          sub.textContent = path;
          badge.append(extBadge(path));
        } else {
          who.textContent = live ? "Journal" : "Changes";
          sub.textContent = !live && files.length > 0 ? counted(files.length, "file") : "";
          badge.append(dot(task?.color ?? COLOR.idle, 7));
        }
        if (picked) aside.append(statusWord(picked), plusMinus(picked.additions, picked.deletions));
        else if (!live && files.length > 0) {
          aside.append(plusMinus(files.reduce((n, f) => n + f.additions, 0), files.reduce((n, f) => n + f.deletions, 0)));
        }
        main.style.setProperty("--accent", picked ? (picked.created ? COLOR.green : COLOR.amber) : "rgba(0,0,0,0)");
      }

      if (live) {
        syncJournal();
        return;
      }

      // Rebuilding the rows between a mouse-down and its mouse-up would swallow
      // the click, so only rebuild when something they show has changed.
      const total = files.reduce((n, f) => n + f.edits.length, 0);
      const next = [session.id, stamp, screen.kind, total, files[0]?.path].join("~");
      if (next === key) return;
      key = next;

      const now = `${screen.kind}:${picked?.path ?? ""}`;
      const scroll = now === drawn ? list.scrollTop : 0;
      drawn = now;
      clear(list);
      list.classList.toggle("gh-edge", picked != null);
      if (picked) list.append(diffView(picked, fileKind(picked.path)));
      else if (files.length === 0) list.append(h("div", { class: "int-empty", text: "Nothing written in this session yet." }));
      else for (const f of files) list.append(fileRow(f));
      list.scrollTop = scroll;
    },
  };
}
