// src/harness/capabilities/session-resolver.ts
import type { ResolveInput, SessionIdentity } from '../types.js';

export interface SessionResolverOptions {
  /** Adapter-specific env var carrying the session id (e.g. Claude Code). */
  envVar?: string;
}

/** Build a resolver that prefers the hook payload, then an optional env var. */
export function payloadFirstResolver(
  options: SessionResolverOptions = {},
): (input: ResolveInput) => SessionIdentity | null {
  return (input) => {
    const fromPayload = input.payload?.sessionId;
    if (fromPayload) {
      const id: SessionIdentity = { sessionId: fromPayload };
      if (input.payload?.transcriptPath) id.transcriptPath = input.payload.transcriptPath;
      return id;
    }
    if (options.envVar) {
      const fromEnv = input.env?.[options.envVar];
      if (fromEnv) return { sessionId: fromEnv };
    }
    return null;
  };
}
