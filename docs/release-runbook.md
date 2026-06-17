# Release Runbook — cutting a versioned release

How to ship a new `agentbrainsystem` version. Two artifacts go out together:

1. **npm CLI** — `agentbrainsystem` (the `abs` command). Published **manually**.
2. **Tray installers** — built by `.github/workflows/release.yml` on a `v*` tag, attached to a
   GitHub Release named `app-vX.Y.Z`.

Distilled from the v1.1.0 release, which hit every trap below. Follow in order.

## 0. Pre-flight (BLOCKING)

- `git status --porcelain` empty, on `main`, in sync with `origin/main` (`git fetch` → `0 0`).
- CI green on `main` HEAD (`gh run list --branch main`).
- No tracked secrets/junk (`git ls-files | grep -E '\.env|\.pem|node_modules/|^dist/'`).
- Pick the bump from commits since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`):
  feat → **minor**, fix-only → **patch**, breaking → **major**.

## 1. Bump ALL version manifests — they must match

> ⚠️ **The #1 trap.** v1.1.0 bumped `package.json` but not `tauri.conf.json`, so `tauri-action`
> rebuilt the installers as the OLD version and **overwrote the previous release's assets**
> instead of creating a new one. Bump BOTH.

- **`package.json`** → `npm version <major|minor|patch> --no-git-tag-version` (updates `package-lock.json` too).
- **`src-tauri/tauri.conf.json`** `"version"` → set to the SAME value by hand. `tauri-action` derives
  the release tag/name from THIS file (`tagName: app-v__VERSION__` in `release.yml`).
- **`src-tauri/Cargo.toml`** stays `0.1.0` — it's the internal crate version, NOT the release version. Leave it.
- Verify the `bin` field is the bare path: `npm pkg get bin` → `{ "abs": "dist/cli/cli.js" }`.
  If it shows `"./dist/cli/cli.js"`, run `npm pkg fix` — npm's publish validation strips the `./`
  form and would ship a package with **no `abs` command**.
- `npm run build` so the local/global `abs` reflects the new version (CLI version derives from `package.json`).

## 2. Commit + push to main

`main` requires PR reviews BUT `enforce_admins: false` → the repo admin (victorbjuliani) pushes the
release commit directly (this is how v1.0.x landed):

```
git add package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "chore(release): vX.Y.Z — <headline>"
git push origin main
```

## 3. Tag → triggers the installer build

```
git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
git push origin vX.Y.Z
```

The `v*` tag triggers `release.yml`: a 3-OS Rust build (macOS arm+intel, Windows, Linux) — **~12-15 min**.
Rust can't build locally (crates.io proxy block), so CI is the only path. `tauri-action` then creates a
GitHub Release `app-vX.Y.Z` **as a DRAFT** with all installers attached.

> If you already tagged before fixing a manifest, re-tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`,
> then re-create + push at the corrected HEAD.

## 4. Publish the GitHub Release (it's a draft)

`tauri-action` leaves the release as a **draft** — it's invisible until published (the README links here):

```
gh release edit app-vX.Y.Z --draft=false --latest --notes "<release notes>"
gh release list   # confirm app-vX.Y.Z is Latest
```

## 5. npm publish — MANUAL, needs a real TTY

> ⚠️ **The #2 trap.** This npm account uses **security-key (WebAuthn) 2FA**, not TOTP. The publish must
> run in a **real interactive terminal** — piped/non-TTY contexts (a CI step, an agent's shell, the
> Claude `!` prefix) get `EOTP` immediately because npm can't open the browser for the key tap.

In a real Terminal:

```
npm whoami                       # 401? → `npm login` first (token expires)
npm publish --ignore-scripts     # --ignore-scripts skips the ~2min prepublishOnly re-run (CI already verified)
```

npm prints an auth URL → open it → **tap the security key** → upload completes.

- **Alternative for unattended/agent publishing:** create an npm **Automation** access token
  (npmjs.com → Access Tokens → Generate → *Automation*) — those bypass 2FA. Put it in `~/.npmrc`
  or `NPM_TOKEN`, then `npm publish` works in any context.
- `--ignore-scripts` is safe ONLY when `npm run check` is already green and `dist/` is freshly built
  at the released commit (both true after steps 1-3).

## 6. Post-release verification

```
npm view agentbrainsystem version      # == X.Y.Z
npm view agentbrainsystem@X.Y.Z bin    # { abs: 'dist/cli/cli.js' }  ← the abs command survived
npm view agentbrainsystem dist-tags    # latest = X.Y.Z
gh release view app-vX.Y.Z --json isLatest
```

## 7. Rollback

- **npm:** can't unpublish after 24h. Repoint latest: `npm dist-tag add agentbrainsystem@<prev> latest`,
  and `npm deprecate agentbrainsystem@X.Y.Z "use <prev>"`.
- **Installers:** `gh release edit app-v<prev> --latest` (re-point), optionally draft the bad release.
- **Code:** `git revert` on main; the next patch release supersedes.

## Known wart (v1.1.0)

The first (mis-versioned) v1.1.0 build overwrote the `app-v1.0.2` release's installer assets with
1.1.0-code binaries still labeled `_1.0.2_`. The originals weren't recoverable. Harmless in practice
(the tray companion barely changed 1.0.2→1.1.0), but it's why step 1 insists on bumping both manifests.

## Deferred after v1.1.0

- **Dependency vulns (1.1.1 fast-follow):** `npm audit --omit=dev` flags `hono` (4.12.21→4.12.25) and
  `protobufjs` (7.6.0→7.6.4), both within-range via `npm audit fix`. Low real-world risk (local CLI,
  localhost-only read-only `abs ui`, no Lambda/untrusted-protobuf), but worth a quick patch release.
