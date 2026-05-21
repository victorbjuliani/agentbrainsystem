/**
 * Non-fatal / timeout-bounded hook runner (#15) — the safety contract every hook
 * handler runs behind (ADR-0004).
 *
 * A Claude Code hook must NEVER block or break the session. So `runHookSafely`
 * guarantees:
 *   - the handler is raced against a self-bound timeout (independent of, and
 *     tighter than, the `timeout` registered in settings.json — belt and braces);
 *   - ANY thrown error or timeout is swallowed → the process exits 0 with no
 *     stdout (an injection hook simply injects nothing that turn);
 *   - on success, a single stdout line (the handler's return value, e.g. a context
 *     JSON line) is written, and nothing else touches stdout.
 *
 * stdout is reserved for the hook protocol; all diagnostics go to stderr. The
 * runner sets `process.exitCode = 0` explicitly so a handler can't leak a non-zero
 * code that Claude Code would treat as a hook failure.
 */

/** Default self-bound timeout. Comfortably inside the registered settings.json timeout. */
export const DEFAULT_HOOK_TIMEOUT_MS = 8000;

export interface RunHookOptions {
  /** Self-bound timeout in ms. Default `DEFAULT_HOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Where the success stdout line goes. Defaults to real stdout. */
  stdout?: (line: string) => void;
  /** Where diagnostics go. Defaults to real stderr. */
  stderr?: (line: string) => void;
}

/** Internal sentinel so a timeout is distinguishable from a handler-produced value. */
const TIMED_OUT = Symbol('hook-timeout');

/**
 * Run a hook handler under the non-fatal/timeout contract.
 *
 * The handler resolves to either a single stdout line (string) or `undefined`
 * (nothing to emit — e.g. SessionEnd, which can't inject). On timeout or throw,
 * the runner writes a stderr diagnostic and emits nothing on stdout. Always
 * resolves; never rejects; always leaves `process.exitCode = 0`.
 */
export async function runHookSafely(
  handler: () => Promise<string | undefined>,
  options: RunHookOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const writeOut = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    const result = await Promise.race([handler(), timeout]);
    if (result === TIMED_OUT) {
      writeErr(`abs hook: timed out after ${timeoutMs}ms — skipped (non-fatal)`);
    } else if (typeof result === 'string' && result.length > 0) {
      writeOut(result);
    }
  } catch (e) {
    writeErr(
      `abs hook: error — skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    // Never signal failure to Claude Code, regardless of what happened above.
    process.exitCode = 0;
  }
}
