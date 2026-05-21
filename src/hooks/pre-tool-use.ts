/**
 * PreToolUse contradiction guard (#29) — the A layer, the "active" in active
 * memory. Before the agent runs an Edit/Write, we check the action against
 * ground truth and surface a contradiction in-loop, at the moment of action:
 *
 *   "about to define `foo`, but `foo` already exists at src/other.ts:12 — you
 *    may be duplicating it."
 *
 * Design (discovery D4):
 *   - read-only point queries against the graph via GroundTruthProvider; the
 *     tool_input is untrusted and only READ (parsed for file/symbol), never run;
 *   - fires only on ground truth (verified by construction), keeping FP low;
 *   - WARN by default (inject a note); BLOCK is opt-in via ABS_GUARD_MODE=block;
 *   - fail-open: no graph / unavailable / any error → allow silently. A guard
 *     must never wedge the agent (ADR-0004).
 */
import { createGroundTruthProvider } from '../ground-truth/index.js';
import { extractToolAnchors } from '../ingest/claude-jsonl.js';
import { buildPreToolUseOutput, type HookPayload } from './payload.js';

/** Guard mode from the environment. Default `warn`; `block` is opt-in. */
function guardMode(): 'warn' | 'block' {
  return process.env.ABS_GUARD_MODE === 'block' ? 'block' : 'warn';
}

/**
 * Inspect a PreToolUse payload and return a decision line when the action
 * contradicts ground truth, or undefined to stay silent (allow). Pure w.r.t.
 * the session: only reads the graph.
 */
export function handlePreToolUse(payload: HookPayload): string | undefined {
  const { toolName, toolInput } = payload;
  if (!toolName || !toolInput) return undefined;

  // Reuse the ingest extractor: shape the single call as a content block.
  const seeds = extractToolAnchors([{ type: 'tool_use', name: toolName, input: toolInput }]);
  if (seeds.length === 0) return undefined; // not an anchorable Edit/Write on code

  const provider = createGroundTruthProvider(payload.cwd ?? process.cwd());
  try {
    if (!provider.isAvailable()) return undefined; // fail-open: no ground truth

    for (const seed of seeds) {
      for (const symbol of seed.symbols) {
        const existing = provider.resolveSymbol(symbol);
        // A contradiction is a symbol that already lives in a DIFFERENT file:
        // editing the file where it already is, is just editing it.
        if (existing && existing.filePath !== seed.filePath) {
          const where = existing.line ? `${existing.filePath}:${existing.line}` : existing.filePath;
          const reason =
            `\`${symbol}\` already exists at ${where}. You are about to define it in ` +
            `${seed.filePath} — check whether you are duplicating existing code.`;
          return buildPreToolUseOutput(guardMode(), reason) ?? undefined;
        }
      }
    }
    return undefined;
  } catch {
    return undefined; // fail-open
  } finally {
    provider.close();
  }
}
