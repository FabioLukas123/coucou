// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp, mixColor } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, type Bar } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_H, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  WAKE_STRIP_H, islandSize,
  type BotStateName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { CLAUDE_ID, QUESTION_TOOL, State, isAgentTask, type SessionStep } from "../core/state";
import { BotEngine, hexToRGB, type RGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { githubData } from "../views/integrations";
import { enterSessionPanel } from "../views/session";
import { followNews } from "./integrations";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
/** Bar mode: the minimised island is just big enough for Mochi. */
const BAR_PILL_W = 44;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

/** How fast Mochi's body goes to a new colour, per second: about 90 % of the way in 0.4 s. */
const TINT_RATE = 5.5;
/** Closer than this on every channel (0…1), the body has its colour: a unit of 8-bit colour. */
const TINT_SETTLED = 0.004;

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  /** Distance of the island from the top of the window: 0 without a bar. */
  private top = new Tracked(0);
  /**
   * Linux, with a top bar (Waybar): the minimised island is just Mochi,
   * centred in the bar. Opening it hides the bar and the island hangs from the
   * top edge exactly like the original.
   */
  private bar: Bar | null = null;
  /** What Rust was last told: is this island open over a hidden bar? */
  private toldOpen = false;
  /** The bar is away (hidden by the shell or another display's island). */
  private suppressed = false;

  /**
   * The island is open because the user opened it (a click), not because news
   * came in. Only then does a click elsewhere, or Esc, close it — a card that
   * popped up on its own must never swallow a click meant for another window.
   */
  private openedByUser = false;
  /** What Rust was last told: a click elsewhere closes this island. */
  private dismissable = false;
  /** Why the island wants the keyboard right now: the chat, a field, Esc. */
  private keyboardReasons = new Set<string>();
  private keyboardOn = false;

  /** Asks for the keyboard (or gives it back) for one reason among several. */
  setKeyboard(reason: string, on: boolean) {
    if (on) this.keyboardReasons.add(reason);
    else this.keyboardReasons.delete(reason);
    const want = this.keyboardReasons.size > 0;
    if (want === this.keyboardOn) return;
    this.keyboardOn = want;
    void Bridge.focusWindow(want);
  }

  /**
   * Opened by the user and not held open by a request: a click elsewhere
   * closes it, and Esc does while the pointer is over it (the keyboard is
   * only borrowed then, so typing elsewhere is never lost).
   */
  private syncDismiss() {
    if (State.mode !== "expanded") this.openedByUser = false;
    const on = State.mode === "expanded" && this.openedByUser && !State.isPinned;
    if (on !== this.dismissable) {
      this.dismissable = on;
      void Bridge.setDismissable(on);
    }
    this.setKeyboard("esc", on && this.wasInIsland);
  }

  /** A click landed outside the island (Rust's catcher). */
  dismiss() {
    if (State.mode === "expanded" && !State.isPinned) this.collapse();
  }
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  /**
   * A view asking Mochi to take a colour for a moment (a day of the GitHub
   * graph). His body only: the glow stays his own.
   */
  private tintRequest: RGB | null = null;
  /** A state a view asked Mochi to wear (see ViewActions.look). */
  private viewState: BotStateName | null = null;
  /** The colour Mochi's body is drawn in, eased towards what it should be. */
  private bodyRGB: RGB | null = null;

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.fsm.holdOpen = () => State.chatWaiting;
    // The full auto-close delay counts from the answer, so there is time to read it.
    State.onChatAnswered = () => {
      this.fsm.restartHomeCollapse();
      if (this.homeCollapseAt != null) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    };
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A request that came in while another pill had the front only left a
        // badge: bringing Claude's pill forward is asking for its card.
        if (id !== CLAUDE_ID) return;
        if (State.pendingQuestion) this.setView("question");
        else if (State.pendingApproval) this.setView("approval");
        // No card for the session in front, but one behind it is waiting: its turn.
        else if (State.waiting.length > 0) this.afterRequest(true);
      },
      openTerminal: () => {
        // Claude Code's sessions know their client; Codex and OpenCode, their terminal.
        const task = State.focusTask;
        if (task && task.id !== CLAUDE_ID && isAgentTask(task.id)) {
          void Bridge.openSession(task.sessionCwd ?? null, task.sessionPids ?? null);
        } else {
          this.openClient();
        }
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_ID) this.openClient();
        else if (isAgentTask(task.id)) void Bridge.openSession(task.sessionCwd ?? null, task.sessionPids ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (task.id === "integration_github" && githubData()) void Bridge.openUrl(githubData()!.profileUrl);
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.noteOutcome(req.tool, (step) => (step.permission = d === "deny" ? "denied" : "allowed"));
        this.settleRequest();
      },
      answer: (answers) => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.noteOutcome(QUESTION_TOOL, (step) => (step.answers = answers));
        this.settleRequest();
      },
      skipQuestion: () => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecision(req.requestId, "skip");
        this.noteOutcome(QUESTION_TOOL, (step) => (step.state = "failed"));
        this.settleRequest();
      },
      passQuestion: () => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("blip");
        // Declined, not denied: Claude Code asks it in its own window at once.
        void Bridge.approvalDecline(req.requestId);
        this.settleRequest();
      },
      keyboard: (on) => this.setKeyboard("field", on),
      openSession: (changes) => {
        enterSessionPanel(changes === true);
        this.setView("session");
      },
      pickSession: (id) => this.pickSession(id),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      emote: (e) => this.engine.triggerEmote(e),
      tintMochi: (color) => {
        this.tintRequest = color ? hexToRGB(color) : null;
        this.ensureRunning();
      },
      look: (state) => {
        if (this.viewState === state) return;
        this.viewState = state;
        State.notify();
      },
      followNews: () => followNews(this),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    // Whatever asked for a tint is no longer under the mouse.
    this.tintRequest = null;
    this.viewState = null;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      // A closed island never keeps the keyboard, whatever asked for it.
      this.keyboardReasons.clear();
      this.keyboardOn = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    this.tintRequest = null;
    this.viewState = null;
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /** Writes what was decided on the island in the journal, on the step that was waiting for it. */
  private noteOutcome(tool: string, write: (step: SessionStep) => void) {
    const step = [...State.session.steps].reverse().find((s) => s.tool === tool && s.state === "running");
    if (step) write(step);
  }

  /** The request on the card got its answer: its session is back at work. */
  private settleRequest() {
    const session = State.session;
    session.approval = null;
    session.question = null;
    session.state = "working";
    this.afterRequest(true);
  }

  /**
   * The request of the session in front is done with. Another session waiting
   * for an answer comes forward with its own; with none, the island is free
   * to close again. `show` moves the view too: to that card, or back to the
   * overview.
   */
  afterRequest(show: boolean) {
    const next = State.pendingApproval || State.pendingQuestion ? State.session : State.waiting[0];
    if (next) State.bringForward(next.id);
    State.isPinned = next != null;
    this.fsm.pinned = next != null;
    State.setPillBadge(CLAUDE_ID, next && State.focusId !== CLAUDE_ID ? "approval" : null);
    State.present();
    if (show) this.setView(next ? (next.question ? "question" : "approval") : State.defaultView());
  }

  /**
   * Puts another session in front, at the user's asking: its card if it is
   * waiting for an answer, and never the card of the one that was there.
   */
  private pickSession(id: string) {
    if (id === State.frontId) return;
    Sound.play("blip");
    State.bringForward(id);
    const session = State.session;
    const waits = session.question != null || session.approval != null;
    State.isPinned = waits;
    this.fsm.pinned = waits;
    if (waits) this.setView(session.question ? "question" : "approval");
    else if (State.view === "approval" || State.view === "question") this.setView(State.defaultView());
  }

  /** Where the session runs: the Claude app brought forward, or its folder in VS Code. */
  private openClient() {
    const session = State.session;
    if (session.client === "desktop") void Bridge.openClaudeApp();
    // Linux brings the session's own terminal forward (or opens one in its
    // folder); Windows opens the folder in VS Code.
    else if (State.platform === "linux") void Bridge.openSession(session.cwd ?? null, session.pids ?? null);
    else void Bridge.openInVSCode(State.tasks.find((t) => t.id === CLAUDE_ID)?.sessionCwd ?? null);
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    // News opened it (unless the user already had it open).
    if (State.mode !== "expanded") this.openedByUser = false;
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[]; position?: { x: number; y: number } }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    // No mouse events during a drag: on Linux the drag itself says where it is.
    if (this.domCursor && e.position && (e.type === "enter" || e.type === "over")) {
      const dpr = window.devicePixelRatio || 1;
      this.onCursor(e.position.x / dpr, e.position.y / dpr);
    }
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const news = State.focusId != null && State.integrations[State.focusId]?.news != null;
    const proposal = State.pendingApproval?.proposal != null;
    // A view that knows how tall its content is has the last word.
    const fitted = this.views?.get(State.view)?.height ?? null;
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, news, proposal, fitted);
    if (this.bar && State.mode !== "expanded") return { w: BAR_PILL_W, h, r: NOTCH_H / 2 };
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private targetTop(): number {
    const bar = this.bar;
    if (!bar || State.mode === "expanded") return 0;
    return bar.top + (bar.height - NOTCH_H) / 2;
  }

  /**
   * Bar mode: while the bar is away Mochi has nowhere to sit, so the minimised
   * island disappears (Rust also stops it taking the mouse). An open island —
   * an approval, say — still shows.
   */
  setSuppressed(quiet: boolean) {
    this.suppressed = quiet;
    this.applySkin();
  }

  /** The bar this island's display has, from Rust; null for the plain island. */
  setBar(bar: Bar | null) {
    const same = bar?.top === this.bar?.top && bar?.height === this.bar?.height;
    this.bar = bar;
    // Hovering the middle of the bar wakes a hidden island.
    this.wakeStrip.style.height = `${bar ? bar.top + bar.height : WAKE_STRIP_H}px`;
    this.applySkin();
    if (same) return;
    this.top.jump(this.targetTop());
    this.radius.jump(this.targetSize().r);
    this.dirty = true;
    this.ensureRunning();
  }

  /**
   * In a bar the minimised island has no background and no mini bots — only
   * Mochi, sitting on the bar. Open, it is the original black island, and the
   * bar steps aside for it.
   */
  private applySkin() {
    const inBar = this.bar != null && State.mode !== "expanded";
    this.islandEl.style.background = inBar ? "transparent" : "";
    this.miniGrid.style.display = inBar ? "none" : "";
    const quiet = this.suppressed && State.mode !== "expanded";
    this.islandEl.style.visibility = quiet ? "hidden" : "";
    this.wakeStrip.style.pointerEvents = quiet ? "none" : "";
    const open = this.bar != null && State.mode === "expanded";
    if (open !== this.toldOpen) {
      this.toldOpen = open;
      void Bridge.islandOpen(open);
    }
  }

  private animateGeometry(shrinking: boolean) {
    this.applySkin();
    const { w, h, r } = this.targetSize();
    const top = this.targetTop();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
      this.top.curveTowards(top);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
      this.top.springTo(top);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    const top = this.top.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.top = `${top}px`;
    this.islandEl.style.borderRadius =
      this.bar && State.mode !== "expanded" ? `${r}px` : `0 0 ${r}px ${r}px`;
    // Centred on a whole pixel of the screen. `translateX(-50%)` put the island
    // on a fraction of one for as long as its width was animating, and whatever
    // was painted then in a layer of its own — a scrolling list, say — kept
    // that fraction once the island had settled: its text stayed smeared until
    // it was drawn again.
    const dpr = window.devicePixelRatio || 1;
    this.islandEl.style.transform = `translateX(${-Math.round((w / 2) * dpr) / dpr}px)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: top, w, h: hh };
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: this.top.value, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.openedByUser = true;
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        // A Mochi with news to tell takes you to it; any other gets his slap.
        if (!followNews(this)) this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.useDomCursor();
  }

  private domCursor = false;

  /**
   * Drive the island from the webview's own mouse events. Used in a plain
   * browser, and on Linux wherever no global cursor can be read (Wayland):
   * the window only takes the mouse over the island shape, so leaving the
   * page is leaving the island.
   */
  useDomCursor() {
    if (this.domCursor) return;
    this.domCursor = true;
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    if (IS_TAURI) {
      document.documentElement.addEventListener("mouseleave", () => this.onCursor(-1e4, -1e4));
    }
  }

  /**
   * A request was answered on another display's island: this one drops the
   * same card, the way it would after its own click.
   */
  resolveApproval(requestId: string) {
    const session = State.sessions.find(
      (s) => s.approval?.requestId === requestId || s.question?.requestId === requestId,
    );
    if (!session) return;
    session.approval = null;
    session.question = null;
    session.state = "working";
    this.afterRequest(true);
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    if (inIsland !== this.wasInIsland) {
      this.wasInIsland = inIsland;
      this.syncDismiss();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.top.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating || this.top.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || this.tintSettling ||
        // A view showing something live keeps its Mochis moving: a run's crew
        // would otherwise freeze the moment the big one came to rest.
        this.viewState != null;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    // In a bar the minimised island is only Mochi: centre it.
    if (this.bar && State.mode !== "expanded") p.cx = BAR_PILL_W / 2;
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const eased = this.easeBodyColor(dt);
    // In the bar Mochi is always the white one; colours are for the open island.
    this.engine.bodyColor = this.bar != null && State.mode !== "expanded" ? null : eased;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** The colour Mochi should be: a view's request, else his pill's colour. */
  private targetBodyColor(): RGB | null {
    if (this.tintRequest) return this.tintRequest;
    const focus = State.focusTask;
    return focus?.isIntegration ? hexToRGB(focus.color) : null;
  }

  /**
   * Eases the body towards its target rather than jumping, so sliding the mouse
   * across the graph reads as Mochi slowly changing colour, not flickering:
   * about 90 % of the way in 0.4 s, blended in OKLab so red to green stays
   * bright instead of dipping through brown. Null — his own cream gradient —
   * can't be blended into, and is simply taken.
   */
  private easeBodyColor(dt: number): RGB | null {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) {
      this.bodyRGB = target;
      return target;
    }
    this.bodyRGB = mixColor(this.bodyRGB, target, 1 - Math.exp(-dt * TINT_RATE));
    return this.bodyRGB;
  }

  /** True while the body colour is still on its way — the frame loop keeps going. */
  private get tintSettling(): boolean {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) return false;
    return this.bodyRGB.some((v, i) => Math.abs(v - target[i]) > TINT_SETTLED);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || State.chatWaiting || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    // Folded or hidden, the views are out of sight but still in the page: what
    // moves in them on its own stops (see #content.away), and picks up when the
    // island unfolds.
    this.contentEl.classList.toggle("away", !expanded);
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        this.setKeyboard("chat", true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        this.setKeyboard("chat", false);
      }
    }
    // Opened by the user, pinned by a request, closed: who may close it changes.
    this.syncDismiss();

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    // A view's look fills in for a Mochi with nothing of his own to say: idle,
    // or only "working" — which the view, closer to what it shows, knows better.
    const state = State.effectiveState;
    const quiet = state === "idle" || state === "working";
    this.engine.setState(this.viewState && quiet ? this.viewState : state);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
