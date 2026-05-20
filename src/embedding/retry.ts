/**
 * A thin, dependency-free retry wrapper around `fetch` for hosted embedding
 * providers.
 *
 * Why this exists: a single transient 429/503 during a bulk ingest used to abort
 * the entire run (the failure mode that produced 158 embed failures in the prior
 * agentmemory stack). A small retry loop turns those transient blips into a brief
 * pause-and-retry instead of a hard failure.
 *
 * Design choices:
 *
 * - **Only 429, 503, and network throws are retryable.** A 429 ("too many
 *   requests") and 503 ("service unavailable") are the canonical transient
 *   signals; a thrown `fetch` means the request never reached the server (DNS,
 *   connection reset, timeout) and is safe to retry on an idempotent POST.
 *   Everything else — 400/401/403/404/422/5xx-other — is returned unchanged so
 *   the caller's existing `if (!res.ok) throw` produces the same error it always
 *   has. Retrying a 400/401 just wastes time; the input/credentials won't change.
 *
 * - **Full jitter** (`delay = random() * computedBackoff`). Equal jitter and
 *   "no jitter" both leave many clients waking at the same instant after a shared
 *   outage, re-stampeding the service. Full jitter spreads retries across the
 *   whole `[0, computedBackoff]` window, which AWS's well-known backoff study
 *   found minimizes contention. The base backoff itself is the standard
 *   exponential `baseDelayMs * 2^(attempt-1)`, clamped to `maxDelayMs`.
 *
 * - **Retry-After is respected** when the server sends it on a 429/503: servers
 *   know better than our heuristic when they'll be ready. We parse either the
 *   integer delta-seconds form or the HTTP-date form, and clamp the result to
 *   `maxDelayMs` so a hostile/misconfigured header can't park us for minutes.
 *
 * - **Exhaustion returns the last retryable response** rather than throwing, so
 *   the providers' own error messages ("voyage embeddings request failed: 503 …")
 *   stay byte-for-byte identical to today. A persistent *network* failure has no
 *   response to return, so that case rethrows the last error.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 4 = 1 initial + 3 retries). */
  maxAttempts?: number;
  /** Base backoff in ms for the exponential schedule (default 250). */
  baseDelayMs?: number;
  /** Upper bound on any single delay, incl. Retry-After (default 8000). */
  maxDelayMs?: number;
  /** Injectable sleep; defaults to a real setTimeout-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1); defaults to Math.random. Used for full jitter. */
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP statuses we treat as transient and worth retrying. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Parse a `Retry-After` header into a delay in ms, or `undefined` if absent or
 * unparseable. Supports both forms from RFC 9110:
 *   - delta-seconds: a non-negative integer ("120")
 *   - HTTP-date: an absolute time ("Wed, 21 Oct 2026 07:28:00 GMT")
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  // delta-seconds form: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  // HTTP-date form: compute the offset from now.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  return deltaMs > 0 ? deltaMs : 0;
}

/**
 * Compute the backoff delay (ms) for a given attempt number using exponential
 * backoff with full jitter. `attempt` is 1-based (1 = first retry).
 */
function backoffWithJitter(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(maxDelayMs, exp);
  // Full jitter: a uniform draw across [0, capped].
  return random() * capped;
}

/**
 * `fetch` with bounded retry + backoff for transient failures.
 *
 * Returns the first non-retryable or successful response; on a retryable
 * response that survives all attempts, returns that last response (caller's
 * `!res.ok` handling then fires). On a persistent network error, rethrows the
 * last error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retriesLeft = attempt < maxAttempts;
    try {
      const res = await fetch(url, init);

      // Success or a non-retryable status: hand back to the caller as-is.
      if (res.ok || !isRetryableStatus(res.status)) {
        return res;
      }

      // Retryable response. If we're out of attempts, return it so the caller's
      // existing error path produces its usual message.
      if (!retriesLeft) {
        return res;
      }

      // Prefer the server's Retry-After when present; otherwise jittered backoff.
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const delay =
        retryAfterMs !== undefined
          ? Math.min(maxDelayMs, retryAfterMs)
          : backoffWithJitter(attempt, baseDelayMs, maxDelayMs, random);
      await sleep(delay);
    } catch (err) {
      // Network-level failure: no response to inspect, no Retry-After available.
      lastError = err;
      if (!retriesLeft) {
        throw err;
      }
      await sleep(backoffWithJitter(attempt, baseDelayMs, maxDelayMs, random));
    }
  }

  // Unreachable in practice: the loop returns or throws on its final attempt.
  // Kept for type-safety / defense in depth.
  throw lastError ?? new Error('fetchWithRetry: exhausted attempts');
}
