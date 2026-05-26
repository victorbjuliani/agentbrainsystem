/**
 * Best-effort "is a newer version published?" check for `abs doctor`.
 *
 * Ethos guardrails (so this never contradicts the local-first/no-telemetry pitch):
 *   - Runs ONLY from the explicit `abs doctor` command — never the hooks, recall,
 *     or any default/hot path. Nothing here ever runs automatically.
 *   - A single GET to the public npm registry. Sends NO data about the user or
 *     their machine — it only reads the latest published version number.
 *   - Degrades to `null` on offline / timeout / any error, so a diagnostic command
 *     can never hang or fail because of the network.
 */
const REGISTRY_LATEST = 'https://registry.npmjs.org/agentbrainsystem/latest';

export async function fetchLatestVersion(
  opts: { timeoutMs?: number; url?: string } = {},
): Promise<string | null> {
  const { timeoutMs = 1500, url = REGISTRY_LATEST } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when `latest` is a strictly higher x.y.z release than `current`. */
export function isOutdated(current: string, latest: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const c = parts(current);
  const l = parts(latest);
  for (let i = 0; i < 3; i++) {
    const a = c[i] ?? 0;
    const b = l[i] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}
