// src/harness/adapters/codex.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexLifecycleInstaller } from '../capabilities/codex-lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

/**
 * Codex CLI adapter (#67) — the second qualifying harness behind the Phase-0
 * contract. Composes the TOML `[hooks]` installer (Task 3), the codex-binary MCP
 * registrar (Task 2), and a PAYLOAD-ONLY session resolver: Codex exposes no
 * session-id env var (no `CODEX_*` analog of `CLAUDE_CODE_SESSION_ID`), so a
 * Claude-style env never leaks into Codex resolution. `Stop` is capture (Codex has
 * NO `SessionEnd`).
 */
export function codexAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver(); // payload-only — Codex has no session-id env var
  // W3: pass the current working dir so install() can warn when the target project
  // is not a trusted Codex project (Codex silently skips managed hooks otherwise).
  const installer = codexLifecycleInstaller({ projectCwd: process.cwd() });
  const registrar = cliMcpRegistrar({ binary: 'codex', harnessId: 'codex' });
  return {
    id: 'codex',
    displayName: 'Codex CLI',
    mcpBinary: 'codex', // C2: cmdUninstall routes MCP unregister to this binary
    detect: async () => {
      try {
        await access(join(homedir(), '.codex'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['Stop'], // Codex has NO SessionEnd
      recall: ['SessionStart', 'UserPromptSubmit'],
      guard: ['PreToolUse'],
    },
    install: (_cliPath) => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
