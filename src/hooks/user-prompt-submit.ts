/**
 * UserPromptSubmit hook handler (#19) — per-prompt FTS-first context injection.
 *
 * Claude Code runs this with the prompt on stdin before each turn. We recall memory
 * relevant to the prompt and inject it as `additionalContext`. Per ADR-0005 this is
 * the interactive critical path, so it uses the FTS-ONLY fast path
 * (`recall.recallFts`) which never calls `provider.embed` — no model cold-load, no
 * first-ever-download landmine. Opened with `ensure:false` so no index rebuild fires.
 *
 * The injected block is bounded so it stays cheap and small:
 *   - top-K hits (TOP_K);
 *   - dedupe by normalized content (ingest can store near-duplicate turns);
 *   - a char budget (CHAR_BUDGET ≈ a small token budget) truncating the block.
 *
 * On any failure the runner swallows it (ADR-0004): the turn proceeds with no
 * injected memory rather than blocking.
 */

import type { Memory } from '../memory.js';
import { openMemory } from '../memory.js';
import type { RecallHit } from '../recall/index.js';
import { buildContextOutput, type HookPayload } from './payload.js';

/** Max hits pulled from FTS before dedupe/budget trimming. */
export const TOP_K = 8;
/** Approximate character budget for the injected block (~token budget × 4). */
export const CHAR_BUDGET = 1200;
/** Skip a hit whose content is shorter than this — too thin to be useful context. */
const MIN_CONTENT_CHARS = 12;

export interface UserPromptSubmitDeps {
  /** Injection seam for tests — defaults to FTS recall over the real store. */
  recall?: (prompt: string) => Promise<RecallHit[]>;
}

/** Normalize content for dedupe: collapse whitespace + lowercase. */
function normalize(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Render the recalled hits into a bounded context block. Pure: dedupes by
 * normalized content, drops too-thin hits, and truncates to the char budget. Empty
 * input (or everything filtered) → '' (caller injects nothing).
 */
export function renderRecallBlock(hits: RecallHit[]): string {
  const seen = new Set<string>();
  const items: string[] = [];
  let used = 0;

  for (const hit of hits) {
    const content = hit.observation.content.trim();
    if (content.length < MIN_CONTENT_CHARS) continue;
    const key = normalize(content);
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = hit.observation.kind;
    const line = `- [${kind}] ${content.replace(/\s+/g, ' ')}`;
    // Stop once adding this line would blow the budget (keep at least one line).
    if (items.length > 0 && used + line.length > CHAR_BUDGET) break;
    items.push(line.length > CHAR_BUDGET ? `${line.slice(0, CHAR_BUDGET - 1)}…` : line);
    used += line.length + 1;
    if (used >= CHAR_BUDGET) break;
  }

  if (items.length === 0) return '';
  return ['Relevant memory (recalled from agentbrainsystem):', ...items].join('\n');
}

/** FTS-first recall over the real store, read-only (no model load). */
async function recallFromStore(prompt: string): Promise<RecallHit[]> {
  const memory: Memory = await openMemory(undefined, { ensure: false });
  try {
    return memory.recall.recallFts(prompt, { limit: TOP_K });
  } finally {
    memory.close();
  }
}

/**
 * Build the UserPromptSubmit context line (or undefined when nothing to inject).
 * Throws on failure — the runner swallows it.
 */
export async function handleUserPromptSubmit(
  payload: HookPayload,
  deps: UserPromptSubmitDeps = {},
): Promise<string | undefined> {
  const prompt = payload.prompt?.trim();
  if (!prompt) return undefined; // no prompt to recall against — nothing to do

  const hits = deps.recall ? await deps.recall(prompt) : await recallFromStore(prompt);
  const block = renderRecallBlock(hits);
  return buildContextOutput('UserPromptSubmit', block) ?? undefined;
}
