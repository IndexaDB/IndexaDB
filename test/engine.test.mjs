// test/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { registerConnector } from '../src/registry.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('test');

// In-memory connector serving rows from cfg.source.data[streamKey]. Mutating the
// array after streams() lets us simulate new rows arriving (live tail).
class MockConnector {
  async init(cfg) { this.data = cfg.data; }
  async streams() {
    return Object.entries(this.data).map(([key, rows]) => ({
      key,
      fetchBatch: async (fromCursor, limit) => {
        const from = fromCursor != null ? Number(fromCursor) : 0;
        const remaining = rows.filter((r) => Number(r.cursor) > from);
        const batch = remaining.slice(0, limit);
        return { records: batch, done: batch.length >= remaining.length };
      },
    }));
  }
  async close() {}
}
registerConnector('mock', MockConnector);

function dbPath(tag) { return join(mkdtempSync(join(tmpdir(), `ix-eng-${tag}-`)), 'e.db'); }

test('backfill auto-maps columns to entities and coerces types (no handler)', async () => {
  const rows = [
    { cursor: 1, data: { id: '1', customer: 'Alice', total: '10.5', status: 'paid', items: '3', active: 'true' } },
    { cursor: 2, data: { id: '2', customer: 'Bob', total: '20', status: 'pending', items: '1', active: 'false' } },
  ];
  const cfg = {
    __dir: tmpdir(), name: 'eng', batchSize: 500, pollIntervalMs: 0,
    source: { type: 'mock', data: { orders: rows } },
    target: { type: 'sqlite', path: dbPath('map') },
    schema: { Order: { id: 'ID', customer: 'String', total: 'BigDecimal', status: 'String', items: 'Int', active: 'Boolean' } },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();
  await engine.backfill();

  const all = await engine.store.query('Order', {});
  assert.equal(all.length, 2);
  const o1 = await engine.store.get('Order', '1');
  assert.strictEqual(o1.items, 3);          // Int coerced
  assert.strictEqual(o1.active, true);       // Boolean coerced
  assert.equal(await engine.store.getCheckpoint('orders'), '2');
  await engine.close();
});

test('checkpoint makes backfill idempotent and resumable', async () => {
  const rows = [{ cursor: 1, data: { id: '1', customer: 'Alice', total: '10' } }];
  const cfg = {
    __dir: tmpdir(), name: 'eng', batchSize: 500, pollIntervalMs: 0,
    source: { type: 'mock', data: { orders: rows } },
    target: { type: 'sqlite', path: dbPath('resume') },
    schema: { Order: { id: 'ID', customer: 'String', total: 'BigDecimal' } },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();
  await engine.backfill();
  assert.equal((await engine.store.query('Order', {})).length, 1);

  // Re-running with no new rows must not duplicate.
  await engine.backfill();
  assert.equal((await engine.store.query('Order', {})).length, 1);

  // New rows arrive -> only they are processed.
  rows.push({ cursor: 2, data: { id: '2', customer: 'Bob', total: '20' } });
  rows.push({ cursor: 3, data: { id: '3', customer: 'Carol', total: '30' } });
  await engine.backfill();
  assert.equal((await engine.store.query('Order', {})).length, 3);
  assert.equal(await engine.store.getCheckpoint('orders'), '3');
  await engine.close();
});

test('handler performs read-modify-write aggregation exactly once per row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ix-eng-handler-'));
  writeFileSync(join(dir, 'handlers.js'), `export default {
    async orders(row, ctx) {
      await ctx.store.upsert('Order', row.id, { id: row.id, customer: row.customer, total: row.total });
      const c = await ctx.store.get('Customer', row.customer);
      await ctx.store.upsert('Customer', row.customer, {
        id: row.customer, name: row.customer,
        totalSpent: (c ? Number(c.totalSpent) : 0) + Number(row.total),
        orderCount: (c ? Number(c.orderCount) : 0) + 1,
      });
    },
  };`);
  const rows = [
    { cursor: 1, data: { id: '1', customer: 'Alice', total: '10' } },
    { cursor: 2, data: { id: '2', customer: 'Bob', total: '20' } },
    { cursor: 3, data: { id: '3', customer: 'Alice', total: '5' } },
  ];
  const cfg = {
    __dir: dir, name: 'eng', batchSize: 500, pollIntervalMs: 0, handlers: './handlers.js',
    source: { type: 'mock', data: { orders: rows } },
    target: { type: 'sqlite', path: join(dir, 'e.db') },
    schema: {
      Order: { id: 'ID', customer: 'String', total: 'BigDecimal' },
      Customer: { id: 'ID', name: 'String', totalSpent: 'Float', orderCount: 'Int' },
    },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();
  await engine.backfill();
  const alice = await engine.store.get('Customer', 'Alice');
  assert.equal(alice.totalSpent, 15);
  assert.equal(alice.orderCount, 2);

  // Idempotency: a second backfill must not double-count.
  await engine.backfill();
  const alice2 = await engine.store.get('Customer', 'Alice');
  assert.equal(alice2.totalSpent, 15);
  assert.equal(alice2.orderCount, 2);
  await engine.close();
});

