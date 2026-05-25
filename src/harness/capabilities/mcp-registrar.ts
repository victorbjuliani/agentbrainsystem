// src/harness/capabilities/mcp-registrar.ts
import { registerMcpServer } from '../../cli/setup.js';
import type { McpRegisterStatus, RunFn } from '../types.js';

export interface McpRegistrar {
  register(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
}

export interface CliMcpRegistrarOptions {
  /** CLI binary that owns `mcp add/list/remove` (defaults to 'claude'). */
  binary?: string;
  /** Gemini rejects the `--` separator; it needs positional args + an explicit scope (#68). */
  argStyle?: 'separator' | 'positional';
  /** Scope for the positional style (`--scope user|project`); positional only. */
  scope?: 'user' | 'project';
  /** Harness id baked into the launch command as `start --harness <id>` (#109). */
  harnessId?: string;
}

/** MCP registrar for CLI-driven harnesses (`<cli> mcp add ...`). */
export function cliMcpRegistrar(options: CliMcpRegistrarOptions = {}): McpRegistrar {
  return {
    register: async (cliPath, run) => {
      const result = await registerMcpServer(cliPath, run, {
        binary: options.binary,
        argStyle: options.argStyle,
        scope: options.scope,
        harnessId: options.harnessId,
      });
      if (result.status === 'no-claude') {
        return { status: 'unavailable', manualCommand: result.manualCommand };
      }
      return result;
    },
  };
}
