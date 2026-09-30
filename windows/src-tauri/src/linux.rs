// The Linux side of the island window.
//
// Two ways to put a borderless, always-on-top, never-focused panel at the top
// of the screen, picked once at launch:
//
//   * **Layer shell** — on Wayland compositors that speak wlr-layer-shell
//     (Hyprland, Sway, KDE Plasma, niri, Wayfire…) the island is an overlay
//     layer surface anchored to the top edge. Wayland lets no client place its
//     own window, so this is the only way to sit exactly at top centre.
//   * **X11** — Xorg, and GNOME on Wayland through XWayland (Mutter has no
//     layer shell). Positions, keep-above and focus hints work as on Windows.
//
// Click-through does not follow the cursor like on Windows: the window's input
// region is simply cut to the island shape, and the compositor does the rest.
// Wayland has no global cursor, so the eyes follow the pointer across the
// whole screen only where one can be read — Hyprland's IPC socket or a real
// X server. Everywhere else the webview's own mouse events drive the island
// (see `dom_cursor`), which is all hover, clicks and drops need.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::OnceLock;
use std::time::Duration;

use gtk::prelude::*;
use gtk_layer_shell::LayerShell;
use tauri::{Monitor, WebviewWindow};

/// How the island is put on screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Surface {
    Layer,
    X11,
    /// Wayland without layer shell and without XWayland: the compositor places
    /// the window wherever it likes. Works, but not at the top edge.
    PlainWayland,
}

static SURFACE: OnceLock<Surface> = OnceLock::new();

pub fn surface() -> Surface {
    *SURFACE.get().unwrap_or(&Surface::X11)
}

/// Runs in `main`, before GTK starts: GNOME's Wayland session has no layer
/// shell, so the island goes through XWayland there. `COUCOU_BACKEND=x11`
/// forces the same anywhere, `COUCOU_BACKEND=wayland` the opposite.
pub fn pick_backend() {
    // WebKitGTK's DMA-BUF renderer draws transparent windows black or not at
    // all on a good share of drivers; the island is mostly transparent.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
        find_session_display();
    }
    if std::env::var_os("GDK_BACKEND").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return;
    }
    let forced = std::env::var("COUCOU_BACKEND").unwrap_or_default();
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
    let no_layer_shell = desktop.contains("gnome") || desktop.contains("unity");
    if forced == "x11" || (forced != "wayland" && no_layer_shell) {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

/// Started from somewhere with no display — an SSH shell, a systemd unit, a
/// terminal multiplexer that outlived its session. The user's desktop is
/// usually still there: join its Wayland socket (and Hyprland's IPC) rather
/// than letting GTK abort. With no desktop at all, say so and leave cleanly.
fn find_session_display() {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));

    let mut sockets: Vec<String> = std::fs::read_dir(&runtime)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("wayland-") && !n.ends_with(".lock"))
        .collect();
    sockets.sort();

    let Some(socket) = sockets.into_iter().next() else {
        eprintln!(
            "coucou: no graphical session found (WAYLAND_DISPLAY and DISPLAY are unset).\n\
             Start Coucou from your desktop — the app launcher, or a terminal inside it."
        );
        std::process::exit(1);
    };
    std::env::set_var("XDG_RUNTIME_DIR", &runtime);
    std::env::set_var("WAYLAND_DISPLAY", &socket);

    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        let newest = std::fs::read_dir(runtime.join("hypr"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().join(".socket.sock").exists())
            .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        if let Some(dir) = newest {
            std::env::set_var("HYPRLAND_INSTANCE_SIGNATURE", dir.file_name());
            if std::env::var_os("XDG_CURRENT_DESKTOP").is_none() {
                std::env::set_var("XDG_CURRENT_DESKTOP", "Hyprland");
            }
        }
    }
    eprintln!("coucou: no display in this shell — joining the desktop session on {socket}");
}

fn gdk_is_wayland() -> bool {
    gtk::gdk::Display::default()
        .map(|d| d.type_().name().contains("Wayland"))
        .unwrap_or(false)
}

/// Turns the (still unmapped) island window into the right kind of surface.
/// Must run before the window is first shown.
pub fn prepare_island(win: &WebviewWindow) {
    let Ok(gtk_win) = win.gtk_window() else { return };
    let surface = if !gdk_is_wayland() {
        Surface::X11
    } else if gtk_layer_shell::is_supported() {
        Surface::Layer
    } else {
        Surface::PlainWayland
    };
    let _ = SURFACE.set(surface);
    crate::log::line(format!("island surface: {surface:?}"));

    match surface {
        Surface::Layer => {
            gtk_win.init_layer_shell();
            gtk_win.set_namespace("coucou");
            gtk_win.set_layer(gtk_layer_shell::Layer::Overlay);
            // Anchored to the top edge only: the compositor centres it
            // horizontally, like the notch.
            gtk_win.set_anchor(gtk_layer_shell::Edge::Top, true);
            // -1: sit on the very top edge, over any bar, and push nothing aside.
            gtk_win.set_exclusive_zone(-1);
            gtk_win.set_keyboard_mode(gtk_layer_shell::KeyboardMode::None);
        }
        Surface::X11 | Surface::PlainWayland => {
            // The X11 twin of WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW.
            gtk_win.set_accept_focus(false);
            gtk_win.set_focus_on_map(false);
            gtk_win.set_skip_taskbar_hint(true);
            gtk_win.set_skip_pager_hint(true);
            gtk_win.set_type_hint(gtk::gdk::WindowTypeHint::Utility);
            gtk_win.set_keep_above(true);
            gtk_win.stick();
        }
    }
}

