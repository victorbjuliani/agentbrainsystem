/**
 * Session A drives the model to ARTICULATE AND COMMIT the decisions in its reply,
 * so the captured assistant turns carry them (recall then feels organic, not a
 * pre-stated user line). Session B is a natural follow-up whose correct answer
 * depends on Session A's decisions.
 */
export const SESSION_A_PROMPT =
  'You are working on this checkout-api. We just resolved two things — state each as a ' +
  'clear, committed decision in your reply, with the reason: (1) store all monetary ' +
  'amounts as integer cents, never floats, because a float rounding bug hit us in ' +
  'production; (2) keep the session token in an httpOnly cookie, never localStorage, to ' +
  'limit XSS exposure. Confirm both decisions in your own words.';

export const SESSION_B_PROMPT =
  "I'm adding a refund endpoint to this payments API. How should I represent the refund " +
  'amount in code, and where should the auth token live?';

/** Keyword-sets the WITH-memory answer must satisfy (tolerant of phrasing). */
export const EXPECTED_KEYWORDS = {
  money: [/cent/i, /integer/i],
  token: [/httponly/i, /cookie/i],
} as const;
