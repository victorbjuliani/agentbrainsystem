import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHooks, installHooks, uninstallHooks } from './installer.js';

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
  it('creates settings.json and registers all events when none exist', () => {
    const result = installHooks({ settingsPath });
    expect(result.added.sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.backupPath).toBeNull(); // no prior file to back up

    const s = read() as { hooks: Record<string, Array<{ matcher: string; hooks: unknown[] }>> };
    expect(s.hooks.SessionEnd?.[0]?.hooks).toEqual([
      { type: 'command', command: 'abs hook session-end', timeout: 30 },
    ]);
    expect(s.hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      command: 'abs hook user-prompt-submit',
    });
    // The guard is scoped to Edit/Write via its matcher.
    expect(s.hooks.PreToolUse?.[0]?.matcher).toBe('Edit|Write');
    expect(s.hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      command: 'abs hook pre-tool-use',
    });
  });

  it('is idempotent — a second run adds nothing and creates no duplicates', () => {
    installHooks({ settingsPath });
    const second = installHooks({ settingsPath });
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.sort()).toEqual([
      'PreToolUse',
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

  it('skips the backup when backup:false (self-heal path) but still writes the hooks', () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }), 'utf8');
    const result = installHooks({ settingsPath, backup: false });
    expect(result.backupPath).toBeNull();
    expect(result.added).toHaveLength(4);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([]);
    const s = read() as { hooks: Record<string, unknown>; permissions?: { allow: unknown[] } };
    // The additive, non-clobbering contract holds on the self-heal path too.
    expect(s.permissions).toEqual({ allow: [] });
    expect(Object.keys(s.hooks).sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
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

  it('refuses to write through a symlinked settings.json (does not follow it)', () => {
    const realTarget = join(dir, 'real-target.json');
    writeFileSync(realTarget, JSON.stringify({ permissions: { allow: ['SECRET'] } }), 'utf8');
    symlinkSync(realTarget, settingsPath);

    expect(() => installHooks({ settingsPath })).toThrow(/symlink/i);
    // The link's destination was NOT modified.
    const dest = JSON.parse(readFileSync(realTarget, 'utf8')) as Record<string, unknown>;
    expect(dest).toEqual({ permissions: { allow: ['SECRET'] } });
    expect(dest.hooks).toBeUndefined();
    // The path is still a symlink (not replaced with a regular file).
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
  });

  it('writes atomically (no leftover temp file) and stays idempotent', () => {
    installHooks({ settingsPath });
    // No `.abs-settings-tmp` temp artifact left behind by the atomic write.
    expect(readdirSync(dir).filter((f) => f.includes('abs-settings-tmp'))).toEqual([]);
    // A normal write produced a valid, parseable settings.json with our hooks.
    const s = read() as { hooks: Record<string, unknown> };
    expect(Object.keys(s.hooks).sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    // Idempotent re-run adds nothing.
    const second = installHooks({ settingsPath });
    expect(second.added).toEqual([]);
  });
});

describe('uninstallHooks', () => {
  it('round-trips: removes exactly what install added, leaving no hooks key behind', () => {
    installHooks({ settingsPath });
    const result = uninstallHooks({ settingsPath });
    expect(result.removed.sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(result.notPresent).toEqual([]);
    expect(result.backupPath).not.toBeNull(); // a prior file existed → backed up

    // Every abs event key is gone (groups were ours-only), and so is the empty hooks map.
    const s = read();
    expect(s.hooks).toBeUndefined();
  });

  it("preserves another tool's hook sharing our matcher group (removes only ours)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: 'other-tool.sh' },
                { type: 'command', command: 'abs hook session-end', timeout: 30 },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    const result = uninstallHooks({ settingsPath });
    expect(result.removed).toEqual(['SessionEnd']);

    const s = read() as {
      hooks: { SessionEnd: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const commands = s.hooks.SessionEnd.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toEqual(['other-tool.sh']); // ours gone, theirs kept
    expect(s.hooks.SessionEnd).toHaveLength(1); // the shared group survives
  });

  it('drops a now-empty matcher group but keeps other groups under the same event', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] },
            {
              matcher: 'Edit|Write',
              hooks: [{ type: 'command', command: 'abs hook pre-tool-use' }],
            },
          ],
        },
      }),
      'utf8',
    );
    uninstallHooks({ settingsPath });
    const s = read() as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    // The ours-only Edit|Write group is gone; the unrelated Bash group remains.
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]?.matcher).toBe('Bash');
  });

  it('reports notPresent and writes nothing when our hooks are absent', () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] } }), 'utf8');
    const result = uninstallHooks({ settingsPath });
    expect(result.removed).toEqual([]);
    expect(result.notPresent.sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(result.backupPath).toBeNull(); // nothing removed → no backup, no write
    // No backup file created.
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([]);
    // Unrelated keys untouched.
    expect(read()).toEqual({ permissions: { allow: ['Bash'] } });
  });

  it('tolerates a missing settings.json (nothing to remove, no throw)', () => {
    const result = uninstallHooks({ settingsPath });
    expect(result.removed).toEqual([]);
    expect(result.notPresent).toHaveLength(4);
    expect(result.backupPath).toBeNull();
  });

  it('backs up before mutating and never clobbers unrelated keys', () => {
    installHooks({ settingsPath });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...read(),
        permissions: { allow: ['Bash'] },
        statusLine: { type: 'x' },
      }),
      'utf8',
    );
    const result = uninstallHooks({ settingsPath });
    expect(result.backupPath).not.toBeNull();
    const s = read();
    expect(s.permissions).toEqual({ allow: ['Bash'] });
    expect(s.statusLine).toEqual({ type: 'x' });
  });

  it('refuses to mutate a corrupt settings.json', () => {
    writeFileSync(settingsPath, '{ not valid json', 'utf8');
    expect(() => uninstallHooks({ settingsPath })).toThrow(/not valid JSON/);
  });

  it('refuses to write through a symlinked settings.json (does not follow it)', () => {
    const realTarget = join(dir, 'real-target.json');
    writeFileSync(
      realTarget,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { matcher: '', hooks: [{ type: 'command', command: 'abs hook session-end' }] },
          ],
        },
      }),
      'utf8',
    );
    symlinkSync(realTarget, settingsPath);
    expect(() => uninstallHooks({ settingsPath })).toThrow(/symlink/i);
    // The link's destination still has the hook (not removed through the link).
    const dest = JSON.parse(readFileSync(realTarget, 'utf8')) as {
      hooks: { SessionEnd: unknown[] };
    };
    expect(dest.hooks.SessionEnd).toHaveLength(1);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
  });

  it('writes atomically (no leftover temp file)', () => {
    installHooks({ settingsPath });
    uninstallHooks({ settingsPath });
    expect(readdirSync(dir).filter((f) => f.includes('abs-settings-tmp'))).toEqual([]);
  });
});

