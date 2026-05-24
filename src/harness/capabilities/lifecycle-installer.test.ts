// src/harness/capabilities/lifecycle-installer.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsFileInstaller } from './lifecycle-installer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-lifecycle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settingsFileInstaller (Claude Code shape)', () => {
  it('writes the four canonical hook commands and reports three moments', async () => {
    const settingsPath = join(dir, 'settings.json');
    const installer = settingsFileInstaller({
      settingsPath,
      events: ['SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    });
    const report = await installer.install();
    expect(report.wired.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const written = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks);
    expect(written).toContain('abs hook session-end');
    expect(written).toContain('abs hook session-start');
    expect(written).toContain('abs hook user-prompt-submit');
    expect(written).toContain('abs hook pre-tool-use');
  });

  it('reports newly-added moments on first install and all-already-present on the second (idempotent)', async () => {
    const settingsPath = join(dir, 'settings.json');
    const installer = settingsFileInstaller({
      settingsPath,
      events: ['SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    });

    const first = await installer.install();
    expect(first.wired.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    expect((first.alreadyPresent ?? []).slice()).toEqual([]);
    const afterFirst = readFileSync(settingsPath, 'utf8');

    const second = await installer.install();
    // Nothing newly wired; every moment reported as already present.
    expect(second.wired.slice()).toEqual([]);
    expect(second.alreadyPresent?.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    // installHooks wrote nothing the 2nd time → byte-identical settings.json.
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });
});
