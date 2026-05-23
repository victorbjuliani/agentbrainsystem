export interface Order {
  id: string;
  amount: number;
  currency: string;
}

export function createOrder(id: string, amount: number, currency = 'USD'): Order {
  return { id, amount, currency };
}
