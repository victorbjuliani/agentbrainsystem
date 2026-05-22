/* agentbrainsystem landing — i18n (client-side, textContent only) + reveal on scroll.
   EN is the source of truth in the HTML (SEO / no-JS friendly) and is captured
   from the DOM at load. PT is a transcreation (not a literal translation):
   professional-neutral voice, technical terms kept in English. No innerHTML. */
(() => {
  "use strict";

  const pt = {
    "skip": "Pular para o conteúdo",
    "nav.features": "Recursos",
    "nav.how": "Como funciona",
    "nav.faq": "FAQ",
    "cta.star": "Star no GitHub",
    "cta.how": "Veja como funciona",
    "cta.get": "Comece agora",

    "hero.eyebrow": "Local-first · $0 · Offline · Open source",
    "hero.h1a": "Seu agente de IA tem amnésia.",
    "hero.h1b": "A cura é um comando.",
    "hero.sub": "Memória persistente para o seu agente de IA. Ele lembra cada sessão — para você parar de reexplicar o mesmo contexto, todo dia. Local, gratuito, privado.",
    "hero.note": "Funciona em macOS, Windows e Linux. Node ≥ 22.",

    "feat.eyebrow": "Por que existe",
    "feat.h": "Pare de ser a memória do seu agente.",
    "feat.lead": "A cada sessão, ele recomeça do zero. O agentbrainsystem lembra — captura cada uma e faz recall do que importa, sem esforço.",
    "feat.1.h": "Recall que funciona de verdade",
    "feat.1.p": "Busca híbrida (semântica + keyword) devolve apenas o que é relevante para a tarefa atual — sem ruído.",
    "feat.1.s": "recall em ~4 ms · p95",
    "feat.2.h": "Configure uma vez. Esqueça para sempre.",
    "feat.2.p": "Captura cada sessão ao terminar e devolve o contexto certo no próximo início. Um comando — depois fica invisível.",
    "feat.2.s": "$0 · sem LLM · hands-free",
    "feat.3.h": "Seu código nunca sai da sua máquina",
    "feat.3.p": "100% local e offline. Sem nuvem, sem conta, sem API key, sem telemetria. O modelo baixa uma vez e roda offline.",
    "feat.3.s": "offline · privado · $0",

    "how.eyebrow": "Como funciona",
    "how.h": "Três passos. Esforço zero.",
    "how.1.h": "Captura",
    "how.1.p": "Hooks ingerem cada sessão do Claude Code automaticamente quando ela termina — $0, sem LLM.",
    "how.2.h": "Armazena",
    "how.2.p": "Indexado localmente na sua máquina, totalmente offline. Nada é enviado pra fora.",
    "how.3.h": "Recall",
    "how.3.p": "Busca híbrida (semântica + keyword) traz a memória relevante — no início da sessão e a cada prompt, conforme você trabalha.",

    "more.eyebrow": "Mais que recall",
    "more.h": "Cuidadoso por design.",
    "more.1": "Recall por projeto",
    "more.2": "Detecta contradições",
    "more.3": "Fatos auto-curativos",
    "more.4": "Sugestões no CLAUDE.md",
    "more.5": "Export & import",
    "more.6": "Lições destiladas",

    "graph.eyebrow": "abs ui",
    "graph.h": "Veja o cérebro do seu agente tomar forma.",
    "graph.p": "Um grafo interativo no navegador: cada sessão é um hub, conectado às memórias que gerou, colorido por tipo. Navegue, inspecione, busque, remova.",

    "faq.eyebrow": "FAQ",
    "faq.h": "As respostas honestas.",
    "faq.1.q": "Ele envia meu código para algum lugar?",
    "faq.1.a": "Não. Tudo roda localmente e offline. Sem chamadas de rede, sem telemetria, sem conta.",
    "faq.2.q": "Tem algum custo?",
    "faq.2.a": "Não — $0 por padrão. Embeddings locais, sem API key. Opcionalmente, conecte qualquer LLM compatível com OpenAI (Ollama local ou hosted) para consolidação mais profunda — opcional e desativado por padrão.",
    "faq.3.q": "Funciona com quais agentes?",
    "faq.3.a": "Feito para o Claude Code via MCP, com captura de sessão e injeção de contexto sem esforço, através de hooks.",
    "faq.4.q": "É open source?",
    "faq.4.a": "Totalmente — no GitHub. Star, fork, leia cada linha.",

    "final.h": "Cure a amnésia do seu agente.",
    "final.tags": "LOCAL-FIRST · $0 · OFFLINE · OPEN SOURCE",

    "footer.issues": "Issues & roadmap",
    "footer.license": "Licença MIT",
    "footer.built": "feito local-first"
  };

  // ---- capture EN from the DOM (single source of truth) ----
  const nodes = [...document.querySelectorAll("[data-i18n]")];
  const en = {};
  for (const el of nodes) en[el.dataset.i18n] = el.textContent;

  function apply(lang) {
    for (const el of nodes) {
      const key = el.dataset.i18n;
      el.textContent = lang === "pt" ? (pt[key] ?? en[key]) : en[key];
    }
    document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.lang === lang))
    );
    try { localStorage.setItem("abs-lang", lang); } catch {}
  }

  // initial language: saved choice → browser language → en
  let initial = null;
  try { initial = localStorage.getItem("abs-lang"); } catch {}
  if (!initial) initial = (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt" : "en";
  apply(initial);

  document.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => apply(b.dataset.lang))
  );

  // ---- reveal on scroll (respect reduced motion) ----
  const reveals = [...document.querySelectorAll(".reveal")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });
    reveals.forEach((el) => io.observe(el));
  }
})();
