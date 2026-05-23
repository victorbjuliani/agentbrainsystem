// src/harness/capabilities/context-injector.ts
import { buildContextOutput, type HookEvent } from '../../hooks/payload.js';

export interface ContextInjector {
  render(event: HookEvent, text: string): string | null;
}

/** Injector for harnesses that read a `hookSpecificOutput.additionalContext` stdout line. */
export function stdoutInjector(): ContextInjector {
  return { render: (event, text) => buildContextOutput(event, text) };
}
