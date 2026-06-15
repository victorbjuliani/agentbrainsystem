/**
 * Gate 5 regression benchmark for #19 — the per-prompt FTS-first recall must stay
 * under the ADR-0005 baseline (p95 ≤ 25 ms for the query op over a ≥5,000-obs store).
 *
 * We seed the FTS index directly (no embedding — that is exactly the point of the
 * FTS-only path) and measure `recall.recallFts`, the operation the UserPromptSubmit
 * hook runs. The bound is generous (the measured p95 in the spike was ~4 ms) to
 * absorb CI/cold-cache variance while still catching an order-of-magnitude
 * regression (e.g. someone reintroducing an embed call on this path).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding/index.js';
import { Recall } from '../recall/index.js';
import { MemoryStore } from '../store/index.js';

/** P95 ceiling from ADR-0005. */
const P95_BUDGET_MS = 25;
const STORE_SIZE = 5000;
const ITERATIONS = 200;

class NoEmbedProvider implements EmbeddingProvider {
  readonly id = 'noembed';
  readonly model = 'none';
  readonly dimensions = 8;
  async embed(): Promise<number[][]> {
    throw new Error('benchmark must exercise the FTS-only path');
  }
}

const WORDS = (
  'recall embedding vector store sqlite hook session prompt indexer migration ' +
  'consolidate lesson decision provider config typescript async await error timeout ' +
  'fts search query latency benchmark cursor offset ingest transcript observation ' +
  'memory graph node edge community export import schema dimension cold warm resident'
).split(' ');

function synth(i: number): string {
  const n = 8 + (i % 20);
  const out: string[] = [];
  for (let j = 0; j < n; j++) out.push(WORDS[(i * 7 + j * 13) % WORDS.length] as string);
  return `obs ${i}: ${out.join(' ')}`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] as number;
}

let dir: string;
let store: MemoryStore;
let recall: Recall;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-bench-'));
  store = new MemoryStore({ dbPath: join(dir, 'bench.db'), dimensions: 8 }).open();
  const sessionId = store.createSession({ externalId: 's1' });
  // Mix durable (CURATED_KINDS) and raw kinds so the kind-weighted re-rank path (#141)
  // actually reorders the candidate pool instead of applying a uniform weight.
  const KINDS = ['user', 'assistant', 'user', 'lesson', 'user', 'decision', 'user', 'note'];
  for (let i = 1; i <= STORE_SIZE; i++) {
    const content = synth(i);
    const id = store.createObservation({
      sessionId,
      kind: KINDS[i % KINDS.length] as string,
      content,
    });
    store.indexFts(id, content);
  }
  recall = new Recall(store, new NoEmbedProvider());
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('per-prompt FTS recall latency (ADR-0005 Gate 5)', () => {
  // Each production recall-injection path is measured: the prompt hook (limit 8) and the
  // PreToolUse surfaceDecisions lens (limit 20 → candidates 100), both with rankByKind (#141),
  // plus the legacy default path as a control. The re-rank over-fetch + sort must stay under
  // the ADR-0005 p95 budget on every path.
  const SCENARIOS: Array<{ label: string; options: { limit: number; rankByKind?: boolean } }> = [
    // Control: the legacy default path. ADR-0005 spike measured ~4 ms p95 on an all-`note`
    // store; the seed is now a durable/raw mix, so compare against the 25 ms ceiling, not the
    // old absolute number.
    { label: 'limit 8, default (legacy path)', options: { limit: 8 } },
    { label: 'limit 8, rankByKind (prompt hook)', options: { limit: 8, rankByKind: true } },
    { label: 'limit 20, rankByKind (surfaceDecisions)', options: { limit: 20, rankByKind: true } },
  ];

  for (const { label, options } of SCENARIOS) {
    it(`stays under p95 ${P95_BUDGET_MS}ms over ${STORE_SIZE} observations — ${label}`, () => {
      // warm
      for (let i = 0; i < 20; i++) recall.recallFts(synth(i * 37 + 1), options);

      const times: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const q = synth(i * 37 + 1).slice(0, 60);
        const s = process.hrtime.bigint();
        recall.recallFts(q, options);
        times.push(Number(process.hrtime.bigint() - s) / 1e6);
      }
      times.sort((a, b) => a - b);
      const p95 = percentile(times, 95);
      // Surface the number in the test output for traceability.
      console.log(
        `recallFts [${label}] p50=${percentile(times, 50).toFixed(3)}ms p95=${p95.toFixed(3)}ms`,
      );
      expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    });
  }
});