test('watch() live-tails new rows and stop() drains then resolves', async () => {
  const rows = [{ cursor: 1, data: { id: '1', customer: 'Alice', total: '10' } }];
  const cfg = {
    __dir: tmpdir(), name: 'eng', batchSize: 500, pollIntervalMs: 5,
    source: { type: 'mock', data: { orders: rows } },
    target: { type: 'sqlite', path: dbPath('watch') },
    schema: { Order: { id: 'ID', customer: 'String', total: 'BigDecimal' } },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();

  const waitFor = async (fn, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('waitFor timed out');
  };

  const watching = engine.watch(); // backfill + poll loop
  await waitFor(async () => (await engine.store.query('Order', {})).length === 1);

  // New row arrives while watching -> live tail must pick it up.
  rows.push({ cursor: 2, data: { id: '2', customer: 'Bob', total: '20' } });
  await waitFor(async () => (await engine.store.query('Order', {})).length === 2);

  engine.stop();
  await watching; // must resolve after the current pump finishes

  assert.equal((await engine.store.query('Order', {})).length, 2);
  assert.equal(await engine.store.getCheckpoint('orders'), '2');
  await engine.close();
});

test('watch() survives a transient pump error and retries on the next poll', async () => {
  let throwOnce = false;
  const rows = [{ cursor: 1, data: { id: '1', customer: 'Alice', total: '10' } }];
  class FlakyConnector {
    async init() {}
    async streams() {
      return [{
        key: 'orders',
        fetchBatch: async (fromCursor) => {
          if (throwOnce) { throwOnce = false; throw new Error('transient source blip'); }
          const from = fromCursor != null ? Number(fromCursor) : 0;
          const remaining = rows.filter((r) => Number(r.cursor) > from);
          const batch = remaining.slice(0, 500);
          return { records: batch, done: batch.length >= remaining.length };
        },
      }];
    }
    async close() {}
  }
  registerConnector('flaky', FlakyConnector);

  const cfg = {
    __dir: tmpdir(), name: 'eng', batchSize: 500, pollIntervalMs: 5,
    source: { type: 'flaky' },
    target: { type: 'sqlite', path: dbPath('flaky') },
    schema: { Order: { id: 'ID', customer: 'String', total: 'BigDecimal' } },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();
  const waitFor = async (fn, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error('waitFor timed out');
  };

  const watching = engine.watch();
  await waitFor(async () => (await engine.store.query('Order', {})).length === 1);

  // Arrange for the next poll to throw, then deliver a new row.
  throwOnce = true;
  rows.push({ cursor: 2, data: { id: '2', customer: 'Bob', total: '20' } });

  // Despite the thrown error, the loop keeps running and eventually indexes row 2.
  await waitFor(async () => (await engine.store.query('Order', {})).length === 2);
  assert.equal(engine.running, true, 'engine still watching after the transient error');

  engine.stop();
  await watching;
  await engine.close();
});

test('pump throws when a stream has no handler and no matching entity', async () => {
  const cfg = {
    __dir: tmpdir(), name: 'eng', batchSize: 500, pollIntervalMs: 0,
    source: { type: 'mock', data: { widgets: [{ cursor: 1, data: { id: '1' } }] } },
    target: { type: 'sqlite', path: dbPath('nohandler') },
    schema: { Order: { id: 'ID' } },
  };
  const engine = new Engine(cfg, logger);
  await engine.setup();
  await assert.rejects(() => engine.backfill(), /No handler and no matching entity/);
  await engine.close();
});
