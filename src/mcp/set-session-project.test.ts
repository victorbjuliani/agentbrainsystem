/**
 * `set_session_project` MCP tool core (#52, F6). Tests the extracted
 * `setSessionProjectAction` directly (the registerTool closure is a thin wrapper).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { readBinding } from '../ingest/index.js';
import { type Memory, openMemory } from '../memory.js';
import { setSessionProjectAction } from './server.js';

describe('setSessionProjectAction (#52)', () => {
  let dir: string;
  let memory: Memory;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'abs-mcp-ssp-'));
    process.env.ABS_HOME = dir;
    process.env.ABS_EMBED_DIM = '8';
    delete process.env.CLAUDE_CODE_SESSION_ID;
    memory = await openMemory(loadConfig(), { ensure: false });
  });

  afterEach(() => {
    memory.close();
    delete process.env.ABS_HOME;
    delete process.env.ABS_EMBED_DIM;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('session resolution', () => {
    it('errors when neither session arg nor env is present', () => {
      const r = setSessionProjectAction(memory, { action: 'set', project: 'X' });
      expect(r.error).toContain('no session id');
    });

    it('falls back to CLAUDE_CODE_SESSION_ID', () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'env-sess';
      const r = setSessionProjectAction(memory, { action: 'set', project: 'X' });
      expect(r).toMatchObject({ session: 'env-sess', applied: true });
    });

    it('prefers the explicit session arg over env', () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'env-sess';
      const r = setSessionProjectAction(memory, {
        action: 'set',
        project: 'X',
        session: 'arg-sess',
      });
      expect(r.session).toBe('arg-sess');
    });
  });

  describe('set', () => {
    it('writes a sanitized binding and reports kind=new', () => {
      const r = setSessionProjectAction(memory, { action: 'set', project: 'a/b', session: 's1' });
      expect(r).toMatchObject({ action: 'set', project: 'a-b', kind: 'new', applied: true });
      expect(readBinding(memory.store, 's1')).toMatchObject({ action: 'set', project: 'a-b' });
    });

    it('reports kind=existing when the project already exists', () => {
      memory.store.createSession({ externalId: 'other', project: 'Alpha' });
      const r = setSessionProjectAction(memory, { action: 'set', project: 'Alpha', session: 's1' });
      expect(r.kind).toBe('existing');
    });

    it('errors for a missing project name', () => {
      const r = setSessionProjectAction(memory, { action: 'set', session: 's1' });
      expect(r.error).toContain('requires a `project`');
    });

    it('errors for a name that sanitizes to nothing', () => {
      const r = setSessionProjectAction(memory, { action: 'set', project: '   ', session: 's1' });
      expect(r.error).toContain('not a usable project name');
      expect(readBinding(memory.store, 's1')).toBeNull();
    });
  });

  describe('skip', () => {
    it('writes the binding directly when nothing is stored yet', () => {
      const r = setSessionProjectAction(memory, { action: 'skip', session: 's1' });
      expect(r).toMatchObject({ action: 'skip', deleted: 0, applied: true });
      expect(readBinding(memory.store, 's1')).toMatchObject({ action: 'skip' });
    });

    it('requires confirmDelete when stored observations exist (preview, no delete)', () => {
      const sid = memory.store.createSession({ externalId: 's2', project: 'auto' });
      memory.store.createObservation({ sessionId: sid, kind: 'user', content: 'hi' });

      const r = setSessionProjectAction(memory, { action: 'skip', session: 's2' });
      expect(r).toMatchObject({ action: 'skip', wouldDelete: 1, applied: false });
      // nothing written or deleted
      expect(memory.store.getSessionByExternalId('s2')).not.toBeNull();
      expect(readBinding(memory.store, 's2')).toBeNull();
    });

    it('hard-deletes with confirmDelete=true and writes the binding', () => {
      const sid = memory.store.createSession({ externalId: 's3', project: 'auto' });
      memory.store.createObservation({ sessionId: sid, kind: 'user', content: 'hi' });

      const r = setSessionProjectAction(memory, {
        action: 'skip',
        session: 's3',
        confirmDelete: true,
      });
      expect(r).toMatchObject({ action: 'skip', deleted: 1, applied: true });
      expect(memory.store.getSessionByExternalId('s3')).toBeNull();
      expect(readBinding(memory.store, 's3')).toMatchObject({ action: 'skip' });
    });
  });
});
