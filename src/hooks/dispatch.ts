/**
 * Hook dispatch (#15, extended by #16/#19) — maps an `abs hook <event-arg>` call to
 * its handler, behind the non-fatal/timeout runner.
 *
 * The CLI stays thin: it forwards the event arg here. This module reads the payload
 * from stdin, parses it defensively, picks the handler, and runs it via
 * `runHookSafely` so a missing/unknown event or a handler failure can never block
 * the session (ADR-0004). Unknown events are a silent no-op (exit 0).
 */

import { harnessForPayload, namespacedExternalId } from '../ingest/index.js';
import { type HookPayload, parseHookPayload, readStdin } from './payload.js';
import { handlePreToolUse } from './pre-tool-use.js';
import { runHookSafely } from './runner.js';
import { handleSessionEnd } from './session-end.js';
import { handleSessionStart } from './session-start.js';
import { handleUserPromptSubmit } from './user-prompt-submit.js';

/** Map the CLI event arg → its handler. Each handler returns a stdout line or undefined. */
const HANDLERS: Record<string, (payload: HookPayload) => Promise<string | undefined>> = {
  'pre-tool-use': (p) => handlePreToolUse(p),
  'session-end': (p) => handleSessionEnd(p),
  'session-start': (p) => handleSessionStart(p),
  'user-prompt-submit': (p) => handleUserPromptSubmit(p),
};

export interface DispatchOptions {
  /** Override stdin (tests). */
  stdin?: NodeJS.ReadableStream;
  /** Override stdout sink (tests). */
  stdout?: (line: string) => void;
  /** Override stderr sink (tests). */
  stderr?: (line: string) => void;
  /** Self-bound timeout in ms passed to the runner. */
  timeoutMs?: number;
}

/**
 * Dispatch an `abs hook <eventArg>` invocation. Always resolves and leaves
 * `process.exitCode = 0` (the runner guarantees this). An unknown event arg emits
 * nothing and is non-fatal.
 */
export async function dispatchHook(eventArg: string, options: DispatchOptions = {}): Promise<void> {
  const handler = HANDLERS[eventArg];
  await runHookSafely(
    async () => {
      if (!handler) return undefined; // unknown event — no-op, non-fatal
      const raw = await readStdin(options.stdin);
      const payload = parseHookPayload(raw);
      // CHOKEPOINT (C-NEW-1/R4, #67): namespace the session id ONCE so the bare id
      // never reaches a handler. Claude → bare (migration-safe); Codex → codex:<uuid>.
      // Path-derived from transcriptPath. Every downstream consumer (session-start,
      // user-prompt-submit, scope, set_session_project) treats it as opaque.
      if (payload.sessionId) {
        payload.sessionId = namespacedExternalId(harnessForPayload(payload), payload.sessionId);
      }
      return handler(payload);
    },
    {
      ...(options.stdout ? { stdout: options.stdout } : {}),
      ...(options.stderr ? { stderr: options.stderr } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
  );
}
