// Popover logic (external file — the CSP forbids inline script). Renders compact
// stats from the Rust `get_stats` command, refreshes on the `stats` event, pulses
// the creature on `pulse` (an ingest delta), and opens the ocean on click.
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
    opening: "opening…",
    lastActivity: "last activity",
    emptyMemory: "memory empty — the creature is dormant",
  },
  pt: {
    observations: "observações",
    sessions: "sessões",
    openOcean: "abrir oceano",
    opening: "abrindo…",
    lastActivity: "última atividade",
    emptyMemory: "memória vazia — a criatura está dormente",
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
  creature: document.getElementById("creature"),
  open: document.getElementById("open"),
};

// Format a raw ISO timestamp into the user's locale (Intl, never hardcoded).
function formatActivity(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // surface the raw value if unparseable
  const locale = lang === "pt" ? "pt-BR" : "en";
  const when = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return `${t("lastActivity")}: ${when}`;
}

function render(stats) {
  if (!stats) return;
  const obs = stats.observations ?? 0;
  els.obs.textContent = String(obs);
  els.sessions.textContent = String(stats.sessions ?? 0);
  // Empty memory → the creature is dormant (translucidez = confiança, DESIGN §11).
  document.body.dataset.empty = obs === 0 ? "true" : "false";
  els.ts.textContent = stats.last_activity ? formatActivity(stats.last_activity) : t("emptyMemory");
}

function pulse() {
  els.creature.classList.remove("pulse");
  // Reflow so the animation restarts even on back-to-back pulses.
  void els.creature.offsetWidth;
  els.creature.classList.add("pulse");
}

els.open.addEventListener("click", () => {
  if (els.open.getAttribute("aria-disabled") === "true") return;
  els.open.setAttribute("aria-disabled", "true");
  els.open.textContent = t("opening");
  invoke("open_ocean")
    .catch((err) => {
      els.ts.textContent = String(err);
    })
    .finally(() => {
      els.open.removeAttribute("aria-disabled");
      els.open.textContent = t("openOcean");
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
