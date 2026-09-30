<div align="center">

<img src="../windows/src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Arch Linux

**No notch on a Linux desktop either — Mochi lives at the top of your screen.**

![Arch Linux](https://img.shields.io/badge/Arch_Linux-1793D1?logo=archlinux&logoColor=white)
![Wayland](https://img.shields.io/badge/Wayland-layer--shell-FFBC00?logo=wayland&logoColor=black)
![X11](https://img.shields.io/badge/X11-supported-555)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)

</div>

This is the same app as [Coucou for Windows](../windows/README.md) — same code,
same island, same Mochi, same sounds, same settings. The Tauri app in `windows/`
builds on both systems; this folder only holds the Arch packaging.

## Install

```bash
git clone https://github.com/FabioLukas123/coucou.git
cd coucou/linux
makepkg -si
```

Then launch **Coucou** from your app launcher, or run `coucou`.

Dependencies pulled in by the package: `webkit2gtk-4.1`, `gtk3`,
`gtk-layer-shell`, `libayatana-appindicator`, `gst-plugins-base`,
`gst-plugins-good` (the WAV decoder for Mochi's sounds) and `xdg-utils`.
API keys go to the **Secret Service**, so you also need a provider running —
GNOME Keyring, KWallet or KeePassXC.

## Where Mochi lives

| Desktop | How the island is drawn |
|---|---|
| Hyprland, Sway, KDE Plasma (Wayland), niri, Wayfire… | a `wlr-layer-shell` overlay anchored to the top edge |
| GNOME (Wayland) | an X11 window through XWayland — Mutter has no layer shell |
| Any X11 session | a borderless, always-on-top X11 window |

`COUCOU_BACKEND=x11 coucou` forces the X11 path, `COUCOU_BACKEND=wayland`
forces the Wayland one.

The island only takes the mouse over its own shape: everything around it
clicks through to the window below, exactly like on the Mac and on Windows.

Mochi's eyes follow the cursor across the whole screen on Hyprland (through its
IPC socket) and on X11. Wayland doesn't let apps read the cursor anywhere else,
so on other compositors Mochi only watches the cursor while it's over the island.

## Claude Code

**Settings… → Claude Code → Install hooks…** works exactly as on Windows: you see
the diff of `~/.claude/settings.json` and the dated backup path, and nothing is
written until you click.

The relay is `~/.local/share/coucou/bin/coucou-hook`, copied there at launch. It
talks to the app over a Unix socket at `$XDG_RUNTIME_DIR/coucou.sock` (mode
0600, and both sides check the other runs as the same user). If Coucou is closed
the hook exits in a couple of milliseconds — **Claude Code is never blocked.**

## Files

| What | Where |
|---|---|
| Preferences | `~/.config/coucou/settings.json` |
| Log | `~/.local/share/coucou/coucou.log` |
| Dropped files | `~/.local/share/coucou/inbox/` |
| API keys | Secret Service, service `fr.louisraille.coucou` |
| Autostart | `~/.config/autostart/Coucou.desktop` (Settings → Launch at login) |

## Build without packaging

You need `rust`, `nodejs`, `npm` and the dependencies above.

```bash
cd windows
npm install
npm run tauri dev                  # live-reloading development build
npx tauri build --no-bundle        # target/release/coucou + coucou-hook
npx tauri build --bundles deb rpm appimage   # other distributions
```

## Differences from the Windows version

- The tray menu is the same (Open, Settings…, Pause, Quit); on most Linux trays
  it opens on click.
- "Open terminal" opens the folder in VS Code (`code`, `code-oss` or `codium`),
  otherwise in your file manager.
- While dragging a file, only the island itself is a drop target — Windows makes
  the whole panel one.
