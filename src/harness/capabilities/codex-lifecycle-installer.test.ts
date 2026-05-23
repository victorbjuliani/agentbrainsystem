import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexLifecycleInstaller } from './codex-lifecycle-installer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const FIXTURE = join(__dirname, '__fixtures__/codex/config.toml');

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abs-codex-hooks-'));
  configPath = join(dir, 'config.toml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Validate that `path` is parseable TOML by pointing the REAL codex binary at a
 * CODEX_HOME containing it (`codex mcp list`). codex exits 0 either way, so we
 * detect a parse failure by its "failed to load configuration" stderr banner.
 * Skips (returns true) if the codex binary is not installed on this machine.
 */
async function codexParsesConfig(path: string): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), 'abs-codex-home-'));
  try {
    copyFileSync(path, join(home, 'config.toml'));
    try {
      const { stderr } = await execFileAsync('codex', ['mcp', 'list'], {
        env: { ...process.env, CODEX_HOME: home },
        timeout: 20000,
      });
      return !/failed to load configuration/i.test(stderr);
    } catch (e) {
      const err = e as { code?: string; stderr?: string };
      if (err.code === 'ENOENT') return true; // codex not installed — skip
      return !/failed to load configuration/i.test(err.stderr ?? '');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('codexLifecycleInstaller', () => {
  it('writes the four managed hook blocks and reports three moments', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n[projects."/x"]\ntrust_level = "trusted"\n');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    const report = await installer.install();
    expect(report.wired.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const toml = readFileSync(configPath, 'utf8');
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).toContain('[[hooks.SessionStart]]');
    expect(toml).toContain('[[hooks.UserPromptSubmit]]');
    expect(toml).toContain('[[hooks.PreToolUse]]');
    expect(toml).toContain('abs hook session-end');
    expect(toml).toContain('abs hook session-start');
    expect(toml).toContain('abs hook user-prompt-submit');
    expect(toml).toContain('abs hook pre-tool-use');
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('[projects."/x"]');
  });

  it('is idempotent — a second install neither duplicates nor errors', async () => {
    writeFileSync(configPath, '');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const once = readFileSync(configPath, 'utf8');
    await installer.install();
    expect(readFileSync(configPath, 'utf8')).toBe(once);
  });

  it('creates a timestamped .bak before mutating an existing config', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    await codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install();
    const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    expect(baks.length).toBe(1);
  });

  it('uninstall removes exactly the managed block, leaving the rest untouched', async () => {
    writeFileSync(configPath, 'model = "gpt-5.5"\n');
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const report = await installer.uninstall();
    expect(report.removed.slice().sort()).toEqual(['capture', 'guard', 'recall']);
    const toml = readFileSync(configPath, 'utf8');
    expect(toml).not.toContain('[[hooks.');
    expect(toml).not.toContain('agentbrainsystem hooks');
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it('refuses to write through a symlinked config (safety)', async () => {
    const real = join(dir, 'real.toml');
    writeFileSync(real, 'model = "x"\n');
    symlinkSync(real, configPath);
    await expect(
      codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install(),
    ).rejects.toThrow(/symlink/);
  });

  // --- C3: real-config fixture, byte-identical 3 runs, exactly one managed block ---
  it('is byte-identical across 3 consecutive installs over the REAL-config fixture', async () => {
    const fixture = readFileSync(FIXTURE, 'utf8');
    writeFileSync(configPath, fixture);
    const installer = codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' });
    await installer.install();
    const r1 = readFileSync(configPath);
    await installer.install();
    const r2 = readFileSync(configPath);
    await installer.install();
    const r3 = readFileSync(configPath);
    expect(r1.equals(r2)).toBe(true);
    expect(r2.equals(r3)).toBe(true);
    const out = r3.toString('utf8');
    // Every unrelated table from the real fixture survives verbatim.
    expect(out).toContain('[mcp_servers');
    expect(out).toContain('trust_level');
    expect(out).toContain('notify = [');
    // Exactly ONE managed block, and exactly one of each event header.
    expect((out.match(/agentbrainsystem hooks \(managed/g) ?? []).length).toBe(2); // begin + end sentinel
    expect((out.match(/\[\[hooks\.Stop\]\]/g) ?? []).length).toBe(1);
    expect((out.match(/\[\[hooks\.SessionStart\]\]/g) ?? []).length).toBe(1);
  });

  it('preserves user [mcp_servers.*] and [projects.*] tables verbatim from the real fixture', async () => {
    const fixture = readFileSync(FIXTURE, 'utf8');
    writeFileSync(configPath, fixture);
    await codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install();
    const out = readFileSync(configPath, 'utf8');
    expect(out).toContain('[mcp_servers.agentmemory]');
    expect(out).toContain('command = "npx"');
    // A representative real project table is untouched.
    expect(out).toContain('[projects."/Users/vbjuliani/Devs/Widget"]');
  });

  it('produces output the REAL codex binary parses as valid TOML (no @iarna/toml dep)', async () => {
    const fixture = readFileSync(FIXTURE, 'utf8');
    writeFileSync(configPath, fixture);
    await codexLifecycleInstaller({ configPath, baseCommand: 'abs hook' }).install();
    expect(await codexParsesConfig(configPath)).toBe(true);
  });

  // --- W3: trust detection surfaces in the install report ---
  it('flags an untrusted target cwd via the install report', async () => {
    writeFileSync(configPath, 'model = "x"\n[projects."/work/foo"]\ntrust_level = "untrusted"\n');
    const report = await codexLifecycleInstaller({
      configPath,
      baseCommand: 'abs hook',
      projectCwd: '/work/foo',
    }).install();
    expect(report.trustWarning).toMatch(/trust/i);
  });

  it('omits the trust warning when the target cwd is trusted', async () => {
    writeFileSync(configPath, 'model = "x"\n[projects."/work/foo"]\ntrust_level = "trusted"\n');
    const report = await codexLifecycleInstaller({
      configPath,
      baseCommand: 'abs hook',
      projectCwd: '/work/foo',
    }).install();
    expect(report.trustWarning).toBeUndefined();
  });

  // --- W-NEW-2: trust check runs against a REAL cwd row present in the real-config fixture ---
  it('resolves trust against the real-config fixture using a path that actually exists in it', async () => {
    const fixture = readFileSync(FIXTURE, 'utf8');
    writeFileSync(configPath, fixture);
    const m = fixture.match(/\[projects\.("[^"]+")\]\s*\n(?:[^[]*?)trust_level\s*=\s*"(\w+)"/);
    expect(m).not.toBeNull();
    const realCwd = JSON.parse((m as RegExpMatchArray)[1]) as string;
    const realTrust = (m as RegExpMatchArray)[2];
    const report = await codexLifecycleInstaller({
      configPath,
      baseCommand: 'abs hook',
      projectCwd: realCwd,
    }).install();
    if (realTrust === 'trusted') expect(report.trustWarning).toBeUndefined();
    else expect(report.trustWarning).toMatch(/trust/i);
  });
});
