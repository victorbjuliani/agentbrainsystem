// src/harness/adapters/gemini.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { geminiLifecycleInstaller } from '../capabilities/gemini-lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

/**
 * Gemini CLI adapter (#68) — third qualifying harness. JSON settings.json hooks
 * with Gemini event names (Task 3 installer), positional `gemini mcp add` (no `--`,
 * Task 5), single-JSON whole-file transcript with an id-anchored rewind-safe
 * watermark (Task 4). PAYLOAD-ONLY session resolver: Gemini exposes no session-id
 * env var, so no Claude-style env leaks into resolution. Gemini HAS SessionEnd
 * (capture), unlike Codex.
 *
 * Known low-risk gap (documented, not fixed here): `harnessForPayload` keys off
 * `transcript_path`. An early SessionStart/BeforeTool payload MAY carry an empty
 * path (the recorder file is created lazily) → the chokepoint defaults to bare
 * claude-code for THAT recall/guard. Capture (SessionEnd) always has a populated
 * path, so STORED observations are always correctly `gemini:`-namespaced.
 */
export function geminiAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver(); // payload-only — no GEMINI_* session-id env
  const installer = geminiLifecycleInstaller();
  const registrar = cliMcpRegistrar({
    binary: 'gemini',
    argStyle: 'positional',
    scope: 'user',
    harnessId: 'gemini',
  });
  return {
    id: 'gemini',
    displayName: 'Gemini CLI',
    mcpBinary: 'gemini',
    mcpArgStyle: 'positional', // Gemini rejects `--`; registers/removes with --scope (#68)
    mcpScope: 'user', // user-scoped add → uninstall must remove with --scope user (#87)
    detect: async () => {
      try {
        await access(join(homedir(), '.gemini'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['SessionEnd'], // Gemini HAS SessionEnd (unlike Codex)
      recall: ['SessionStart', 'BeforeAgent'],
      guard: ['BeforeTool'],
    },
    install: (_cliPath) => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
