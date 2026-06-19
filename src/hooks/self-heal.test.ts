import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallOptions, InstallResult } from './installer.js';
import { selfHealClaudeCodeHooks } from './self-heal.js';

/** A fake installHooks that records calls and returns a scripted result. */
function fakeInstall(added: InstallResult['added']) {
  const calls: InstallOptions[] = [];
  const fn = (opts: InstallOptions): InstallResult => {
    calls.push(opts);
    return { settingsPath: opts.settingsPath ?? '/x', backupPath: null, added, alreadyPresent: [] };
  };
  return { fn, calls };
}

describe('selfHealClaudeCodeHooks', () => {
  it('skips (opt-out) and never touches settings when ABS_SELF_HEAL_HOOKS=0', () => {
    const install = fakeInstall([]);
    const res = selfHealClaudeCodeHooks({
      env: { ABS_SELF_HEAL_HOOKS: '0' },
      install: install.fn,
      detectClaudeCode: () => true,
    });
    expect(res).toEqual({ action: 'skipped', reason: 'opt-out' });
    expect(install.calls).toHaveLength(0);
  });

  it('skips for a non-claude-code harness (Codex hooks live elsewhere)', () => {
    const install = fakeInstall([]);
    const res = selfHealClaudeCodeHooks({
      harness: 'codex',
      env: {},
      install: install.fn,
      detectClaudeCode: () => true,
    });
    expect(res).toEqual({ action: 'skipped', reason: 'not-claude-launch' });
    expect(install.calls).toHaveLength(0);
  });

  it('skips a bare `abs start` (no --harness) so smoke tests / probes never touch real HOME', () => {
    // Real Claude Code launches pass `--harness claude-code` (#109). A bare start —
    // stdio-smoke.test.ts, manual probes, legacy registrations — must NOT self-heal,
    // since those isolate ABS_HOME but not HOME.
    const install = fakeInstall(['SessionEnd']);
    const res = selfHealClaudeCodeHooks({
      env: {},
      install: install.fn,
      detectClaudeCode: () => true, // Claude Code IS installed, but the launch is bare
    });
    expect(res).toEqual({ action: 'skipped', reason: 'not-claude-launch' });
    expect(install.calls).toHaveLength(0);
  });

  it('skips when Claude Code is not installed (no false action on a Codex-only box)', () => {
    const install = fakeInstall([]);
    const res = selfHealClaudeCodeHooks({
      harness: 'claude-code',
      env: {},
      install: install.fn,
      detectClaudeCode: () => false,
    });
    expect(res).toEqual({ action: 'skipped', reason: 'not-installed' });
    expect(install.calls).toHaveLength(0);
  });

  it('noop (no log) when hooks are already wired', () => {
    const install = fakeInstall([]); // installHooks added nothing → already present
    const log = vi.fn();
    const res = selfHealClaudeCodeHooks({
      harness: 'claude-code',
      env: {},
      install: install.fn,
      detectClaudeCode: () => true,
      log,
    });
    expect(res).toEqual({ action: 'noop' });
    expect(install.calls).toHaveLength(1);
    expect(install.calls[0]?.backup).toBe(false); // no .bak churn on self-heal
    expect(log).not.toHaveBeenCalled();
  });

  it('restores evicted hooks and logs once on an explicit claude-code launch', () => {
    const install = fakeInstall(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    const log = vi.fn();
    const res = selfHealClaudeCodeHooks({
      harness: 'claude-code',
      env: {},
      install: install.fn,
      detectClaudeCode: () => true,
      log,
    });
    expect(res).toEqual({
      action: 'restored',
      events: ['SessionEnd', 'SessionStart', 'UserPromptSubmit'],
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/re-wired 3 evicted Claude Code hook/i);
  });

  it('fails open (skips, no throw) when the installer throws — server must still serve', () => {
    const log = vi.fn();
    const res = selfHealClaudeCodeHooks({
      harness: 'claude-code',
      env: {},
      detectClaudeCode: () => true,
      install: () => {
        throw new Error('settings.json is a symlink — refusing to write through it');
      },
      log,
    });
    expect(res.action).toBe('skipped');
    expect(res).toMatchObject({ reason: 'error' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/self-heal skipped/i);
  });

  describe('with the real installHooks (hermetic tmp settings)', () => {
    let dir: string;
    let settingsPath: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'abs-selfheal-'));
      settingsPath = join(dir, 'settings.json');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('restores the 4 hooks into an evicted (empty) settings.json, writing NO .bak', () => {
      // A tool wiped abs's hooks, keeping only its own — valid file, no abs hooks.
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: { Notification: [{ matcher: '', hooks: [] }] } }),
        'utf8',
      );
      const res = selfHealClaudeCodeHooks({
        harness: 'claude-code',
        env: {},
        detectClaudeCode: () => true,
        settingsPath,
      });
      expect(res.action).toBe('restored');

      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: Record<string, unknown>;
      };
      expect(Object.keys(s.hooks).sort()).toEqual([
        'Notification', // the other tool's hook is preserved
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'UserPromptSubmit',
      ]);
      // backup:false → no .bak churn on the self-heal path.
      expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([]);

      // Idempotent: a second launch finds them wired and does nothing.
      const second = selfHealClaudeCodeHooks({
        harness: 'claude-code',
        env: {},
        detectClaudeCode: () => true,
        settingsPath,
      });
      expect(second).toEqual({ action: 'noop' });
    });
  });
});
