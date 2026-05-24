// Popover logic (external file — the CSP forbids inline script). Renders compact
// stats from the Rust `get_stats` command, refreshes on the `stats` event, pulses
// the glyph on `pulse` (an ingest delta), and opens the ocean on click.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const els = {
  obs: document.getElementById("obs"),
  sessions: document.getElementById("sessions"),
  ts: document.getElementById("ts"),
  glyph: document.getElementById("glyph"),
  open: document.getElementById("open"),
};

function render(stats) {
  if (!stats) return;
  els.obs.textContent = String(stats.observations ?? 0);
  els.sessions.textContent = String(stats.sessions ?? 0);
  els.ts.textContent = stats.last_activity
    ? `última atividade: ${stats.last_activity}`
    : "memória vazia";
}

function pulse() {
  els.glyph.classList.remove("pulse");
  // Reflow so the animation restarts even on back-to-back pulses.
  void els.glyph.offsetWidth;
  els.glyph.classList.add("pulse");
}

els.open.addEventListener("click", () => {
  invoke("open_ocean").catch((err) => {
    els.ts.textContent = String(err);
  });
});

invoke("get_stats").then(render).catch(() => {});
listen("stats", (event) => render(event.payload));
listen("pulse", () => pulse());
