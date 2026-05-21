/**
 * E2E (Playwright) — the localhost graph UI against the BUILT binary. Covers:
 *   I  happy path: graph renders, controls present, /api/graph serves nodes, and the
 *      DOM-driven "excluir busca" delete (search → preview → confirm) actually deletes
 *   J  negative: the write-path security gates (CSRF/Origin → 403, method → 405,
 *      bad handle → 409)
 *
 * The force-graph canvas paint is audited visually via frontend-auditor, not here —
 * Playwright asserts DOM, controls, network, and the delete write-path. The delete
 * flow uses the deterministic "excluir busca" buttons (not a physics-positioned node
 * click), waiting out the 250ms search debounce before acting (the button no-ops
 * until the debounced search populates `lastSearch`).
 */
import { type Browser, chromium, expect, test } from '@playwright/test';
import type { UiHandle } from './harness.js';
import { abs, type E2EHome, FIXTURES_PROJECTS, makeHome, parseJson, startUi } from './harness.js';

interface StatusResult {
  counts: { observations: number };
}
const obsCount = async (env: NodeJS.ProcessEnv): Promise<number> =>
  parseJson<StatusResult>((await abs(['status'], { env })).stdout).counts.observations;

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch();
});
test.afterAll(async () => {
  await browser.close();
});

let h: E2EHome;
let ui: UiHandle | undefined;
test.beforeEach(async () => {
  h = makeHome();
  await abs(['ingest', '--dir', FIXTURES_PROJECTS], { env: h.env });
  ui = await startUi(h.env);
});
test.afterEach(() => {
  ui?.stop();
  ui = undefined;
  h.cleanup();
});

test('I — graph renders, serves /api/graph, and "excluir busca" deletes the matched set', async () => {
  const base = (ui as UiHandle).baseUrl;
  const page = await browser.newPage();
  try {
    await page.goto(base);

    // Chrome present: the canvas hero + search control + at least one filter pill.
    await expect(page.locator('#graph canvas')).toBeVisible();
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('.pill').first()).toBeVisible();

    // /api/graph serves a populated graph (read-only, no CSRF needed).
    const graph = await page.request.get(`${base}/api/graph`);
    expect(graph.ok()).toBeTruthy();
    const data = (await graph.json()) as { nodes: unknown[] };
    expect(data.nodes.length).toBeGreaterThan(0);

    const before = await obsCount(h.env);
    expect(before).toBeGreaterThan(0);

    // Search → wait out the debounce + the search-driven /api/graph refresh BEFORE
    // clicking delete (the button no-ops until `lastSearch` is set by onSearch).
    await page.fill('#search', 'staging');
    await page.waitForResponse(
      (r) => r.url().includes('/api/graph') && r.url().includes('search') && r.ok(),
    );

    // "excluir busca" → confirm dialog → confirm the irreversible delete.
    await page.click('.search-delete');
    const dialog = page.locator('.delete-backdrop[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('.delete-confirm')).toBeVisible();
    await page.click('.delete-confirm');

    // The graph reloads after a successful delete; the store shrank.
    await expect(dialog).toBeHidden();
    await expect.poll(() => obsCount(h.env)).toBeLessThan(before);
  } finally {
    await page.close();
  }
});

test('J — write-path security gates reject forged delete requests', async () => {
  const base = (ui as UiHandle).baseUrl;
  const page = await browser.newPage();
  try {
    // Read the per-process CSRF token the server templated into `/`.
    await page.goto(base);
    const csrf = await page.locator('meta[name="abs-csrf"]').getAttribute('content');
    expect(csrf).toBeTruthy();

    const api = page.request;

    // No CSRF header → 403.
    const noCsrf = await api.post(`${base}/api/delete/preview?sel=search&q=staging`);
    expect(noCsrf.status()).toBe(403);

    // Cross-origin (even with a valid token) → 403 (Origin gate fires before CSRF).
    const crossOrigin = await api.post(`${base}/api/delete/preview?sel=search&q=staging`, {
      headers: { 'X-ABS-CSRF': csrf as string, Origin: 'http://evil.example' },
    });
    expect(crossOrigin.status()).toBe(403);

    // Wrong method on the execute route → 405.
    const wrongMethod = await api.get(`${base}/api/delete?handle=whatever`);
    expect(wrongMethod.status()).toBe(405);

    // Valid CSRF + same origin but a bogus handle → 409 unknown-handle.
    const badHandle = await api.delete(`${base}/api/delete?handle=not-a-real-handle`, {
      headers: { 'X-ABS-CSRF': csrf as string },
    });
    expect(badHandle.status()).toBe(409);
    const body = (await badHandle.json()) as { reason?: string };
    expect(body.reason).toBe('unknown-handle');
  } finally {
    await page.close();
  }
});
