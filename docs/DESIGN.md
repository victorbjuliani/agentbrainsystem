# Design Intent — agentbrainsystem

> Documento canônico de identidade visual. Lido por `frontend-design`, `frontend-auditor`, `vercel:shadcn`.
> Atualizar via `design-discovery` em modo REFRESH quando references mudarem.

**Última atualização:** 2026-05-21 (#35: `lesson`/`decision` deixam de ser reservados — pills habilitam quando presentes, nós fixados em view via `mergePinnedConsolidated`, e busca server-side por FTS (`mode:'search'`) os alcança store-wide)
**Modo de captura:** initial + refresh parcial (§4/§11)
**Status do recon:** completo (Obsidian, Observable, Neo4j Bloom — tokens computados extraídos via agent-browser)
**Escopo primário:** issue #11 — UI localhost de grafo interativo (read-only) da memória do agente.

---

## 0. Princípio reitor

**A memória é um organismo vivo, não um banco de dados.** A UI existe para uma coisa: tornar visível a memória de um agente de coding como uma rede que respira, conecta e se ilumina. O grafo é o herói absoluto — todo o resto (painéis, chrome, controles) é instrumentação periférica que nunca compete com ele. Distintivo por intenção: nós luminosos sobre fundo profundo, conexões que pulsam como sinapses, física sempre visível. Nunca um diagrama estático nem um dashboard SaaS com um grafo encaixotado num card.

---

## 1. References

| # | Produto | URL | Por que serve | Sinal extraído (recon) |
|---|---------|-----|----------------|------------------------|
| 1 | Obsidian (graph view) | obsidian.md | Grafo como protagonista; nós luminosos sobre fundo escuro; herança semântica de "rede de conhecimento" | Surfaces dark `#1F1F1F`/`#262626`/`#171717`; **accent violeta `#8B5CF6`**; display 60px tight `-1.2px`; mono presente |
| 2 | Observable | observablehq.com | Ferramenta de exploração de dados com personalidade; mono como elemento de display | **Mono display** (Spline Sans Mono); acentos azul-profundo `#005186` + violeta `#6636B4`; radii apertados (2–4px) |
| 3 | Neo4j Bloom | neo4j.com/product/bloom | Produto canônico de visualização de grafo; canvas escuro, nós tipados por cor | Display **Syne** distinto (`-0.25px`); azuis técnicos `#0070D9`; radii generosos (até 14px) |

**Anti-references (rejeitadas explicitamente):** SaaS genérico/Bootstrap (gradiente roxo de template, shadcn-vanilla sem identidade) · ferramenta acadêmica datada (Graphviz cru, sem polish, grafo morto/estático).

**Screenshots de recon:** sessão `agent-browser` (não persistidos no repo).

---

## 2. Brand Voice

Adjetivos (4):

- [x] **playful** — a memória se move, reage, tem vida
- [x] **organic** — formas e motion biológicos (respirar, pulsar, fluir), não mecânicos
- [x] **técnico** — é instrumento de engenharia; precisão e dados crus visíveis (mono, IDs, timestamps)
- [x] **futurista** — estética de "interface viva", glow, profundidade

**Voice statement:** "Quando alguém abre a UI, em 2 segundos deve sentir que está olhando para um cérebro vivo — uma rede que pulsa e respira — não para um relatório."

---

## 3. Audience

- **Primary:** desenvolvedores rodando Claude Code / agentes de coding que querem explorar o que o agente lembra (o próprio dono da memória).
- **Secondary:** comunidade OSS avaliando a ferramenta (a UI é também a vitrine do projeto no GitHub/landing).
- **Anti-audience:** usuário consumidor final não-técnico; comprador corporativo de dashboard de BI.

---

## 4. Palette

Dark-first (o grafo brilha no escuro) com **light toggle** desde o MVP. Os três accents luminosos **não são decorativos — são a taxonomia do grafo** (ver §11).

### Brand / Primary — Violet (memória, "cérebro")
- `--violet-500`: `#8B5CF6` ← cor de marca dominante (herança Obsidian graph view + semântica de memória)
- Scale: `--violet-300 #C4B5FD` · `--violet-400 #A78BFA` · `--violet-500 #8B5CF6` · `--violet-600 #7C3AED` · `--violet-700 #6D28D9`

### Node accents (semantic — mapeiam tipo de nó ao enum `kind` real do store)

A taxonomia segue o que **existe nos dados hoje**: um nó `session` (hub/container) e nós `observation` coloridos por `kind`. `concept`/`lesson` populados dependem da consolidação LLM (issue #12) — ficam **reservados** até lá (ver nota).

| Token | Mapeia | Hex | Status MVP (#11) |
|---|---|---|---|
| `--accent-session` | `sessions` (hub) | violet `#8B5CF6` | **ativo** |
| `--accent-user` | `observation.kind = user` | cyan `#22D3EE` | **ativo** |
| `--accent-assistant` | `observation.kind = assistant` | lavender `#A78BFA` | **ativo** |
| `--accent-tool` | `observation.kind = tool` | teal `#5EEAD4` | condicional (quando presente) |
| `--accent-lesson` | `observation.kind = lesson` | amber `#FBBF24` | condicional (quando presente; **fixado em view** — #35) |
| `--accent-decision` | `observation.kind = decision` | fuchsia `#f0abfc` | condicional (quando presente; **fixado em view** — #35) |

> **Conjunto ativo do MVP = violet (session) + cyan (user) + lavender (assistant)** — 3 hues quentes/frios que dão leitura por tipo sem legenda obrigatória. `tool` aparece só quando há observações desse tipo. `lesson`/`decision` (o produto durável de `consolidate`) tornaram-se **ativos pós-#35**: a pill habilita quando o store tem nós desses tipos e os nós são **fixados em view** (`mergePinnedConsolidated`, `src/ui/graph.ts`) — antes caíam abaixo do corte de recência/grau e ficavam invisíveis. Edges são neutros de baixa opacidade — nunca competem com nós.

### Neutrals (9-step) — fundo profundo levemente tingido de violeta (não preto puro)

| Token | Hex | Uso típico |
|-------|-----|------------|
| `--neutral-50`  | `#FAFAF9` | Background principal (light mode) |
| `--neutral-100` | `#F3F2F7` | Background secundário, hover (light) |
| `--neutral-200` | `#E6E4ED` | Borders sutis (light) |
| `--neutral-300` | `#CFCBDB` | Borders padrão (light) |
| `--neutral-400` | `#9A95AD` | Texto desabilitado, placeholder |
| `--neutral-500` | `#6E6A82` | Texto secundário |
| `--neutral-600` | `#4A4760` | Texto body (light) |
| `--neutral-700` | `#2A2838` | Painel/card (dark mode) |
| `--neutral-800` | `#1A1825` | Background card/superfície (dark) |
| `--neutral-900` | `#12101B` | Background principal (dark) |
| `--neutral-950` | `#0A0810` | Background do canvas do grafo (dark) — o "vazio profundo" |

### Semantic
- `--success`: `#34D399`
- `--warning`: `#FBBF24` (compartilha com lesson — ok)
- `--error`: `#F87171`
- `--info`: `#22D3EE` (compartilha com concept — ok)

### Contrast notes
- Texto body sobre background ≥ 7:1 (AAA): `--neutral-50` sobre `--neutral-950` no dark; `--neutral-700` sobre `--neutral-50` no light.
- Accents de nó sobre canvas `--neutral-950` ≥ 4.5:1 (AA) — os três hues escolhidos passam.

---

## 5. Typography

### Stack
- **Display** (títulos, marca, números de destaque): **Space Grotesk** — pesos 500/700. Geométrica com caráter, dev-tool, anti-corporativa. Distintiva sem ser acadêmica.
- **Body** (UI, texto corrente): **Inter** — pesos 400/500/600. Workhorse neutro, ótima em tamanhos densos de UI.
- **Mono** (labels de nó, IDs, timestamps, scores, dados): **JetBrains Mono** — peso 400/500. A camada técnica/crua do grafo vive em mono.

> Fonts via `@fontsource` ou self-host (local-first / offline — sem depender de Google Fonts CDN em runtime). Fallback explícito da brand em cada `font-family`.

### Scale (modular ratio: 1.25)
| Token | Size | Line-height | Uso |
|-------|------|-------------|-----|
| `text-xs`   | 12px | 16px | Mono labels de nó, captions |
| `text-sm`   | 14px | 20px | UI text denso, painel lateral |
| `text-base` | 16px | 24px | Body padrão |
| `text-lg`   | 18px | 28px | Body large |
| `text-xl`   | 20px | 28px | Subheading |
| `text-2xl`  | 24px | 32px | H3 |
| `text-3xl`  | 30px | 36px | H2 |
| `text-4xl`  | 36px | 40px | H1 |
| `text-5xl`  | 48px | 56px | Display hero (header da app) |

### Tracking
- Display: `-0.02em` (tighter)
- Mono labels: `0` (sem tracking — preserva leitura técnica)
- Caption: `0.01em`

---

## 6. Density

**Escolhido:** `regular` com canvas airy.

Modelo de duas zonas:
- **Canvas do grafo:** airy / full-bleed — o grafo ocupa a tela inteira; controles flutuam como overlays mínimos.
- **Painéis laterais / inspector:** compact — densidade alta (Linear-like) para detalhe de nó, listas de sessões, filtros.

| | Valor |
|---|---|
| Container padding (painel) | 16px |
| Card / inspector padding | 12–16px |
| Form field / control height | 36px |
| Gap entre seções de painel | 16–24px |
| Canvas | sem padding — full bleed |

---

## 7. Spacing Scale

Base 4. Sem valores adhoc fora do scale.

```
0 → 0     1 → 4px    2 → 8px    3 → 12px   4 → 16px
6 → 24px  8 → 32px   10 → 40px  12 → 48px  16 → 64px  20 → 80px
```

---

## 8. Component Identity

### Border radius (levemente orgânico — mais redondo que corporativo, sem ser bolha)
- Base: `10px` (cards, painéis, botões)
- Small: `6px` (chips, badges, inputs compactos)
- Large: `16px` (modais, popovers, inspector)
- Full: `9999px` (nós do grafo são círculos; pills de filtro/tipo)

### Elevação — **glow no dark, shadow no light**

No dark a elevação é **luz emitida**, não sombra (sombra não lê sobre `#0A0810`). Esta é a assinatura visual.

```css
/* DARK — glow como elevação (cor herda do contexto: violet/cyan/amber) */
--glow-sm:     0 0 12px -2px var(--glow-color, rgba(139,92,246,0.35));
--glow-md:     0 0 24px -2px var(--glow-color, rgba(139,92,246,0.45));
--glow-lg:     0 0 48px -4px var(--glow-color, rgba(139,92,246,0.55));
--glow-node:   0 0 16px var(--node-color);          /* halo do nó */
--glow-active: 0 0 32px var(--node-color);           /* nó focado/selecionado */

/* LIGHT — sombras difusas suaves */
--shadow-sm:  0 1px 2px 0 rgba(20,16,27,0.06);
--shadow-md:  0 4px 12px -2px rgba(20,16,27,0.10);
--shadow-lg:  0 12px 32px -6px rgba(20,16,27,0.14);
```

### Focus ring
```css
outline: 2px solid var(--violet-500);
outline-offset: 2px;
```
Nunca `outline: none` sem reposição visível (a11y — UI pública OSS).

### Borders
- Dark: `1px solid rgba(255,255,255,0.08)` (hairline luminoso)
- Light: `1px solid var(--neutral-200)`

---

## 9. Motion

Motion é onde o "organismo" vive. O grafo **nunca está completamente parado**.

### Easing curves
- **Primary** (90% da UI): `cubic-bezier(0.16, 1, 0.3, 1)` — out-expo, sensação fluida
- **Spring** (pop de nó, seleção): `cubic-bezier(0.34, 1.56, 0.64, 1)` — leve overshoot orgânico
- **Linear** (só progress / física contínua)

### Durations
- **Micro** (hover, focus): `150ms`
- **Regular** (abrir inspector, filtro): `250ms`
- **Page** (transição principal, fit-to-view): `400ms`
- **Ambient** (respiração de nó, drift): `2000–4000ms` em loop

### Comportamentos-assinatura do grafo
1. **Física sempre viva:** force-directed com drift contínuo sutil — nós nunca congelam totalmente quando idle.
2. **Respiração:** nós ociosos pulsam em escala/opacidade muito leve (loop ambient ~3s), dessincronizados entre si (orgânico, não metrônomo).
3. **Sinapse no hover:** ao passar/selecionar um nó, as edges conectadas acendem com um pulso fluindo (sinal viajando), e nós vizinhos ganham glow; o resto do grafo esmaece (dim ~40%).
4. **Spring na chegada:** novos nós entram com spring scale (0 → 1) + fade do glow.
5. **Fit-to-view** com easing primary, 400ms.

### Princípios
- Sempre `duration` + `easing` explícitos — proibido `transition: all`.
- Animar `transform`/`opacity`/`filter`, nunca layout properties.
- `prefers-reduced-motion: reduce` → desliga respiração/drift/pulso ambient; mantém só transições funcionais essenciais (≤150ms).

---

## 10. Anti-patterns (proibidos)

- [ ] Grafo estático/morto sem física nem motion ambient → viola o princípio reitor (§0)
- [ ] Grafo encaixotado dentro de um `card` com chrome de dashboard → o grafo é full-bleed
- [ ] Gradiente violeta de hero genérico tipo template SaaS / Bootstrap
- [ ] `box-shadow` de sombra no dark mode → no dark, elevação é **glow** (§8)
- [ ] Edges saturadas/coloridas competindo com os nós → edges são neutros de baixa opacidade
- [ ] Cores fora da palette (hex literais inline) ou um 4º hue de nó sem mapear taxonomia
- [ ] `padding`/`gap` adhoc fora do spacing scale (§7)
- [ ] `transition: all 0.3s ease` genérico — sempre properties + easing custom
- [ ] Fontes de sistema sem a stack da brand; carregar fonts de CDN em runtime (quebra offline-first)
- [ ] Visual de Graphviz cru / científico datado (nós cinza, edges retas pretas, zero polish)

---

## 11. Graph Visual Language (núcleo da #11)

Spec específica do grafo — o que `frontend-design` constrói e `frontend-auditor` audita como drift.

### Taxonomia nó → cor → forma (alinhada ao enum `kind` real — ver §4)
| Tipo de nó | Origem | Cor | Tamanho relativo | Forma | Status MVP |
|---|---|---|---|---|---|
| **Session** | `sessions` row (hub) | violet `#8B5CF6` | médio→grande (grau = nº de obs) | círculo, halo glow | ativo |
| **User** | `observation.kind=user` | cyan `#22D3EE` | pequeno→médio | círculo | ativo |
| **Assistant** | `observation.kind=assistant` | lavender `#A78BFA` | pequeno→médio | círculo | ativo |
| **Tool** | `observation.kind=tool` | teal `#5EEAD4` | pequeno | círculo | condicional |
| **Lesson** | `observation.kind=lesson` | amber `#FBBF24` | médio→grande (insight = peso) | círculo, glow mais intenso | ativo (fixado em view — #35) |
| **Decision** | `observation.kind=decision` | fuchsia `#f0abfc` | médio→grande | círculo, glow mais intenso | ativo (fixado em view — #35) |

- **Tamanho do nó** = função do grau (nº de conexões) e/ou recência. Sessions incham com o nº de observações que contêm. Escala suave, sem outliers gigantes.
- **Label:** mono (`JetBrains Mono`, `text-xs`), aparece em hover/zoom-in; some em zoom-out para reduzir ruído.
- **Nós consolidados** (`lesson`/`decision`, produto de `consolidate` #12) são **fixados em view** desde #35: prepended à amostra do escopo (`mergePinnedConsolidated`) para nunca caírem abaixo do corte de recência/grau. A busca (`mode:'search'`) os alcança store-wide via FTS, fora da janela de recência.

### Edges
- Cor: neutro luminoso de baixa opacidade — dark `rgba(196,181,253,0.15)` (violet bem apagado), light `rgba(74,71,96,0.18)`.
- Espessura por força de relação (similaridade), sutil.
- No hover de nó: edges conectadas acendem para `opacity 0.7` + pulso fluindo.

### Canvas
- Fundo: `--neutral-950` `#0A0810` (dark) — o "vazio profundo"; `--neutral-50` (light).
- Sem grid visível; opcional vinheta radial muito sutil escurecendo as bordas para focar o centro (só dark).
- Full-bleed; zoom/pan livres.

### Overlays / chrome (mínimos, flutuantes)
- **Inspector de nó** (ao selecionar): painel lateral compact, surface `--neutral-800` (dark) com hairline luminoso e `--glow-md`. Mostra metadados crus em mono.
- **Filtros por tipo:** pills (full radius) coloridas pela taxonomia, canto superior; toggle on/off de tipos.
- **Search/recall:** input mono que destaca (glow + spring) os nós correspondentes e esmaece o resto.
- **Theme toggle** dark/light.
- Controles flutuam sobre o canvas com leve `backdrop-blur` — nunca uma top-bar opaca que come o canvas.

### Read-only (escopo MVP)
Sem edição de memória pela UI, sem auth, sem hosting (out of scope do #11). Interação = explorar: hover, select, zoom/pan, filtrar, buscar.
