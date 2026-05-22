# agentbrainsystem — landing page

This branch (`gh-pages`) **is** the live marketing site, served by GitHub Pages at
**https://victorbjuliani.github.io/agentbrainsystem/**.

It is a **static site — no build step.** The files here are the source *and* the deploy.
Edit them directly and push to update; GitHub Pages rebuilds in ~30–60s.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page. English content is inline (source of truth for SEO / no-JS). |
| `styles.css` | Design tokens mirror `docs/DESIGN.md` on `main` (violet `#8B5CF6`, deep `#0A0810`, glow as elevation). |
| `app.js` | Client-side i18n (EN ⇄ PT-BR via `navigator.language` + toggle, `textContent` only — no `innerHTML`) and scroll reveal. |
| `assets/` | Creature `.webp`, favicon set, `og-image.png` (1200×630), self-hosted fonts (Space Grotesk / Inter / JetBrains Mono). |
| `robots.txt`, `sitemap.xml`, `.nojekyll` | SEO + Pages config. |

## Preview locally

```bash
python3 -m http.server 7799   # then open http://localhost:7799
```

## i18n

English lives inline in `index.html`; `app.js` holds the **PT-BR transcreation** (not a literal
translation). To add a string: add a `data-i18n="key"` element in `index.html` (English text) and the
matching `key` in the `pt` dictionary in `app.js`.

## Notes

- **Analytics:** GoatCounter (privacy-first, no cookies) — `agentbrainsystem.goatcounter.com`.
- **SEO:** title/meta/canonical, Open Graph + Twitter cards, JSON-LD (`SoftwareApplication`), robots, sitemap.
- **Brand:** bioluminescent jellyfish mascot; palette and tokens follow `docs/DESIGN.md` on `main`.
- During development the working copy lived in `.worktrees/site/` on `main` (gitignored); this branch is the canonical copy.

MIT © 2026 Victor B. Juliani