/// Let the chat field take the keyboard, or give it back.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Ok(gtk_win) = win.gtk_window() else { return };
    match surface() {
        Surface::Layer => gtk_win.set_keyboard_mode(if activating {
            gtk_layer_shell::KeyboardMode::OnDemand
        } else {
            gtk_layer_shell::KeyboardMode::None
        }),
        _ => gtk_win.set_accept_focus(activating),
    }
}

/// The GDK monitor behind a Tauri monitor: same origin once scaled.
fn gdk_monitor_for(m: &Monitor) -> Option<gtk::gdk::Monitor> {
    let display = gtk::gdk::Display::default()?;
    let p = m.position();
    (0..display.n_monitors())
        .filter_map(|i| display.monitor(i))
        .find(|g| {
            let geo = g.geometry();
            let s = g.scale_factor();
            geo.x() * s == p.x && geo.y() * s == p.y
        })
}

/// Layer-shell placement: pick the output and size the surface. The
/// compositor anchors it to the top edge; nothing else to do.
/// Returns the window origin in global logical coordinates.
pub fn place_layer(win: &WebviewWindow, m: &Monitor, lw: f64, lh: f64) -> (f64, f64) {
    let (w, h) = (lw.round() as i32, lh.round() as i32);
    let mut origin = {
        let scale = m.scale_factor();
        let p = m.position();
        let s = m.size();
        let (mx, my, mw) = (p.x as f64 / scale, p.y as f64 / scale, s.width as f64 / scale);
        (mx + (mw - lw) / 2.0, my)
    };
    if let Ok(gtk_win) = win.gtk_window() {
        if let Some(gm) = gdk_monitor_for(m) {
            let geo = gm.geometry();
            origin = (geo.x() as f64 + (geo.width() as f64 - lw) / 2.0, geo.y() as f64);
            gtk_win.set_monitor(&gm);
        }
        gtk_win.set_size_request(w, h);
        gtk_win.resize(w, h);
    }
    origin
}

/// Cuts the window's input region down to `rect` (window-logical px), or
/// gives the whole window back with `None`. Everything outside the region
/// goes straight through to whatever is below — that is the click-through.
pub fn set_input_region(win: &WebviewWindow, rect: Option<(f64, f64, f64, f64)>) {
    let Ok(gtk_win) = win.gtk_window() else { return };
    match rect {
        None => gtk_win.input_shape_combine_region(None),
        Some((x, y, w, h)) => {
            let r = gtk::cairo::RectangleInt::new(
                x.floor() as i32,
                y.floor() as i32,
                w.ceil().max(0.0) as i32,
                h.ceil().max(0.0) as i32,
            );
            let region = gtk::cairo::Region::create_rectangle(&r);
            gtk_win.input_shape_combine_region(Some(&region));
        }
    }
}

// ── Global cursor ────────────────────────────────────────────────────────────

/// Where a global cursor reading comes from, if anywhere.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CursorSource {
    /// Hyprland's IPC `cursorpos`: global logical coordinates.
    Hyprland,
    /// XQueryPointer on a real X server: root-window physical pixels.
    X11,
    None,
}

fn cursor_source() -> CursorSource {
    static SOURCE: OnceLock<CursorSource> = OnceLock::new();
    *SOURCE.get_or_init(|| {
        if surface() == Surface::Layer && hyprland_socket().is_some() {
            CursorSource::Hyprland
        } else if surface() == Surface::X11 && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            // Under XWayland the X server only hears about the pointer while it
            // is over an X window, so a reading from there would go stale the
            // moment the cursor leaves the island. Real X servers only.
            CursorSource::X11
        } else {
            CursorSource::None
        }
    })
}

/// True when the island has to be driven by the webview's own mouse events.
pub fn dom_cursor() -> bool {
    cursor_source() == CursorSource::None
}

/// Global cursor position. `logical` tells which unit it is in.
pub struct Cursor {
    pub x: f64,
    pub y: f64,
    pub logical: bool,
}

pub fn cursor() -> Option<Cursor> {
    match cursor_source() {
        CursorSource::Hyprland => hyprland_cursor().map(|(x, y)| Cursor { x, y, logical: true }),
        CursorSource::X11 => x11_cursor().map(|(x, y)| Cursor { x, y, logical: false }),
        CursorSource::None => None,
    }
}

fn hyprland_socket() -> Option<std::path::PathBuf> {
    let sig = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    let path = std::path::PathBuf::from(runtime).join("hypr").join(sig).join(".socket.sock");
    path.exists().then_some(path)
}

/// One `cursorpos` request on Hyprland's request socket: "1234, 56".
fn hyprland_cursor() -> Option<(f64, f64)> {
    static PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    let path = PATH.get_or_init(hyprland_socket).as_ref()?;
    let mut s = UnixStream::connect(path).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(50)));
    s.write_all(b"cursorpos").ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    let (x, y) = out.trim().split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// XQueryPointer through our own connection, so the poll thread never touches
/// GTK's. One connection per thread, opened on first use.
fn x11_cursor() -> Option<(f64, f64)> {
    use x11_dl::xlib;
    struct Conn {
        xlib: xlib::Xlib,
        display: *mut xlib::Display,
    }
    thread_local! {
        static CONN: Option<Conn> = xlib::Xlib::open().ok().and_then(|xlib| {
            let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
            (!display.is_null()).then_some(Conn { xlib, display })
        });
    }
    CONN.with(|conn| {
        let c = conn.as_ref()?;
        unsafe {
            let root = (c.xlib.XDefaultRootWindow)(c.display);
            let (mut r, mut ch) = (0, 0);
            let (mut rx, mut ry, mut wx, mut wy) = (0, 0, 0, 0);
            let mut mask = 0;
            let ok = (c.xlib.XQueryPointer)(
                c.display, root, &mut r, &mut ch, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask,
            );
            (ok != 0).then_some((rx as f64, ry as f64))
        }
    })
}
