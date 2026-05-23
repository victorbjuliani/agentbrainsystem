import { createServer } from 'node:http';
import { createOrder, type Order } from './order.js';

const orders = new Map<string, Order>();

/** Minimal checkout API: create an order, then charge it. */
export const server = createServer((req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/, '');
  if (!token) {
    res.writeHead(401).end('missing token');
    return;
  }
  if (req.method === 'POST' && req.url === '/orders') {
    const order = createOrder(crypto.randomUUID(), 0, 'USD');
    orders.set(order.id, order);
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(order));
    return;
  }
  res.writeHead(404).end('not found');
});
