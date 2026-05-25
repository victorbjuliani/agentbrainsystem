// Popover logic (external file — the CSP forbids inline script). Renders compact
// stats from the Rust `get_stats` command, refreshes on the `stats` event, pulses
// the glyph on `pulse` (an ingest delta), and opens the ocean on click.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// i18n: English by default, Portuguese on a pt-* locale. The language is resolved by
// the tray (the `get_lang` command — same source of truth as the menu), with the
// webview locale as a fallback so the first paint isn't blank.
const STRINGS = {
  en: {
    observations: "observations",
    sessions: "sessions",
    openOcean: "open ocean",
    lastActivity: "last activity",
    emptyMemory: "memory empty",
  },
  pt: {
    observations: "observações",
    sessions: "sessões",
    openOcean: "abrir oceano",
    lastActivity: "última atividade",
    emptyMemory: "memória vazia",
  },
};
let lang = (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt" : "en";
const t = (key) => (STRINGS[lang] || STRINGS.en)[key];

function applyStaticStrings() {
  document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
}

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
    ? `${t("lastActivity")}: ${stats.last_activity}`
    : t("emptyMemory");
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

// Resolve the language from the tray (matches the menu), then paint strings + stats.
invoke("get_lang")
  .then((l) => {
    if (l === "pt" || l === "en") lang = l;
  })
  .catch(() => {})
  .finally(() => {
    applyStaticStrings();
    invoke("get_stats").then(render).catch(() => {});
  });

listen("stats", (event) => render(event.payload));
listen("pulse", () => pulse());
