import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/index.js';
import {
  BINDING_PREFIX,
  cleanupBindings,
  readBinding,
  SET_BINDING_TTL_MS,
  sanitizeProjectName,
  writeBinding,
} from './session-binding.js';

const DIM = 8;

describe('session-binding', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-binding-'));
    store = new MemoryStore({ dbPath: join(dir, 'memory.db'), dimensions: DIM }).open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('sanitizeProjectName', () => {
    it('keeps a clean label intact', () => {
      expect(sanitizeProjectName('My Feature')).toBe('My Feature');
    });

    it('strips control characters and newlines', () => {
      expect(sanitizeProjectName('a\u0000b\nc\td')).toBe('a b c d');
    });

    it('collapses path separators to dashes (never a path)', () => {
      expect(sanitizeProjectName('../../etc/passwd')).toBe('..-..-etc-passwd');
      expect(sanitizeProjectName('a\\b')).toBe('a-b');
    });

    it('collapses whitespace and trims', () => {
      expect(sanitizeProjectName('   x    y   ')).toBe('x y');
    });

    it('caps length at 100 chars', () => {
      const out = sanitizeProjectName('z'.repeat(500));
      expect(out).not.toBeNull();
      expect((out as string).length).toBe(100);
    });

    it('returns null for empty / whitespace-only / non-string input', () => {
      expect(sanitizeProjectName('')).toBeNull();
      expect(sanitizeProjectName('   \n\t ')).toBeNull();
      expect(sanitizeProjectName(undefined)).toBeNull();
      expect(sanitizeProjectName(42)).toBeNull();
    });
  });

  describe('writeBinding + readBinding', () => {
    it('round-trips a sanitized set binding', () => {
      expect(writeBinding(store, 'sess-1', { action: 'set', project: 'a/b' })).toBe(true);
      expect(readBinding(store, 'sess-1')).toMatchObject({ action: 'set', project: 'a-b' });
    });

    it('refuses a set binding whose name sanitizes to nothing (no junk row)', () => {
      expect(writeBinding(store, 'sess-1', { action: 'set', project: '\u0000\n  ' })).toBe(false);
      expect(readBinding(store, 'sess-1')).toBeNull();
      expect(store.getMeta(`${BINDING_PREFIX}sess-1`)).toBeNull();
    });

    it('round-trips a skip binding', () => {
      expect(writeBinding(store, 'sess-1', { action: 'skip' })).toBe(true);
      expect(readBinding(store, 'sess-1')).toMatchObject({ action: 'skip' });
    });

    it('returns null for an absent binding', () => {
      expect(readBinding(store, 'nope')).toBeNull();
    });

    it('treats a malformed JSON value as absent', () => {
      store.setMeta(`${BINDING_PREFIX}bad`, '{not json');
      expect(readBinding(store, 'bad')).toBeNull();
    });

    it('treats a set binding with an empty project as absent', () => {
      store.setMeta(
        `${BINDING_PREFIX}empty`,
        JSON.stringify({ action: 'set', project: '', createdAt: new Date().toISOString() }),
      );
      expect(readBinding(store, 'empty')).toBeNull();
    });
  });

  describe('skip reconciliation at write time', () => {
    it('deletes an already-ingested session when skip is written after the fact', () => {
      const id = store.createSession({ externalId: 'sess-x', project: 'auto' });
      store.createObservation({ sessionId: id, kind: 'user', content: 'hello' });
      expect(store.counts().sessions).toBe(1);
      expect(store.counts().observations).toBe(1);

      writeBinding(store, 'sess-x', { action: 'skip' });

      expect(store.getSessionByExternalId('sess-x')).toBeNull();
      expect(store.counts().sessions).toBe(0);
      expect(store.counts().observations).toBe(0);
    });

    it('is a no-op delete when no session exists yet', () => {
      expect(writeBinding(store, 'sess-y', { action: 'skip' })).toBe(true);
      expect(readBinding(store, 'sess-y')).toMatchObject({ action: 'skip' });
    });
  });

  describe('TTL', () => {
    it('lazily expires a set binding older than the TTL and deletes it', () => {
      const old = new Date(Date.now() - SET_BINDING_TTL_MS - 1000);
      writeBinding(store, 'sess-old', { action: 'set', project: 'X' }, old);
      expect(readBinding(store, 'sess-old')).toBeNull();
      // lazily deleted on read
      expect(store.getMeta(`${BINDING_PREFIX}sess-old`)).toBeNull();
    });

    it('does NOT expire a skip binding (permanent intent)', () => {
      const old = new Date(Date.now() - SET_BINDING_TTL_MS * 100);
      writeBinding(store, 'sess-skip', { action: 'skip' }, old);
      expect(readBinding(store, 'sess-skip')).toMatchObject({ action: 'skip' });
    });

    it('cleanupBindings drops expired set bindings but keeps skip + fresh set', () => {
      const old = new Date(Date.now() - SET_BINDING_TTL_MS - 1000);
      writeBinding(store, 'old-set', { action: 'set', project: 'X' }, old);
      writeBinding(store, 'old-skip', { action: 'skip' }, old);
      writeBinding(store, 'fresh-set', { action: 'set', project: 'Y' });

      const removed = cleanupBindings(store);

      expect(removed).toBe(1);
      expect(store.getMeta(`${BINDING_PREFIX}old-set`)).toBeNull();
      expect(readBinding(store, 'old-skip')).toMatchObject({ action: 'skip' });
      expect(readBinding(store, 'fresh-set')).toMatchObject({ action: 'set', project: 'Y' });
    });

    it('cleanupBindings ignores unrelated kv_meta keys (e.g. ingest cursors)', () => {
      store.setMeta('ingest:cursor:/x.jsonl', '123');
      store.setMeta('embedding:signature', 'sig');
      writeBinding(store, 'a', { action: 'skip' });
      cleanupBindings(store);
      expect(store.getMeta('ingest:cursor:/x.jsonl')).toBe('123');
      expect(store.getMeta('embedding:signature')).toBe('sig');
    });
  });
});
