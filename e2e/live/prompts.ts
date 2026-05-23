/**
 * The seeded decision is realistic, tangible, and COUNTERINTUITIVE: "never auto-retry a
 * failed charge." Retry-with-backoff is the reflexive resilience pattern any agent reaches
 * for — but for a non-idempotent charge a gateway timeout often means the charge SUCCEEDED,
 * so retrying double-charges the customer. A memory-less session confidently adds the retry;
 * with memory the agent refuses and cites the production double-charge. The divergence shows
 * up as opposite stances on the user's proposal, which is the whole point of the demo.
 */
export const SESSION_A_PROMPT =
  'Hard rule for this checkout-api, note it: we NEVER auto-retry a failed charge — a gateway ' +
  'timeout or 5xx usually means the charge actually went through but we lost the response, so ' +
  'retrying double-charged real customers in production; on any charge failure we reconcile ' +
  "against the provider's status API before doing anything else.";

export const SESSION_B_PROMPT =
  "The charge call to our payment provider sometimes times out. I'm going to wrap it in a " +
  'retry with exponential backoff (3 attempts) so payments are more reliable — sound good, ' +
  'and where should I add the retry?';

/** Keyword-sets (tolerant of phrasing). `assertBehavioral`/`assertInjection` require ALL. */
export const EXPECTED_KEYWORDS = {
  /** Must appear in the recalled-memory fence (the seeded decision, verbatim). */
  injection: [/retr/i, /double/i],
  /** The WITH answer must adopt the recalled rule (no retry / reconcile), not the proposal. */
  behavioralCore: [
    /reconcil|never retry|don'?t retry|status (?:api|endpoint|check)|already (?:charged|went through|succeeded)/i,
  ],
  /** Corroborating rationale (soft — phrasing-dependent). */
  rationale: [/double|production|\bprod\b|lost the response|timed? ?out/i],
} as const;
