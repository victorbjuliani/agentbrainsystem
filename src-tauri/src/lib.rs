//! agentbrainsystem tray companion (DESIGN §12 form factor A).
//!
//! A glanceable, always-on tray presence: it reads memory counts straight from the
//! SQLite store via `rusqlite` (read-only — the tray must NEVER mutate memory) so it
//! needs no Node runtime to sit in the tray. The heavy immersive "ocean" window is
//! opened on demand by spawning the existing `abs ui` sidecar (Node) and hosting its
//! URL in a Tauri webview — or, if that fails, falling back to the system browser.
//!
//! Battery rule (DESIGN §13): the only ambient work is a slow stats poll (PULL_SECS),
//! not a render loop; the creature pulse is driven by the observation-id delta.

use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// How often the tray refreshes counts. Slow on purpose — glanceable, not live.
const POLL_SECS: u64 = 5;

/// Compact memory stats shown in the popover + tray tooltip.
#[derive(Debug, Clone, Serialize, Default)]
struct Stats {
    observations: i64,
    sessions: i64,
    /// ISO-8601 timestamp of the most recent observation, or null when empty.
    last_activity: Option<String>,
    /// Max observation id — the popover compares successive values to pulse on ingest.
    max_obs_id: i64,
}

/// Process state we must keep alive: the spawned `abs ui` sidecar (dropping the
/// `Child` would orphan it, so we hold it and kill it on exit) and the last seen
/// observation id (to detect ingest deltas for the pulse).
#[derive(Default)]
struct AppState {
    sidecar: Mutex<Option<Child>>,
    last_max_obs_id: Mutex<i64>,
}

/// Resolve the store path with the SAME precedence as `loadConfig` (config.ts):
/// `ABS_DB_PATH` → `$ABS_HOME/memory.db` → `~/.agentbrainsystem/memory.db`.
fn resolve_db_path() -> PathBuf {
    if let Ok(p) = env::var("ABS_DB_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = match env::var("ABS_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => default_data_dir(),
    };
    home.join("memory.db")
}

/// `~/.agentbrainsystem` — the default data dir when neither env var is set.
fn default_data_dir() -> PathBuf {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".agentbrainsystem")
}

/// Read counts read-only. Opens with `SQLITE_OPEN_READ_ONLY` so the tray can never
/// write. We only touch the base tables (`observations`/`sessions`), never the
/// `vec0`/`fts5` virtual tables, so the bundled SQLite needs no extensions.
fn read_stats() -> Result<Stats, String> {
    let path = resolve_db_path();
    if !path.exists() {
        // No store yet — an empty creature, not an error (first-run companion).
        return Ok(Stats::default());
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open {}: {e}", path.display()))?;

    let observations: i64 = conn
        .query_row("SELECT COUNT(*) FROM observations", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let max_obs_id: i64 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) FROM observations", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let last_activity: Option<String> = conn
        .query_row("SELECT MAX(created_at) FROM observations", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(Stats {
        observations,
        sessions,
        last_activity,
        max_obs_id,
    })
}

/// The popover calls this on mount + on the `stats` event to render counts.
#[tauri::command]
fn get_stats() -> Result<Stats, String> {
    read_stats()
}

/// UI language: English by default, Portuguese only when the OS locale is pt-*. The
/// product ships EN-first (international launch); pt-BR users get Portuguese. Best
/// effort via the standard locale env vars — a GUI launch that sets none correctly
/// falls back to EN.
#[derive(Clone, Copy, PartialEq)]
enum Lang {
    En,
    Pt,
}

fn ui_lang() -> Lang {
    // macOS GUI apps rarely inherit LANG, so read the user's preferred language from
    // AppleLanguages (the first entry, e.g. "pt-BR" or "en-US").
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = s.split('"').nth(1) {
                return if first.to_lowercase().starts_with("pt") {
                    Lang::Pt
                } else {
                    Lang::En
                };
            }
        }
    }
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = env::var(key) {
            if v.is_empty() {
                continue;
            }
            return if v.to_lowercase().starts_with("pt") {
                Lang::Pt
            } else {
                Lang::En
            };
        }
    }
    Lang::En
}

/// Expose the resolved UI language to the popover webview so its strings match the
/// tray menu (same source of truth).
#[tauri::command]
fn get_lang() -> &'static str {
    match ui_lang() {
        Lang::En => "en",
        Lang::Pt => "pt",
    }
}

