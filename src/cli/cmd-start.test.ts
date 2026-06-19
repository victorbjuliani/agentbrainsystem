import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two collaborators cmdStart wires together so we can assert the contract
// WITHOUT actually launching the JSON-RPC server or touching ~/.claude. vi.hoisted
// lets the mock factories reference these spies despite vi.mock being hoisted.
const { startStdio, selfHealClaudeCodeHooks } = vi.hoisted(() => ({
  startStdio: vi.fn(() => Promise.resolve()),
  selfHealClaudeCodeHooks: vi.fn(),
}));
vi.mock('../mcp/index.js', () => ({ startStdio }));
vi.mock('../hooks/self-heal.js', () => ({ selfHealClaudeCodeHooks }));

import { cmdStart } from './cli.js';

describe('cmdStart — harness-gated self-heal wiring (MCP startup contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bare `abs start` passes no harness through (self-heal skips) and starts stdio', async () => {
    await cmdStart([]);
    // Self-heal is invoked with an absent harness — its own gate then makes it a no-op
    // (the real-HOME-safe path; covered exhaustively in self-heal.test.ts).
    expect(selfHealClaudeCodeHooks).toHaveBeenCalledTimes(1);
    expect(selfHealClaudeCodeHooks).toHaveBeenCalledWith({ harness: undefined });
    expect(startStdio).toHaveBeenCalledWith(undefined);
  });

  it('`start --harness claude-code` threads the harness through and heals BEFORE stdio', async () => {
    const order: string[] = [];
    selfHealClaudeCodeHooks.mockImplementation(() => {
      order.push('heal');
    });
    startStdio.mockImplementation(() => {
      order.push('stdio');
      return Promise.resolve();
    });

    await cmdStart(['--harness', 'claude-code']);

    expect(selfHealClaudeCodeHooks).toHaveBeenCalledWith({ harness: 'claude-code' });
    expect(startStdio).toHaveBeenCalledWith('claude-code');
    // The heal must run before the server takes over stdout for JSON-RPC.
    expect(order).toEqual(['heal', 'stdio']);
  });
});
