/**
 * Throwaway benchmark for ADR-0005 (issue #17). Measures the per-prompt recall
 * path latency that the UserPromptSubmit hook (#19) will live on:
 *
 *   1. FTS5-only search latency (p50/p95) over a realistic synthetic store.
 *   2. The cold-load cost of the local embedding provider's first embed() call
 *      (the ~35s landmine) vs a warm embed, to justify "FTS-first for the MVP".
 *
 * Run: `node scripts/bench-recall.mjs` (uses a temp DB; never touches real data).
 * The NUMBERS this prints are recorded in docs/adr/0005-*.md — this script is a
 * reproducer, not a committed dependency of any runtime path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const N = Number(process.env.BENCH_N ?? 5000);
const ITER = Number(process.env.BENCH_ITER ?? 200);

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function toFtsQuery(text) {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  const seen = new Set();
  const terms = [];
  for (const t of tokens) {
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    terms.push(`"${t}"`);
  }
  return terms.length ? terms.join(' OR ') : null;
}

const WORDS = (
  'recall embedding vector store sqlite hook session prompt indexer migration ' +
  'consolidate lesson decision provider config typescript async await error timeout ' +
  'fts search query latency benchmark cursor offset ingest transcript observation ' +
  'memory graph node edge community export import schema dimension cold warm resident'
).split(' ');

function synthSentence(i) {
  const n = 8 + (i % 20);
  const out = [];
  for (let j = 0; j < n; j++) out.push(WORDS[(i * 7 + j * 13) % WORDS.length]);
  return `obs ${i}: ${out.join(' ')}`;
}

const dir = mkdtempSync(join(tmpdir(), 'abs-bench-'));
const dbPath = join(dir, 'bench.db');
const db = new Database(dbPath);
sqliteVec.load(db);
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE observations(id INTEGER PRIMARY KEY, content TEXT);`);
db.exec(`CREATE VIRTUAL TABLE fts_observations USING fts5(content);`);

const t0 = Date.now();
const insObs = db.prepare('INSERT INTO observations(id, content) VALUES (?, ?)');
const insFts = db.prepare('INSERT INTO fts_observations(rowid, content) VALUES (?, ?)');
const tx = db.transaction(() => {
  for (let i = 1; i <= N; i++) {
    const c = synthSentence(i);
    insObs.run(i, c);
    insFts.run(i, c);
  }
});
tx();
console.log(`built synthetic store: ${N} observations in ${Date.now() - t0}ms`);

const search = db.prepare(
  `SELECT rowid AS id, rank FROM fts_observations WHERE fts_observations MATCH ? ORDER BY rank LIMIT ?`,
);
const queries = [];
for (let i = 0; i < ITER; i++) queries.push(synthSentence(i * 37 + 1).slice(0, 60));

// warm the prepared statement / page cache
for (let i = 0; i < 20; i++) search.all(toFtsQuery(queries[i % queries.length]), 50);

let sampleHits = 0;
const times = [];
for (let i = 0; i < ITER; i++) {
  const q = toFtsQuery(queries[i % queries.length]);
  const s = process.hrtime.bigint();
  const rows = search.all(q, 50);
  const e = process.hrtime.bigint();
  times.push(Number(e - s) / 1e6);
  if (i === 0) sampleHits = rows.length;
}
times.sort((a, b) => a - b);
console.log(
  `FTS5-only search (k=50, ${ITER} iters): p50=${percentile(times, 50).toFixed(3)}ms ` +
    `p95=${percentile(times, 95).toFixed(3)}ms p99=${percentile(times, 99).toFixed(3)}ms ` +
    `max=${times[times.length - 1].toFixed(3)}ms (sample hits=${sampleHits})`,
);

db.close();
rmSync(dir, { recursive: true, force: true });

// --- embedding cold-load vs warm ---
if (process.env.BENCH_SKIP_EMBED !== '1') {
  const { pipeline } = await import('@huggingface/transformers');
  const c0 = process.hrtime.bigint();
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  await extractor(['warm up the runtime'], { pooling: 'mean', normalize: true });
  const c1 = process.hrtime.bigint();
  console.log(`embedding COLD load + first embed: ${(Number(c1 - c0) / 1e6).toFixed(1)}ms`);

  const w0 = process.hrtime.bigint();
  await extractor(['a second warm embed call'], { pooling: 'mean', normalize: true });
  const w1 = process.hrtime.bigint();
  console.log(`embedding WARM embed (1 text):    ${(Number(w1 - w0) / 1e6).toFixed(1)}ms`);
}