/// Build the command that launches the `abs` sidecar so it works from a GUI app.
/// Two hazards, both invisible from a terminal:
///   1. GUI processes (macOS launchd, etc.) DON'T inherit the shell PATH, so a bare
///      `Command::new("abs")` can't even find `abs`.
///   2. `abs` is a Node CLI with a NATIVE module (better-sqlite3) whose prebuilt
///      binary is ABI-locked to the Node version that installed it. If the PATH
///      resolves a *different* `node` (e.g. an old /usr/local/bin/node), the sidecar
///      dies on load before printing its URL.
/// Fix: honor an explicit `ABS_BIN` override; otherwise locate `abs` on an augmented
/// PATH and PREPEND its own directory, so the co-located `node` (same npm prefix/bin —
/// the one that installed `abs`) wins and the native ABI matches.
fn abs_command() -> Command {
    if let Ok(bin) = env::var("ABS_BIN") {
        if !bin.is_empty() {
            let path = PathBuf::from(&bin);
            let mut cmd = Command::new(&path);
            if let Some(dir) = path.parent() {
                cmd.env("PATH", prepend_dir(dir, &search_path()));
            }
            return cmd;
        }
    }
    let search = search_path();
    if let Some(abs_path) = which_in("abs", &search) {
        let mut cmd = Command::new(&abs_path);
        if let Some(dir) = abs_path.parent() {
            cmd.env("PATH", prepend_dir(dir, &search));
        }
        return cmd;
    }
    // Last resort: let the OS resolve `abs` against the augmented PATH.
    let mut cmd = Command::new("abs");
    cmd.env("PATH", search);
    cmd
}

/// PATH to search for `abs`: the inherited PATH plus the usual npm-global bin dirs, so
/// a GUI launch (with its bare PATH) can still find a user-installed `abs`.
fn search_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut add = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    add(PathBuf::from("/opt/homebrew/bin")); // Homebrew on Apple Silicon
    add(PathBuf::from("/usr/local/bin")); // npm default prefix (Intel mac / Linux)
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        add(home.join(".npm-global/bin")); // `npm config set prefix ~/.npm-global`
        add(home.join(".local/bin"));
    }
    #[cfg(target_os = "windows")]
    if let Some(appdata) = env::var_os("APPDATA").map(PathBuf::from) {
        add(appdata.join("npm")); // npm global on Windows
    }
    env::join_paths(dirs).unwrap_or_default()
}

