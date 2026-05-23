import type { Order } from './order.js';

export interface ChargeResult {
  ok: boolean;
  providerRef?: string;
}

/** Charge an order through the payment provider. Throws on network/timeout errors. */
export async function charge(order: Order): Promise<ChargeResult> {
  const res = await fetch('https://provider.example/charge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: order.id, amount: order.amount, currency: order.currency }),
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { ref: string };
  return { ok: true, providerRef: body.ref };
}