describe('checkHooks', () => {
  it('reports wired:true with no missing when install wrote all hooks', () => {
    installHooks({ settingsPath });
    const health = checkHooks({ settingsPath });
    expect(health.wired).toBe(true);
    expect(health.missing).toEqual([]);
    expect(health.present.sort()).toEqual([
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(health.unreadable).toBe(false);
  });

  it('reports wired:false and lists the evicted events when a tool drops them', () => {
    installHooks({ settingsPath });
    // Simulate a third-party rewrite that kept only one matcher group and erased the rest.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'abs hook session-start' }] },
          ],
        },
      }),
      'utf8',
    );
    const health = checkHooks({ settingsPath });
    expect(health.wired).toBe(false);
    expect(health.present).toEqual(['SessionStart']);
    expect(health.missing.sort()).toEqual(['PreToolUse', 'SessionEnd', 'UserPromptSubmit']);
  });

  it('reports wired:false (everything missing) when settings.json does not exist', () => {
    const health = checkHooks({ settingsPath });
    expect(health.wired).toBe(false);
    expect(health.present).toEqual([]);
    expect(health.missing).toHaveLength(4);
    expect(health.unreadable).toBe(false);
  });

  it('reports unreadable:true (not wired) when settings.json is corrupt JSON', () => {
    writeFileSync(settingsPath, '{ not valid json', 'utf8');
    const health = checkHooks({ settingsPath });
    expect(health.wired).toBe(false);
    expect(health.unreadable).toBe(true);
  });

  it('matches hooks installed via an absolute binary path or node invocation', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/usr/local/bin/abs hook session-end' }],
            },
          ],
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'node /opt/abs/cli.js hook session-start' }],
            },
          ],
        },
      }),
      'utf8',
    );
    const health = checkHooks({ settingsPath, events: ['SessionEnd', 'SessionStart'] });
    expect(health.missing).toEqual([]);
    expect(health.wired).toBe(true);
  });

  it('treats malformed hook shapes as not-wired without throwing (external-rewrite hardening)', () => {
    // Valid JSON, but a third-party rewrite left non-array / null / primitive shapes
    // where groups are expected. checkHooks must never throw (it would crash doctor).
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: { not: 'an array' },
          SessionStart: 'a string',
          UserPromptSubmit: [null, 42, { hooks: 'also not an array' }],
          PreToolUse: [{ matcher: '', hooks: [null, { command: 'abs hook pre-tool-use' }] }],
        },
      }),
      'utf8',
    );
    let health!: ReturnType<typeof checkHooks>;
    expect(() => {
      health = checkHooks({ settingsPath });
    }).not.toThrow();
    expect(health.unreadable).toBe(false); // JSON parsed fine; only the shapes are off
    // Malformed events are reported missing; the one well-formed entry is found.
    expect(health.missing.sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    expect(health.present).toEqual(['PreToolUse']);
    expect(health.wired).toBe(false);
  });
});
