/**
 * OpenCode adapter tests (#72, Task 5). Covers the adapter shape + detect/resolve,
 * the file-only MCP registrar (idempotent, never-clobber, C1 JSONC abort, C1
 * precedence, C2 threaded path), and the Wnew collision-proof backup over the real
 * two-edit `cmdSetup` ordering (registerMcp THEN install).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opencodePluginInstaller } from '../capabilities/opencode-plugin-installer.js';
import { opencodeAdapter } from './opencode.js';

const CLI = '/usr/local/lib/node_modules/agentbrainsystem/dist/cli/cli.js';

describe('opencodeAdapter (#72)', () => {
  it('(a) id / displayName / eventMap shape', () => {
    const a = opencodeAdapter();
    expect(a.id).toBe('opencode');
    expect(a.displayName).toBe('OpenCode');
    expect(a.mcpBinary).toBe('opencode');
    expect(a.eventMap.capture).toEqual(['session.idle', 'session.compacted']);
    expect(a.eventMap.recall).toEqual(['experimental.chat.system.transform']);
    expect(a.eventMap.guard).toEqual(['session.deleted']);
  });

  it('(b) qualifies() ok', () => {
    expect(opencodeAdapter().qualifies()).toEqual({ ok: true, missing: [] });
  });

  it('(c) detect() true when ~/.config/opencode exists, false otherwise (temp HOME)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'abs-oc-detect-'));
    const prev = process.env.HOME;
    try {
      process.env.HOME = home;
      expect(await opencodeAdapter().detect()).toBe(false);
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      expect(await opencodeAdapter().detect()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('(d) resolveSession returns {sessionId} from payload, null without', () => {
    const a = opencodeAdapter();
    expect(a.resolveSession({ payload: { sessionId: 'ses_x' } })).toEqual({ sessionId: 'ses_x' });
    expect(a.resolveSession({ payload: {} })).toBeNull();
    expect(a.resolveSession({})).toBeNull();
  });
});

describe('opencode registerMcp (file-only, #72)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'abs-oc-mcp-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const read = (name = 'opencode.json') => readFileSync(join(dir, name), 'utf8');

  it('(e) writes mcp.agentbrainsystem into a plain opencode.json; idempotent; never clobbers a foreign entry', async () => {
    const installer = opencodePluginInstaller({ configDir: dir });
    const first = await installer.registerMcp(CLI);
    expect(first.status).toBe('registered');
    const parsed = JSON.parse(read());
    expect(parsed.mcp.agentbrainsystem).toEqual({
      type: 'local',
      command: ['node', CLI, 'start'],
      enabled: true,
    });
    const second = await installer.registerMcp(CLI);
    expect(second.status).toBe('already'); // idempotent

    // Foreign entry under the same key → leave it, report 'already', never overwrite.
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify({ mcp: { agentbrainsystem: { type: 'local', command: ['foreign'] } } }, null, 2)}\n`,
    );
    const third = await installer.registerMcp(CLI);
    expect(third.status).toBe('already');
    expect(JSON.parse(read()).mcp.agentbrainsystem.command).toEqual(['foreign']);
  });

  it('(f) C1 — registerMcp against a JSONC .json (comment) → error/manual, config byte-unchanged, snippet has mcp entry', async () => {
    const jsonc = '{\n  // user comment\n  "theme": "dark",\n}\n';
    writeFileSync(join(dir, 'opencode.json'), jsonc);
    const installer = opencodePluginInstaller({ configDir: dir });
    const reg = await installer.registerMcp(CLI);
    expect(reg.status).toBe('error');
    expect(read()).toBe(jsonc); // byte-unchanged
    if (reg.status === 'error') expect(reg.manualCommand).toContain('agentbrainsystem');
  });

  it('(g) C1 — when opencode.jsonc exists, registerMcp targets it (not .json)', async () => {
    writeFileSync(join(dir, 'opencode.jsonc'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
    const installer = opencodePluginInstaller({ configDir: dir });
    await installer.registerMcp(CLI);
    expect(JSON.parse(read('opencode.jsonc')).mcp.agentbrainsystem).toBeDefined();
    expect(() => read('opencode.json')).toThrow(); // no sibling .json created
  });

  it('(h) Wnew — backup not clobbered by the two-edit setup (registerMcp THEN install)', async () => {
    const original = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`;
    writeFileSync(join(dir, 'opencode.json'), original);
    const installer = opencodePluginInstaller({ configDir: dir });
    // Drive the real cmdSetup ordering: registerMcp first, then install.
    await installer.registerMcp(CLI);
    await installer.install(CLI);
    // The live file has BOTH the mcp entry and the plugin[] entry.
    const live = JSON.parse(read());
    expect(live.mcp.agentbrainsystem).toBeDefined();
    expect(live.plugin).toEqual(['./plugin/agentbrainsystem.js']);
    expect(live.theme).toBe('dark');
    // At least one .bak equals the ORIGINAL pre-setup config (first backup survived).
    const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    const bakContents = baks.map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(bakContents).toContain(original);
  });

  it('(i) C2 — registerMcp bakes the threaded cliPath (command = ["node", cliPath, "start"])', async () => {
    const installer = opencodePluginInstaller({ configDir: dir });
    await installer.registerMcp(CLI);
    const cmd = JSON.parse(read()).mcp.agentbrainsystem.command;
    expect(cmd).toEqual(['node', CLI, 'start']);
    expect(cmd).not.toContain('abs'); // NOT bare abs
  });
});
