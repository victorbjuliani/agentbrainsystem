import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPILOT_HOOKS, copilotLifecycleInstaller } from './copilot-lifecycle-installer.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'abs-copilot-hooks-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('COPILOT_HOOKS table (#69)', () => {
  it('maps Copilot events to canonical args', () => {
    expect(COPILOT_HOOKS.find((h) => h.event === 'sessionEnd')?.arg).toBe('session-end');
    expect(COPILOT_HOOKS.find((h) => h.event === 'sessionStart')?.arg).toBe('session-start');
    expect(COPILOT_HOOKS.find((h) => h.event === 'userPromptSubmitted')?.arg).toBe(
      'user-prompt-submit',
    );
    expect(COPILOT_HOOKS.find((h) => h.event === 'preToolUse')?.arg).toBe('pre-tool-use');
    // The recall config key MUST be `userPromptSubmitted` (SDK zod schema);
    // `userPromptSubmit` is invalid and silently never fires.
    expect(COPILOT_HOOKS.some((h) => h.event === 'userPromptSubmit')).toBe(false);
  });
});

describe('copilotLifecycleInstaller (#69)', () => {
  it('writes a flat {hooks:{event:[{type,bash}]},version:1} into a missing hooks.json', async () => {
    const p = join(tmp, 'hooks.json');
    const r1 = await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    expect(r1.wired).toEqual(expect.arrayContaining(['capture', 'recall', 'guard']));
    const c = JSON.parse(readFileSync(p, 'utf8'));
    expect(c.version).toBe(1);
    // FLAT: event -> [ {type:'command', bash} ] — NO matcher wrapper.
    expect(c.hooks.sessionEnd[0]).toEqual({ type: 'command', bash: 'abs hook session-end' });
    expect(c.hooks.sessionStart[0]).toEqual({ type: 'command', bash: 'abs hook session-start' });
    expect(c.hooks.userPromptSubmitted[0]).toEqual({
      type: 'command',
      bash: 'abs hook user-prompt-submit',
    });
    expect(c.hooks.preToolUse[0]).toEqual({ type: 'command', bash: 'abs hook pre-tool-use' });
    // idempotent: a second install is byte-identical.
    const before = readFileSync(p, 'utf8');
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('preserves a pre-existing unrelated hook entry AND a foreign top-level key', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        custom: 'keep-me',
        hooks: { sessionStart: [{ type: 'command', bash: 'other' }] },
      }),
    );
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    const c = JSON.parse(readFileSync(p, 'utf8'));
    expect(c.custom).toBe('keep-me');
    expect(c.version).toBe(1);
    // user's own entry survives, ours is appended to the same array.
    const bashes = c.hooks.sessionStart.map((h: { bash: string }) => h.bash);
    expect(bashes).toContain('other');
    expect(bashes).toContain('abs hook session-start');
  });

  it('defaults version to 1 but preserves a user-supplied version', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(p, JSON.stringify({ version: 2, hooks: {} }));
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(2);
  });

  it('creates a timestamped .bak before mutating an existing hooks.json', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(p, JSON.stringify({ version: 1, hooks: {} }));
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tmp).filter((f) => f.endsWith('.bak')).length).toBe(1);
  });

  it('refuses a symlinked hooks.json', async () => {
    const real = join(tmp, 'real.json');
    const link = join(tmp, 'hooks.json');
    writeFileSync(real, '{}');
    symlinkSync(real, link);
    await expect(
      copilotLifecycleInstaller({ hooksPath: link, baseCommand: 'abs hook' }).install(),
    ).rejects.toThrow(/symlink/);
  });

  it('malformed JSON starts fresh but backs up the original bytes first', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(p, '{ this is not json');
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tmp).filter((f) => f.endsWith('.bak')).length).toBe(1);
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(1);
  });

  // #159 (F2-02): a PRESENT-but-unparseable config was silently clobbered. ENOENT
  // (truly missing) is still a silent fresh start, but a malformed-PRESENT file must
  // warn loudly — naming the file AND the backup path — so the user knows their config
  // was replaced and where the original bytes went.
  it('warns to stderr (naming file + backup) when an EXISTING config is malformed (#159 F2-02)', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(p, '{ this is not json');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    const written = (stderr.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    stderr.mockRestore();
    const { readdirSync } = await import('node:fs');
    const bak = readdirSync(tmp).find((f) => f.endsWith('.bak'));
    expect(bak).toBeDefined();
    expect(written).toContain(p); // names the malformed file
    expect(written).toContain(bak as string); // names where the original bytes went
    // install still succeeds (does NOT abort)
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(1);
  });

  it('does NOT warn on a truly MISSING config (ENOENT stays a silent fresh start, #159 F2-02)', async () => {
    const p = join(tmp, 'hooks.json'); // never created
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>;
    await copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' }).install();
    const written = (stderr.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    stderr.mockRestore();
    expect(written).toBe(''); // no warning for a genuinely-absent file
  });

  it('uninstall removes ONLY our bash entries, drops emptied keys, keeps foreign entries + version', async () => {
    const p = join(tmp, 'hooks.json');
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        hooks: { sessionEnd: [{ type: 'command', bash: 'other' }] },
      }),
    );
    const inst = copilotLifecycleInstaller({ hooksPath: p, baseCommand: 'abs hook' });
    await inst.install();
    const report = await inst.uninstall();
    expect(report.removed).toEqual(expect.arrayContaining(['capture', 'recall', 'guard']));
    const c = JSON.parse(readFileSync(p, 'utf8'));
    expect(c.version).toBe(1);
    // our entries gone…
    expect(
      (c.hooks.sessionEnd ?? []).some((h: { bash: string }) => h.bash === 'abs hook session-end'),
    ).toBe(false);
    // …but the user's own sessionEnd entry survives.
    expect(c.hooks.sessionEnd.some((h: { bash: string }) => h.bash === 'other')).toBe(true);
    // a key that held ONLY our entries is dropped entirely.
    expect(c.hooks.sessionStart).toBeUndefined();
  });
});
