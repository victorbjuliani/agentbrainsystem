// src/harness/adapters/opencode.ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { opencodePluginInstaller } from '../capabilities/opencode-plugin-installer.js';
import type { HarnessAdapter } from '../types.js';

/**
 * OpenCode adapter (#72) — the FIFTH and most architecturally divergent harness.
 *
 * Unlike every prior adapter (a shell-hook harness reading a per-session transcript
 * FILE), OpenCode captures + recalls INSIDE its own Bun process via an in-process
 * plugin module, and its history lives in a relational SQLite store
 * (~/.local/share/opencode/opencode.db), NOT a JSONL/JSON transcript file. So this
 * adapter wires NO `abs hook` commands; instead its `install(cliPath)` writes a
 * plugin file that SHELLS the absolute `node <cli.js> opencode-capture/recall`
 * (C2 — the cliPath is threaded so the baked path can't depend on PATH).
 *
 * MCP registration is FILE-ONLY (Break #4): `opencode mcp add` is an interactive
 * wizard (no positional/flag args), so the `cliMcpRegistrar` pattern would hang on
 * stdin. `registerMcp` writes `config.mcp.agentbrainsystem` into the resolved config
 * via the same JSONC-safe `editOpencodeConfig` helper (`run` is ignored — the
 * contract abstracts INTENT, not mechanism). Config is JSONC: a plain-JSON config
 * merges in place; a JSONC config aborts to a printed manual snippet, never clobbered.
 *
 * Detection mirrors gemini/copilot exactly (`access(~/.config/opencode)`; there is
 * NO `onPath` helper in this codebase, N1). `resolveSession` is id-only — opencode
 * has no transcript path and no session-id env var.
 */
export function opencodeAdapter(): HarnessAdapter {
  const installer = opencodePluginInstaller();
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    mcpBinary: 'opencode', // messaging only; MCP is file-written, not CLI
    mcpFileManaged: true, // both register + unregister are file edits — skip the CLI mcp path
    detect: async () => {
      try {
        await access(join(homedir(), '.config', 'opencode'));
        return true;
      } catch {
        return false;
      }
    },
    qualifies: () => ({ ok: true, missing: [] }), // all four pillars verified (ADR-0011)
    eventMap: {
      capture: ['session.idle', 'session.compacted'], // settle + flush-before-compact
      recall: ['experimental.chat.system.transform'], // native per-turn system inject
      guard: ['session.deleted'], // tombstone guard (in-plugin)
    },
    install: (cliPath) => installer.install(cliPath), // C2: thread cliPath → baked absolute node <cli.js>
    uninstall: () => installer.uninstall(),
    registerMcp: (cliPath) => installer.registerMcp(cliPath), // C2: same path → mcp.command ["node", cliPath, "start"]
    resolveSession: (input) =>
      input.payload?.sessionId ? { sessionId: input.payload.sessionId } : null,
  };
}
