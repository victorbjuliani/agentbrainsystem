/**
 * OpenCode plugin installer tests (#72, Task 3).
 *
 * Covers the plugin-file write (absolute `node <cli.js>` baked in, C2 regression
 * guard), idempotency, plugin-array merge preserving other keys, uninstall,
 * symlink refusal, and the JSONC-aware abort-not-clobber config write (C1).
 */
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
import { opencodePluginInstaller } from './opencode-plugin-installer.js';

const CLI = '/usr/local/lib/node_modules/agentbrainsystem/dist/cli/cli.js';
const NODE = '/opt/homebrew/bin/node';

describe('opencodePluginInstaller (#72)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-oc-plugin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function read(name = 'opencode.json'): string {
    return readFileSync(join(dir, name), 'utf8');
  }
  function pluginBody(): string {
    return readFileSync(join(dir, 'plugin', 'agentbrainsystem.js'), 'utf8');
  }

  it('(a) writes plugin/agentbrainsystem.js with the ABSOLUTE node <cli.js> pair baked in (C2)', async () => {
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    const body = pluginBody();
    // C2: the threaded cliPath + nodePath are baked as JSON string literals.
    expect(body).toContain(JSON.stringify(CLI));
    expect(body).toContain(JSON.stringify(NODE));
    // C2 regression guard: NEVER bare `abs`, NEVER a capabilities/installer-module path.
    expect(body).not.toMatch(/\$`abs /);
    expect(body).not.toContain('opencode-plugin-installer');
    expect(body).not.toContain('capabilities/');
    // ships both named + default export (W3 hedge).
    expect(body).toContain('export const AbsPlugin');
    expect(body).toContain('export default AbsPlugin');
  });

  it('(b) idempotent: second install is a no-op (no dup plugin entry, byte-stable file, no extra backup)', async () => {
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    const after1 = read();
    const backups1 = readdirSync(dir).filter((f) => f.endsWith('.bak')).length;
    await installer.install(CLI);
    const after2 = read();
    expect(after2).toBe(after1);
    const parsed = JSON.parse(after2);
    expect(parsed.plugin).toEqual(['./plugin/agentbrainsystem.js']);
    const backups2 = readdirSync(dir).filter((f) => f.endsWith('.bak')).length;
    expect(backups2).toBe(backups1); // no extra backup on the no-op
  });

  it('(c) preserves an existing unrelated plugin entry + $schema in a plain-JSON config', async () => {
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify(
        { $schema: 'https://opencode.ai/config.json', plugin: ['some-other-plugin'] },
        null,
        2,
      )}\n`,
    );
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    const parsed = JSON.parse(read());
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.plugin).toEqual(['some-other-plugin', './plugin/agentbrainsystem.js']);
  });

  it('(d) uninstall removes our entry + file, leaves the user plugin', async () => {
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify({ plugin: ['some-other-plugin'] }, null, 2)}\n`,
    );
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    await installer.uninstall();
    const parsed = JSON.parse(read());
    expect(parsed.plugin).toEqual(['some-other-plugin']);
    expect(() => lstatSync(join(dir, 'plugin', 'agentbrainsystem.js'))).toThrow();
  });

  it('(e) symlink config → refuse to write', async () => {
    const realTarget = join(dir, 'real-config.json');
    writeFileSync(realTarget, `${JSON.stringify({}, null, 2)}\n`);
    symlinkSync(realTarget, join(dir, 'opencode.json'));
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await expect(installer.install(CLI)).rejects.toThrow(/symlink/);
  });

  it('(f) C1 — plain opencode.json with other keys → plugin added, others preserved', async () => {
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local' } } }, null, 2)}\n`,
    );
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    await installer.registerMcp(CLI);
    const parsed = JSON.parse(read());
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.other).toEqual({ type: 'local' });
    expect(parsed.mcp.agentbrainsystem).toEqual({
      type: 'local',
      command: ['node', CLI, 'start'],
      enabled: true,
    });
    expect(parsed.plugin).toEqual(['./plugin/agentbrainsystem.js']);
  });

  it('(g) C1 — opencode.jsonc present → THAT file is the edit target, no sibling .json created', async () => {
    // A valid-JSON .jsonc (no comments) so the happy-path merge applies but to .jsonc.
    writeFileSync(join(dir, 'opencode.jsonc'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    await installer.install(CLI);
    const parsed = JSON.parse(read('opencode.jsonc'));
    expect(parsed.plugin).toEqual(['./plugin/agentbrainsystem.js']);
    expect(() => read('opencode.json')).toThrow(); // no sibling .json created/clobbered
  });

  it('(h) C1 — JSONC .json (comment + trailing comma) → ABORT: file byte-unchanged, .bak taken, snippet returned', async () => {
    const jsonc = '{\n  // user comment\n  "theme": "dark",\n}\n';
    writeFileSync(join(dir, 'opencode.json'), jsonc);
    const installer = opencodePluginInstaller({ configDir: dir, nodePath: NODE });
    const report = await installer.install(CLI);
    // file byte-for-byte unchanged
    expect(read()).toBe(jsonc);
    // a .bak was taken (defensive)
    expect(readdirSync(dir).some((f) => f.endsWith('.bak'))).toBe(true);
    // the printed manual snippet carries the plugin[] (and mcp) entry
    expect(report.manual).toBeDefined();
    expect(report.manual).toContain('./plugin/agentbrainsystem.js');
    expect(report.manual).toContain('agentbrainsystem');
  });
});
