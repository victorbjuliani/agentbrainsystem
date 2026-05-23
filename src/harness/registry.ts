// src/harness/registry.ts
import type { HarnessAdapter } from './types.js';

export interface HarnessRegistry {
  all(): readonly HarnessAdapter[];
  byId(id: string): HarnessAdapter | undefined;
  detectInstalled(): Promise<HarnessAdapter[]>;
}

export function createRegistry(adapters: readonly HarnessAdapter[]): HarnessRegistry {
  const byIdMap = new Map(adapters.map((a) => [a.id, a]));
  return {
    all: () => adapters,
    byId: (id) => byIdMap.get(id),
    detectInstalled: async () => {
      const flags = await Promise.all(adapters.map((a) => a.detect().catch(() => false)));
      return adapters.filter((_, i) => flags[i]);
    },
  };
}
