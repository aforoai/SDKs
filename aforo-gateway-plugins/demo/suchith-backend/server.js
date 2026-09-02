/*
 * Suchith's backend — the API being metered.
 *
 * The point of this file is how LITTLE it does. There is no JWT parsing, no
 * signature check, no usage tracking, no call to Aforo. Kong verified the
 * token's RS256 signature before proxying and injected the verified identity
 * as headers; Kong's log phase reports the usage event afterwards. Suchith's
 * job is to serve the request.
 *
 * The headers below are trustworthy ONLY because Kong overwrites them from
 * validated JWT claims on every request (handler.lua sets them in the access
 * phase). Never trust them on a port a client can reach directly -- bind this
 * service to the Kong network only.
 */
const express = require('express');

const app = express();
app.use(express.json());

// Demo convenience so the static frontend can call through Kong from :3000.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PRODUCTS = [
  { id: 'p1', name: 'SMS Starter',    priceUsd: 9,  description: '1,000 SMS / month' },
  { id: 'p2', name: 'SMS Growth',     priceUsd: 49, description: '10,000 SMS / month' },
  { id: 'p3', name: 'SMS Enterprise', priceUsd: 199, description: 'Unlimited SMS, priority routing' },
];

const orders = new Map();
let orderSeq = 1000;

/** Identity Kong resolved from the verified JWT. No parsing needed here. */
function caller(req) {
  return {
    customerId: req.get('X-Customer-Id') || null,
    tenantId:   req.get('X-Tenant-Id')   || null,
    keyId:      req.get('X-Key-Id')      || null,
    scopes:     req.get('X-Scopes')      || null,
  };
}

app.get('/api/products', (req, res) => {
  res.json({ products: PRODUCTS, servedTo: caller(req) });
});

app.get('/api/products/:id', (req, res) => {
  const product = PRODUCTS.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'product_not_found', id: req.params.id });
  res.json({ product, servedTo: caller(req) });
});

app.post('/api/orders', (req, res) => {
  const { productId, quantity } = req.body || {};
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return res.status(400).json({ error: 'unknown_product', productId });

  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const who = caller(req);
  const order = {
    id: `ord_${orderSeq++}`,
    productId,
    productName: product.name,
    quantity: qty,
    totalUsd: product.priceUsd * qty,
    customerId: who.customerId,
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  res.status(201).json({ order, servedTo: who });
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found', id: req.params.id });
  res.json({ order, servedTo: caller(req) });
});

// Excluded from metering by the plugin's exclude_paths default.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => console.log(`[suchith-backend] listening on :${PORT}`));
