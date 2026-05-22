/**
 * agentbrainsystem — reproducible performance benchmark.
 *
 *   npm run bench            # default 5,000 observations
 *   BENCH_N=20000 npm run bench
 *
 * Measures, on a synthetic store, the numbers we publish:
 *   - ingest throughput (createObservation + FTS index)
 *   - on-disk footprint (bytes / observation)
 *   - per-prompt FTS recall latency (p50/p95/p99) — the hook hot path
 *   - local embedding latency (cold model load + warm p50/p95) — the semantic path
 *
 * No network, no external services. Everything runs locally, just like the product.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEmbeddingProvider } from '../src/embedding/index.js';
import { Recall } from '../src/recall/index.js';
import { MemoryStore } from '../src/store/index.js';

const N = Number(process.env.BENCH_N ?? 5000);
const FTS_ITER = 300;
const EMBED_ITER = 50;

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

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

const hr = () => process.hrtime.bigint();
const since = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'abs-bench-'));
  const dbPath = join(dir, 'bench.db');
  const store = new MemoryStore({ dbPath, dimensions: 384 }).open();
  const sessionId = store.createSession({ externalId: 'bench' });

  // 1. ingest throughput
  const t0 = hr();
  for (let i = 1; i <= N; i++) {
    const content = synth(i);
    const id = store.createObservation({ sessionId, kind: 'note', content });
    store.indexFts(id, content);
  }
  const ingestMs = since(t0);

  // 2. on-disk footprint
  const bytes = statSync(dbPath).size;

  // 3. per-prompt FTS recall latency
  const recall = new Recall(store, new LocalEmbeddingProvider());
  for (let i = 0; i < 30; i++) recall.recallFts(synth(i * 37 + 1), { limit: 8 }); // warm
  const fts: number[] = [];
  for (let i = 0; i < FTS_ITER; i++) {
    const q = synth(i * 37 + 1).slice(0, 60);
    const s = hr();
    recall.recallFts(q, { limit: 8 });
    fts.push(since(s));
  }
  fts.sort((a, b) => a - b);

  // 4. local embedding latency (cold load + warm)
  const provider = new LocalEmbeddingProvider();
  const c = hr();
  await provider.embed(['cold-load the embedding model']);
  const coldMs = since(c);
  const emb: number[] = [];
  for (let i = 0; i < EMBED_ITER; i++) {
    const s = hr();
    await provider.embed([synth(i * 13 + 3).slice(0, 80)]);
    emb.push(since(s));
  }
  emb.sort((a, b) => a - b);

  store.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        observations: N,
        ingest: { totalMs: Math.round(ingestMs), ratePerSec: Math.round(N / (ingestMs / 1000)) },
        diskFootprint: { totalKB: Math.round(bytes / 1024), bytesPerObs: Math.round(bytes / N) },
        ftsRecallMs: {
          p50: +pct(fts, 50).toFixed(2),
          p95: +pct(fts, 95).toFixed(2),
          p99: +pct(fts, 99).toFixed(2),
        },
        embedMs: { coldLoad: Math.round(coldMs), warmP50: +pct(emb, 50).toFixed(1), warmP95: +pct(emb, 95).toFixed(1) },
        env: { node: process.version, model: provider.model, dimensions: provider.dimensions },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
