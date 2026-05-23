/** All monetary amounts in this codebase are integer cents — never floats. */
export type Cents = number;

export function formatCents(amount: Cents): string {
  if (!Number.isInteger(amount)) throw new Error('amount must be integer cents');
  return `$${(amount / 100).toFixed(2)}`;
}
