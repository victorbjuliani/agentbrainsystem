import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBinding } from '../ingest/index.js';
import { MemoryStore } from '../store/index.js';
import { resolveRecallProject } from './scope.js';

describe('resolveRecallProject (#47)', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-scope-'));
    store = new MemoryStore({ dbPath: join(dir, 'm.db'), dimensions: 8 }).open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('global scope → undefined (no filter, the opt-out)', () => {
    expect(
      resolveRecallProject(store, { scope: 'global', sessionId: 's1', cwd: '/x' }),
    ).toBeUndefined();
  });

  it('a set binding wins → its project label', () => {
    writeBinding(store, 's1', { action: 'set', project: 'Milhas' });
    expect(
      resolveRecallProject(store, {
        scope: 'project',
        sessionId: 's1',
        transcriptPath: '/Users/me/.claude/projects/-Users-me-Devs-foo/s1.jsonl',
      }),
    ).toBe('Milhas');
  });

  it('falls back to the stored session row project (exact stored label)', () => {
    store.createSession({ externalId: 's2', project: 'StoredLabel' });
    expect(resolveRecallProject(store, { scope: 'project', sessionId: 's2' })).toBe('StoredLabel');
  });

  it('falls back to the transcript-dir slug when there is no cwd (C2)', () => {
    // No binding, no stored row, no cwd → derive from the transcript dir.
    expect(
      resolveRecallProject(store, {
        scope: 'project',
        sessionId: 'new-session',
        transcriptPath: '/Users/me/.claude/projects/-Users-me-Devs-foo/new-session.jsonl',
      }),
    ).toBe('-Users-me-Devs-foo');
  });

  it('prefers the cwd slug over the transcript dir, matching what ingest stores', () => {
    // Same real cwd, but the transcript lives under the NEW all-hyphen dir encoding
    // while ingest canonicalizes via projectSlug(cwd). Recall MUST resolve the cwd
    // slug so a not-yet-ingested session scopes to the same label its memories use.
    expect(
      resolveRecallProject(store, {
        scope: 'project',
        sessionId: 'new-session',
        transcriptPath:
          '/Users/me/.claude/projects/-Users-me-Meu-Mac-PG-Consultoria/new-session.jsonl',
        cwd: '/Users/me/Meu Mac/PG_Consultoria',
      }),
    ).toBe('-Users-me-Meu Mac-PG_Consultoria');
  });

  it('falls back to the cwd slug when no transcript path (MCP/last resort)', () => {
    expect(resolveRecallProject(store, { scope: 'project', cwd: '/Users/me/Devs/foo' })).toBe(
      '-Users-me-Devs-foo',
    );
  });

  it('returns undefined when nothing is resolvable (degrade to store-wide)', () => {
    expect(resolveRecallProject(store, { scope: 'project' })).toBeUndefined();
  });

  it('a skip binding does not block recall scoping — falls through to the dir slug', () => {
    writeBinding(store, 's3', { action: 'skip' });
    expect(
      resolveRecallProject(store, {
        scope: 'project',
        sessionId: 's3',
        transcriptPath: '/Users/me/.claude/projects/-Users-me-Devs-bar/s3.jsonl',
      }),
    ).toBe('-Users-me-Devs-bar');
  });

  it('looks up the (already-namespaced) sessionId verbatim — no re-derivation (R4, #67)', () => {
    store.createSession({ externalId: 'codex:019e2658', project: 'proj' });
    const project = resolveRecallProject(store, {
      scope: 'project',
      sessionId: 'codex:019e2658', // the chokepoint already prefixed it
    });
    expect(project).toBe('proj'); // hits the codex: row directly
  });
});
