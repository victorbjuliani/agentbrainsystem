// src/harness/capabilities/mcp-registrar.ts
import { registerMcpServer } from '../../cli/setup.js';
import type { McpRegisterStatus, RunFn } from '../types.js';

export interface McpRegistrar {
  register(cliPath: string, run: RunFn): Promise<McpRegisterStatus>;
}

/** MCP registrar for CLI-driven harnesses (`<cli> mcp add ...`). */
export function cliMcpRegistrar(): McpRegistrar {
  return {
    register: async (cliPath, run) => {
      const result = await registerMcpServer(cliPath, run);
      if (result.status === 'no-claude') {
        return { status: 'unavailable', manualCommand: result.manualCommand };
      }
      return result;
    },
  };
}
