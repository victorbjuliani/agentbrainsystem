import type { Cents } from './money.js';

export interface Order {
  id: string;
  /** Total in integer cents. */
  totalCents: Cents;
}

export function createOrder(id: string, totalCents: Cents): Order {
  if (!Number.isInteger(totalCents)) throw new Error('totalCents must be integer cents');
  return { id, totalCents };
}
