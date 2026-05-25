// src/harness/adapters/copilot.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { copilotLifecycleInstaller } from '../capabilities/copilot-lifecycle-installer.js';
import { cliMcpRegistrar } from '../capabilities/mcp-registrar.js';
import { payloadFirstResolver } from '../capabilities/session-resolver.js';
import type { HarnessAdapter } from '../types.js';

/**
 * GitHub Copilot CLI adapter (#69) — fourth qualifying harness. FLAT JSON
 * `~/.copilot/hooks.json` hooks with Copilot's SDK event names (Task 3 installer),
 * separator-style `copilot mcp add … -- node <cli> start` (the `--` IS accepted,
 * so the DEFAULT registrar — byte-identical to Claude/Codex), and an append-mostly
 * `events.jsonl` byte-cursor transcript with a compaction/fork re-sync guard
 * (Task 4/5). PAYLOAD-ONLY session resolver: Copilot exposes no session-id env
 * var (the id is the session-state dir UUID / hook payload `session_id`), so no
 * Claude-style env leaks into resolution. Copilot HAS sessionEnd (capture), unlike
 * Codex's Stop.
 *
 * Detection mirrors Codex/Gemini: `access(~/.copilot)` (created on first launch).
 */
export function copilotAdapter(): HarnessAdapter {
  const resolve = payloadFirstResolver(); // payload/path-only — no COPILOT_* session-id env
  const installer = copilotLifecycleInstaller();
  // DEFAULT separator style: `copilot mcp add agentbrainsystem -- node <cli> start`.
  const registrar = cliMcpRegistrar({ binary: 'copilot', harnessId: 'copilot' });
  return {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    mcpBinary: 'copilot',
    detect: async () => {
      try {
        await access(join(homedir(), '.copilot'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }),
    eventMap: {
      capture: ['SessionEnd'], // Copilot HAS sessionEnd (unlike Codex)
      recall: ['SessionStart', 'UserPromptSubmit'],
      guard: ['PreToolUse'],
    },
    install: (_cliPath) => installer.install(),
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath, run) => registrar.register(cliPath, run),
    resolveSession: (input) => resolve(input),
  };
}
