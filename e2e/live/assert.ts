/** Pure assertions over parsed stream events. No spawn, no I/O. */

export interface AssertResult {
  ok: boolean;
  missing: string[];
}

const FENCE_OPEN = '<recalled-memory>';
const FENCE_CLOSE = '</recalled-memory>';

/**
 * Deterministic injection gate: the UserPromptSubmit additionalContext must exist, carry
 * the recalled-memory fence, and the fenced block must match every required pattern.
 */
export function assertInjection(
  injection: string | undefined,
  required: readonly RegExp[],
): AssertResult {
  if (!injection?.includes(FENCE_OPEN)) {
    return { ok: false, missing: ['<no recalled-memory injection>'] };
  }
  const start = injection.indexOf(FENCE_OPEN) + FENCE_OPEN.length;
  const end = injection.indexOf(FENCE_CLOSE);
  const fenced = end > start ? injection.slice(start, end) : injection.slice(start);
  const missing = required.filter((re) => !re.test(fenced)).map(String);
  return { ok: missing.length === 0, missing };
}

/** Behavioral check: the model's answer must satisfy every keyword pattern. */
export function assertBehavioral(answer: string, required: readonly RegExp[]): AssertResult {
  const missing = required.filter((re) => !re.test(answer)).map(String);
  return { ok: missing.length === 0, missing };
}
