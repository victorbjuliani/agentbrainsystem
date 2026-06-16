import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_HOOKS, geminiLifecycleInstaller } from './gemini-lifecycle-installer.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'abs-gemini-hooks-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('GEMINI_HOOKS table (#68)', () => {
  it('maps Gemini events to canonical args', () => {
    expect(GEMINI_HOOKS.find((h) => h.event === 'SessionEnd')?.arg).toBe('session-end');
    expect(GEMINI_HOOKS.find((h) => h.event === 'SessionStart')?.arg).toBe('session-start');
    expect(GEMINI_HOOKS.find((h) => h.event === 'BeforeAgent')?.arg).toBe('user-prompt-submit');
    expect(GEMINI_HOOKS.find((h) => h.event === 'BeforeTool')?.arg).toBe('pre-tool-use');
    expect(GEMINI_HOOKS.find((h) => h.event === 'BeforeTool')?.matcher).toBe('Edit|Write');
  });
});

describe('geminiLifecycleInstaller (#68)', () => {
  it('writes Gemini hook keys to settings.json (backup-first, idempotent)', async () => {
    const p = join(tmp, 'settings.json');
    const r1 = await geminiLifecycleInstaller({
      settingsPath: p,
      baseCommand: 'abs hook',
    }).install();
    expect(r1.wired).toEqual(expect.arrayContaining(['capture', 'recall', 'guard']));
    const s = JSON.parse(readFileSync(p, 'utf8'));
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe('abs hook session-end');
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('abs hook session-start');
    expect(s.hooks.BeforeAgent[0].hooks[0].command).toBe('abs hook user-prompt-submit');
    expect(s.hooks.BeforeTool[0].matcher).toBe('Edit|Write');
    expect(s.hooks.BeforeTool[0].hooks[0].command).toBe('abs hook pre-tool-use');
    // idempotent: second run adds nothing (byte-identical)
    const before = readFileSync(p, 'utf8');
    await geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' }).install();
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('preserves an existing mcpServers block and the user’s own hooks', async () => {
    const p = join(tmp, 'settings.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { x: { command: 'y', args: [] } },
        hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }] },
      }),
    );
    await geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' }).install();
    const s = JSON.parse(readFileSync(p, 'utf8'));
    expect(s.mcpServers.x.command).toBe('y');
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      s.hooks.SessionEnd.some((g: any) => g.hooks.some((h: any) => h.command === 'other')),
    ).toBe(true);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      s.hooks.SessionEnd.some((g: any) =>
        // biome-ignore lint/suspicious/noExplicitAny: test introspection
        g.hooks.some((h: any) => h.command === 'abs hook session-end'),
      ),
    ).toBe(true);
  });

  it('creates a timestamped .bak before mutating an existing settings.json', async () => {
    const p = join(tmp, 'settings.json');
    writeFileSync(p, JSON.stringify({ theme: 'dark' }));
    await geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' }).install();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tmp).filter((f) => f.endsWith('.bak')).length).toBe(1);
    expect(JSON.parse(readFileSync(p, 'utf8')).theme).toBe('dark'); // unrelated key preserved
  });

  it('refuses a symlinked settings.json', async () => {
    const real = join(tmp, 'real.json');
    const link = join(tmp, 'settings.json');
    writeFileSync(real, '{}');
    symlinkSync(real, link);
    await expect(
      geminiLifecycleInstaller({ settingsPath: link, baseCommand: 'abs hook' }).install(),
    ).rejects.toThrow(/symlink/);
  });

  // #159 (F2-02): a PRESENT-but-unparseable settings.json was silently clobbered. ENOENT
  // (truly missing) is still a silent fresh start, but a malformed-PRESENT file must warn
  // loudly — naming the file AND the backup path — so the user knows their config was
  // replaced and where the original bytes went.
  it('warns to stderr (naming file + backup) when an EXISTING settings.json is malformed (#159 F2-02)', async () => {
    const p = join(tmp, 'settings.json');
    writeFileSync(p, '{ this is not json');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
    await geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' }).install();
    const written = (stderr.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    stderr.mockRestore();
    const { readdirSync } = await import('node:fs');
    const bak = readdirSync(tmp).find((f) => f.endsWith('.bak'));
    expect(bak).toBeDefined();
    expect(written).toContain(p); // names the malformed file
    expect(written).toContain(bak as string); // names where the original bytes went
    // install still succeeds (does NOT abort) — our hooks are written
    expect(JSON.parse(readFileSync(p, 'utf8')).hooks.SessionEnd[0].hooks[0].command).toBe(
      'abs hook session-end',
    );
  });

  it('does NOT warn on a truly MISSING settings.json (ENOENT stays a silent fresh start, #159 F2-02)', async () => {
    const p = join(tmp, 'settings.json'); // never created
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
    await geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' }).install();
    const written = (stderr.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    stderr.mockRestore();
    expect(written).toBe(''); // no warning for a genuinely-absent file
  });

  it('uninstall removes only our entries and leaves the file otherwise intact', async () => {
    const p = join(tmp, 'settings.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { x: { command: 'y', args: [] } },
        hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }] },
      }),
    );
    const inst = geminiLifecycleInstaller({ settingsPath: p, baseCommand: 'abs hook' });
    await inst.install();
    const report = await inst.uninstall();
    expect(report.removed).toEqual(expect.arrayContaining(['capture', 'recall', 'guard']));
    const s = JSON.parse(readFileSync(p, 'utf8'));
    expect(s.mcpServers.x.command).toBe('y'); // untouched
    // our managed entries gone…
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      (s.hooks.SessionEnd ?? []).some((g: any) =>
        // biome-ignore lint/suspicious/noExplicitAny: test introspection
        g.hooks.some((h: any) => h.command === 'abs hook session-end'),
      ),
    ).toBe(false);
    // …but the user's own SessionEnd hook survives
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      s.hooks.SessionEnd.some((g: any) => g.hooks.some((h: any) => h.command === 'other')),
    ).toBe(true);
  });
});
