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

/// Build the command that launches the `abs` sidecar so it resolves from a GUI app
/// too. macOS/Linux GUI processes (launchd, etc.) DON'T inherit the shell PATH, so a
/// bare `Command::new("abs")` fails even when `abs` works fine in a terminal. We honor
/// an explicit `ABS_BIN` override (an absolute path to the binary) and otherwise
/// augment PATH with the common npm-global bin locations so the spawn can find it.
fn abs_command() -> Command {
    if let Ok(bin) = env::var("ABS_BIN") {
        if !bin.is_empty() {
            return Command::new(bin);
        }
    }
    let mut cmd = Command::new("abs");
    cmd.env("PATH", augmented_path());
    cmd
}

/// The current PATH plus the usual npm-global bin dirs, appended so an existing PATH
/// still wins. Cross-platform via `env::join_paths`; covers the Homebrew prefixes, the
/// default npm prefix, and a user-set `~/.npm-global`/`~/.local` prefix.
fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut add = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    add(PathBuf::from("/usr/local/bin")); // npm default prefix (Intel mac / Linux)
    add(PathBuf::from("/opt/homebrew/bin")); // Homebrew on Apple Silicon
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

/// "Abrir oceano": spawn `abs ui --no-open`, read the URL it prints on stdout, and
/// host it in a dedicated webview window. Falls back to the system browser if the
/// sidecar can't be launched or the window can't be built.
#[tauri::command]
fn open_ocean(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    // Already open? Focus it instead of spawning a second server.
    if let Some(win) = app.get_webview_window("ocean") {
        let _ = win.set_focus();
        return Ok(());
    }

    let mut child = abs_command()
        .args(["ui", "--no-open"])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("não consegui iniciar `abs ui`: {e}"))?;

    // The first stdout line is the URL (cli.ts cmdUi: `out(url)` before anything else).
    let url = {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar sem stdout".to_string())?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("não li a URL do sidecar: {e}"))?;
        line.trim().to_string()
    };
    if url.is_empty() {
        let _ = child.kill();
        return Err("sidecar não emitiu uma URL".to_string());
    }

    // Keep the sidecar alive for the window's lifetime (replacing any prior one).
    if let Ok(mut slot) = state.sidecar.lock() {
        if let Some(mut old) = slot.take() {
            let _ = old.kill();
        }
        *slot = Some(child);
    }

    let parsed = url
        .parse()
        .map_err(|_| format!("URL inválida do sidecar: {url}"))?;
    let built = WebviewWindowBuilder::new(&app, "ocean", WebviewUrl::External(parsed))
        .title("agentbrainsystem — oceano")
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
    match &s.last_activity {
        Some(ts) => format!(
            "agentbrainsystem\n{} observações · {} sessões\núltima atividade: {}",
            s.observations, s.sessions, ts
        ),
        None => format!(
            "agentbrainsystem\n{} observações · {} sessões",
            s.observations, s.sessions
        ),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_stats, open_ocean])
        .setup(|app| {
            // The popover: a small, frameless, always-on-top window hidden until the
            // tray is clicked. Loads the bundled popover (ui/index.html).
            let popover =
                WebviewWindowBuilder::new(app, "popover", WebviewUrl::App("index.html".into()))
                    .title("agentbrainsystem")
                    .inner_size(300.0, 380.0)
                    .resizable(false)
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .visible(false)
                    .build()?;
            let _ = popover.hide();

            // Tray menu (right-click / platform menu): open the ocean or quit.
            let open_item = MenuItemBuilder::with_id("open", "Abrir oceano").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Sair").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open_item, &quit_item])
                .build()?;

            let tray = TrayIconBuilder::with_id("abs-tray")
                .icon(app.default_window_icon().unwrap().clone())
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
                    // Left click toggles the popover near the cursor.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("popover") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
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
