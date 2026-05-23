// src/harness/adapters/claude-code.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookEvent } from '../../hooks/payload.js';
import { settingsFileInstaller } from '../capabilities/lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

const CLAUDE_EVENTS: readonly HookEvent[] = [
  'SessionEnd',
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
];

export function claudeCodeAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver({ envVar: 'CLAUDE_CODE_SESSION_ID' });
  const installer = settingsFileInstaller({ events: CLAUDE_EVENTS });
  const registrar = cliMcpRegistrar();
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    mcpBinary: 'claude', // C2: regression-safe — the implicit default at the call site
    detect: async () => {
      try {
        await access(join(homedir(), '.claude'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['SessionEnd'],
      recall: ['SessionStart', 'UserPromptSubmit'],
      guard: ['PreToolUse'],
    },
    install: (_cliPath) => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
