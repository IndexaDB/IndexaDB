// test/api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createApi } from '../src/api.js';

const cfg = {
  name: 'test-api',
  schema: { Order: { id: 'ID', customer: 'String', total: 'BigDecimal', status: 'String', items: 'Int' } },
};

let store, server, base;
const get = (path, opts) => fetch(base + path, opts);

before(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ix-api-')), 'a.db');
  store = createStore({ type: 'sqlite', path: dbPath });
  await store.init(cfg.schema);
  const seed = [
    { id: '1', customer: 'Alice', total: '120.50', status: 'paid', items: 3 },
    { id: '2', customer: 'Bob', total: '80.00', status: 'pending', items: 1 },
    { id: '3', customer: 'Alice', total: '42.25', status: 'paid', items: 2 },
    { id: '4', customer: 'Carol', total: '300.00', status: 'paid', items: 5 },
  ];
  for (const o of seed) await store.upsert('Order', o.id, o);
  server = createApi(store, cfg);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => { server.close(); await store.close(); });

test('GET / returns metadata', async () => {
  const body = await (await get('/')).json();
  assert.equal(body.app, 'test-api');
  assert.deepEqual(body.entities, ['Order']);
  assert.ok(body.schema.Order);
});

test('GET /_health reports checkpoints and uptime', async () => {
  const res = await get('/_health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(Array.isArray(body.checkpoints));
});

test('GET /<entity> lists with count + total', async () => {
  const body = await (await get('/orders')).json();
  assert.equal(body.count, 4);
  assert.equal(body.total, 4);
  assert.equal(body.data.length, 4);
});

test('equality filter', async () => {
  const body = await (await get('/orders?status=paid')).json();
  assert.equal(body.count, 3);
});

test('comparison + in + like filters over HTTP', async () => {
  assert.equal((await (await get('/orders?items_gte=3')).json()).count, 2);
  assert.equal((await (await get('/orders?status_in=paid,pending')).json()).count, 4);
  assert.equal((await (await get('/orders?customer_like=Al%25')).json()).count, 2);
});

test('pagination: total reflects full set, count reflects page', async () => {
  const body = await (await get('/orders?limit=2&orderBy=items&desc=true')).json();
  assert.equal(body.count, 2);
  assert.equal(body.total, 4);
  assert.equal(body.limit, 2);
  assert.deepEqual(body.data.map((r) => r.id), ['4', '1']);
});

test('GET /<entity>/:id', async () => {
  const body = await (await get('/orders/1')).json();
  assert.equal(body.customer, 'Alice');
  const missing = await get('/orders/999');
  assert.equal(missing.status, 404);
});

test('invalid orderBy -> 400', async () => {
  const res = await get('/orders?orderBy=DROP');
  assert.equal(res.status, 400);
});

test('unknown entity -> 404', async () => {
  const res = await get('/widgets');
  assert.equal(res.status, 404);
});

test('non-GET method -> 405', async () => {
  const res = await get('/orders', { method: 'POST' });
  assert.equal(res.status, 405);
});

test('CORS preflight -> 204 with headers', async () => {
  const res = await get('/orders', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('plural/singular + case-insensitive entity resolution', async () => {
  assert.equal((await get('/Order')).status, 200);
  assert.equal((await get('/ORDERS')).status, 200);
});
