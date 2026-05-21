/**
 * The graceful-degradation adapter: always unavailable, every lookup is null.
 * Selected when no code-review-graph is present (local-first / offline default).
 * Consumers that get null fall back to `claimed` facts and warn-only guards.
 */
import type { GroundTruthProvider, ResolvedSymbol } from './types.js';

export class NullGroundTruthProvider implements GroundTruthProvider {
  isAvailable(): boolean {
    return false;
  }

  resolveSymbol(_name: string, _opts?: { filePath?: string }): ResolvedSymbol | null {
    return null;
  }

  resolveFile(_filePath: string): ResolvedSymbol | null {
    return null;
  }

  close(): void {
    // nothing to release
  }
}
