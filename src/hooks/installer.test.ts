import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from './installer.js';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-installer-'));
  settingsPath = join(dir, 'settings.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

describe('installHooks', () => {
  it('creates settings.json and registers all three events when none exist', () => {
    const result = installHooks({ settingsPath });
    expect(result.added.sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.backupPath).toBeNull(); // no prior file to back up

    const s = read() as { hooks: Record<string, Array<{ matcher: string; hooks: unknown[] }>> };
    expect(s.hooks.SessionEnd?.[0]?.hooks).toEqual([
      { type: 'command', command: 'abs hook session-end', timeout: 30 },
    ]);
    expect(s.hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      command: 'abs hook user-prompt-submit',
    });
  });

  it('is idempotent — a second run adds nothing and creates no duplicates', () => {
    installHooks({ settingsPath });
    const second = installHooks({ settingsPath });
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.sort()).toEqual([
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);

    const s = read() as { hooks: Record<string, Array<{ hooks: unknown[] }>> };
    // Exactly one command per event, no dupes.
    expect(s.hooks.SessionEnd?.[0]?.hooks).toHaveLength(1);
  });

  it('backs up an existing settings.json before mutating', () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }), 'utf8');
    const result = installHooks({ settingsPath });
    expect(result.backupPath).not.toBeNull();
    const backups = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
  });

  it('never clobbers unrelated top-level keys', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash'] }, statusLine: { type: 'x' } }),
      'utf8',
    );
    installHooks({ settingsPath });
    const s = read();
    expect(s.permissions).toEqual({ allow: ['Bash'] });
    expect(s.statusLine).toEqual({ type: 'x' });
  });

  it("merges into another tool's existing hooks without replacing them", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool.sh' }] }],
        },
      }),
      'utf8',
    );
    installHooks({ settingsPath });
    const s = read() as {
      hooks: { SessionEnd: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const commands = s.hooks.SessionEnd.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('other-tool.sh'); // preserved
    expect(commands).toContain('abs hook session-end'); // added
    // Merged into the same empty-matcher group, not a duplicate '' group.
    expect(s.hooks.SessionEnd).toHaveLength(1);
  });

  it('honors a restricted event subset (used by #16/#19 extension)', () => {
    const result = installHooks({ settingsPath, events: ['SessionEnd'] });
    expect(result.added).toEqual(['SessionEnd']);
    const s = read() as { hooks: Record<string, unknown> };
    expect(Object.keys(s.hooks)).toEqual(['SessionEnd']);
  });

  it('refuses to mutate a corrupt settings.json', () => {
    writeFileSync(settingsPath, '{ not valid json', 'utf8');
    expect(() => installHooks({ settingsPath })).toThrow(/not valid JSON/);
  });
});
