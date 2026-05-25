/**
 * Output-side neutralization of recalled-memory fence tokens (#110).
 *
 * Recalled observation content is wrapped in a `<recalled-memory>…</recalled-memory>`
 * (and `<recalled-decisions>…`) DATA envelope and injected into the agent via the hook
 * `additionalContext`. The content is attacker-influenceable (a malicious repo file the
 * agent quoted, or a poisoned shared/global brain), and a literal `</recalled-memory>`
 * inside an observation would structurally CLOSE the envelope early — trailing bytes are
 * then read as top-level instructions (prompt injection). fp-check verdict: TRUE POSITIVE
 * (MEDIUM). The prose "this is DATA" header alone does not stop it.
 *
 * The fix is at the OUTPUT layer (not ingest): both hook sinks pass observation content
 * through {@link neutralizeFenceTokens} before embedding it, so the envelope can never be
 * closed early. A zero-width space after the `<` breaks tag recognition while rendering
 * identically to a human; benign content (no fence token) is returned byte-identical.
 */

/** The DATA-envelope tokens an injected observation could spoof — both families, both forms. */
const FENCE_TOKEN = /<(\/?)(recalled-memory|recalled-decisions)>/gi;

/** Zero-width space inserted after `<` to defang a spoofed fence token (renders invisibly). */
const ZWSP = String.fromCharCode(0x200b);

/**
 * Defang any recalled-* fence token embedded in `content` so it cannot close (or reopen)
 * the DATA envelope. Applied at every sink that injects recalled content. Idempotent and
 * a no-op on content without a fence token.
 */
export function neutralizeFenceTokens(content: string): string {
  return content.replace(FENCE_TOKEN, `<${ZWSP}$1$2>`);
}
