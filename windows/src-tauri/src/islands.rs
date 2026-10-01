// One island per display, on Linux.
//
// With the "Every display" screen preference each monitor gets its own island
// window: `island` on the primary display, `island-1`, `island-2`… on the
// others. They all receive the same hook and integration events, so the same
// sessions show everywhere; whichever one is clicked answers. The primary
// island is the only one that plays sounds and talks to the relay about
// whether a card is on screen (see `approval_ack`), so nothing happens twice.
//
// Displays are matched by their physical origin, and the set of islands is
// brought back in line whenever the layout changes: a display plugged in, one
// unplugged, a bar restarted.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::island::{self, PollGate, STRIP_H, STRIP_W, WINDOW_LABEL};

/// Every island window's poll gate, by window label.
#[derive(Default)]
pub struct Islands(pub Mutex<HashMap<String, Arc<PollGate>>>);

/// The gate of island `label`.
pub fn gate(app: &AppHandle, label: &str) -> Option<Arc<PollGate>> {
    app.state::<Islands>().0.lock().unwrap().get(label).cloned()
}

/// Same page as the primary island: the dev server in a dev build, the bundle
/// otherwise.
fn island_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/index.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("index.html".into())
}

/// Brings the islands in line with the displays, on the main thread.
pub fn request_sync(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || sync(&handle));
}

/// Watches GDK for displays coming and going, so a new display gets its island
/// even while every island is hidden and no poll is running.
pub fn watch_displays(app: &AppHandle) {
    let Some(display) = gtk::gdk::Display::default() else { return };
    let added = app.clone();
    display.connect_monitor_added(move |_, _| later(&added));
    let removed = app.clone();
    display.connect_monitor_removed(move |_, _| later(&removed));
}

/// Tauri's monitor list catches up with GDK's a moment after the signal.
fn later(app: &AppHandle) {
    let app = app.clone();
    gtk::glib::timeout_add_local_once(Duration::from_millis(800), move || sync(&app));
}

/// Main thread only.
pub fn sync(app: &AppHandle) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let pref = shared.settings.lock().unwrap().screen.clone();
    let monitors = app.available_monitors().unwrap_or_default();
    let origin = |m: &tauri::Monitor| (m.position().x, m.position().y);

    // Which island goes where. `None` lets the primary island follow the
    // "primary" / "cursor" preference exactly as before.
    let mut desired: Vec<(String, Option<(i32, i32)>)> = Vec::new();
    if pref == "all" && !monitors.is_empty() {
        let primary = app
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| monitors.first().cloned())
            .map(|m| origin(&m));
        desired.push((WINDOW_LABEL.to_string(), primary));
        let mut n = 1;
        for m in &monitors {
            if Some(origin(m)) == primary {
                continue;
            }
            desired.push((format!("island-{n}"), Some(origin(m))));
            n += 1;
        }
    } else {
        desired.push((WINDOW_LABEL.to_string(), None));
    }

    let islands = app.state::<Islands>();

    // Islands whose display is gone.
    for (label, win) in app.webview_windows() {
        if label == WINDOW_LABEL || !island::is_island(&label) {
            continue;
        }
        if desired.iter().any(|(l, _)| *l == label) {
            continue;
        }
        // A display unplugged with its island open must not keep the bar hidden.
        crate::linux::island_open(&label, false);
        if let Some(gate) = islands.0.lock().unwrap().remove(&label) {
            gate.closed.store(true, Ordering::Relaxed);
            gate.set_active(true);
        }
        let _ = win.destroy();
    }

    for (label, monitor) in desired {
        let gate = islands
            .0
            .lock()
            .unwrap()
            .entry(label.clone())
            .or_insert_with(|| Arc::new(PollGate::new()))
            .clone();
        *gate.monitor.lock().unwrap() = monitor;

        let created = app.get_webview_window(&label).is_none() && create(app, &label);
        if created {
            // Starts full size, like the primary island, for the greeting.
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(app.clone(), label.clone(), gate.clone());
        }
        let collapsed = gate.collapsed.load(Ordering::Relaxed);
        island::place(app, &label, &gate, &pref, collapsed);
        island::apply_input_region(app, &label, &gate);
        if created {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.show();
            }
        }
    }
    // The pages re-read their bar and display.
    island::emit_islands(app, "screen-changed", ());
    // A new island learns at once whether the bar is away.
    crate::linux::refresh_suppression();
}

/// A second island window, identical to the one in tauri.linux.conf.json.
fn create(app: &AppHandle, label: &str) -> bool {
    let built = WebviewWindowBuilder::new(app, label, island_page_url(app))
        .title("Coucou")
        .inner_size(STRIP_W, STRIP_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .build();
    match built {
        Ok(win) => {
            island::make_non_activating(&win);
            crate::log::line(format!("{label} created"));
            true
        }
        Err(err) => {
            crate::log::line(format!("{label} failed: {err}"));
            false
        }
    }
}
