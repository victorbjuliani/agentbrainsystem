// src/harness/index.ts
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexAdapter } from './adapters/codex.js';
import { copilotAdapter } from './adapters/copilot.js';
import { geminiAdapter } from './adapters/gemini.js';
import { createRegistry, type HarnessRegistry } from './registry.js';

let cached: HarnessRegistry | null = null;

/** The process-wide registry of known harness adapters. */
export function defaultRegistry(): HarnessRegistry {
  if (!cached)
    cached = createRegistry([
      claudeCodeAdapter(),
      codexAdapter(),
      geminiAdapter(),
      copilotAdapter(),
    ]);
  return cached;
}

export * from './types.js';