/// First directory in `path` holding an executable `name`. Follows symlinks (npm
/// installs `abs` as a symlink into prefix/bin), and tries the Windows launcher exts.
fn which_in(name: &str, path: &std::ffi::OsString) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let names = [
        name.to_string(),
        format!("{name}.cmd"),
        format!("{name}.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let names = [name.to_string()];
    for dir in env::split_paths(path) {
        for n in &names {
            let candidate = dir.join(n);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `dir` prepended to `base` (deduped) so the binary co-located with `abs` wins.
fn prepend_dir(dir: &std::path::Path, base: &std::ffi::OsString) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    for d in env::split_paths(base) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    env::join_paths(dirs).unwrap_or_default()
}

/// "Abrir oceano": spawn `abs ui --no-open`, read the URL it prints on stdout, and
/// host it in a dedicated webview window. Falls back to the system browser if the
/// sidecar can't be launched or the window can't be built.
#[tauri::command]
fn open_ocean(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let lang = ui_lang();
    // Already open? Focus it instead of spawning a second server.
    if let Some(win) = app.get_webview_window("ocean") {
        let _ = win.set_focus();
        return Ok(());
    }

    let mut child = abs_command()
        .args(["ui", "--no-open"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match lang {
            Lang::En => format!("couldn't launch `abs ui`: {e}"),
            Lang::Pt => format!("não consegui iniciar `abs ui`: {e}"),
        })?;

    let mut stderr = child.stderr.take();

    // The first stdout line is the URL (cli.ts cmdUi prints it before anything else).
    let url = {
        let stdout = child.stdout.take().ok_or_else(|| match lang {
            Lang::En => "the sidecar produced no stdout".to_string(),
            Lang::Pt => "o sidecar não produziu stdout".to_string(),
        })?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| match lang {
            Lang::En => format!("couldn't read the sidecar URL: {e}"),
            Lang::Pt => format!("não li a URL do sidecar: {e}"),
        })?;
        line.trim().to_string()
    };
    if url.is_empty() {
        // The sidecar died before emitting a URL. Surface its stderr (e.g. a native
        // better-sqlite3 ABI mismatch) so the failure is diagnosable, not just "no URL".
        let _ = child.kill();
        let detail = stderr
            .as_mut()
            .and_then(|s| {
                let mut buf = String::new();
                std::io::Read::read_to_string(s, &mut buf).ok().map(|_| buf)
            })
            .unwrap_or_default();
        let last = detail
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim();
        return Err(match (lang, last.is_empty()) {
            (Lang::En, true) => "the sidecar emitted no URL".to_string(),
            (Lang::Pt, true) => "o sidecar não emitiu uma URL".to_string(),
            (Lang::En, false) => format!("`abs ui` failed to start: {last}"),
            (Lang::Pt, false) => format!("`abs ui` falhou ao iniciar: {last}"),
        });
    }

    // Keep the sidecar alive for the window's lifetime (replacing any prior one).
    if let Ok(mut slot) = state.sidecar.lock() {
        if let Some(mut old) = slot.take() {
            let _ = old.kill();
        }
        *slot = Some(child);
    }

    let parsed = url.parse().map_err(|_| match lang {
        Lang::En => format!("invalid sidecar URL: {url}"),
        Lang::Pt => format!("URL inválida do sidecar: {url}"),
    })?;
    let title = match lang {
        Lang::En => "agentbrainsystem — ocean",
        Lang::Pt => "agentbrainsystem — oceano",
    };
    let built = WebviewWindowBuilder::new(&app, "ocean", WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .build();

    if built.is_err() {
        // Fallback: hand the URL to the OS browser (still the immersive view).
        open_in_browser(&url);
    }
    Ok(())
}

/// Best-effort system-browser open (the documented fallback for the ocean window).
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// Human tray tooltip — counts + last activity, glanceable without opening anything.
fn tooltip_text(s: &Stats) -> String {
    match (ui_lang(), &s.last_activity) {
        (Lang::En, Some(ts)) => format!(
            "agentbrainsystem\n{} observations · {} sessions\nlast activity: {}",
            s.observations, s.sessions, ts
        ),
        (Lang::En, None) => format!(
            "agentbrainsystem\n{} observations · {} sessions",
            s.observations, s.sessions
        ),
        (Lang::Pt, Some(ts)) => format!(
            "agentbrainsystem\n{} observações · {} sessões\núltima atividade: {}",
            s.observations, s.sessions, ts
        ),
        (Lang::Pt, None) => format!(
            "agentbrainsystem\n{} observações · {} sessões",
            s.observations, s.sessions
        ),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_stats, open_ocean, get_lang])
        .setup(|app| {
            // The popover: a small, frameless, always-on-top window hidden until the
            // tray is clicked. Loads the bundled popover (ui/index.html).
            let popover =
                WebviewWindowBuilder::new(app, "popover", WebviewUrl::App("index.html".into()))
                    .title("agentbrainsystem")
                    .inner_size(300.0, 380.0)
                    .resizable(false)
                    .decorations(false)
                    // Transparent so the popover's rounded card shows through instead of
                    // sitting on an opaque window rect (the white corners). Needs
                    // macOSPrivateApi + the macos-private-api feature on macOS.
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .visible(false)
                    .build()?;
            let _ = popover.hide();

            // Dismiss on focus loss (click outside) — the expected menu-bar popover
            // feel, since it's frameless and intentionally can't be moved or minimized.
            let popover_dismiss = popover.clone();
            popover.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = popover_dismiss.hide();
                }
            });

            // Tray menu (right-click / platform menu): open the ocean or quit.
            // Labels follow the UI language (EN default, PT on a pt-* locale).
            let (open_label, quit_label) = match ui_lang() {
                Lang::En => ("Open ocean", "Quit"),
                Lang::Pt => ("Abrir oceano", "Sair"),
            };
            let open_item = MenuItemBuilder::with_id("open", open_label).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open_item, &quit_item])
                .build()?;

            // Tray icon: on macOS a monochrome jellyfish *template* (macOS uses only the
            // alpha channel and recolors it to match the menu bar — feeding it the colored
            // app icon renders as a filled square, the original bug). Windows/Linux keep
            // the colored app icon, since a black silhouette would vanish on their trays.
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::include_image!("icons/tray-template.png");
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().unwrap().clone();

            let tray = TrayIconBuilder::with_id("abs-tray")
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("agentbrainsystem")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        let app = app.clone();
                        let state = app.state::<AppState>();
                        let _ = open_ocean(app.clone(), state);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click toggles the popover, anchored under the tray icon.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("popover") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                // A frameless popover has no native anchor, so without this
                                // it pops at an arbitrary spot. Center it under the click
                                // (the icon), just below the menu bar.
                                if let Ok(size) = win.outer_size() {
                                    let x = position.x as i32 - (size.width as i32) / 2;
                                    let y = position.y as i32 + 8;
                                    let _ = win.set_position(tauri::PhysicalPosition::new(
                                        x.max(8),
                                        y.max(8),
                                    ));
                                }
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Ambient stats poll (battery-friendly: a slow timer, not a render loop).
            // Emits `stats` to the popover and `pulse` when the observation id grows
            // (the agent learned something) — the creature glyph reacts to that.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Ok(stats) = read_stats() {
                    let _ = tray.set_tooltip(Some(tooltip_text(&stats)));
                    let state = handle.state::<AppState>();
                    let grew = {
                        let mut last = state.last_max_obs_id.lock().unwrap();
                        let grew = stats.max_obs_id > *last && *last != 0;
                        *last = stats.max_obs_id;
                        grew
                    };
                    let _ = handle.emit("stats", &stats);
                    if grew {
                        let _ = handle.emit("pulse", ());
                    }
                }
                std::thread::sleep(Duration::from_secs(POLL_SECS));
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the agentbrainsystem companion");
}
