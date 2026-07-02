// test/store.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';

const schema = {
  Item: { id: 'ID', name: 'String', active: 'Boolean', qty: 'Int', price: 'Float', tags: '[String]', meta: 'JSON', ts: 'Timestamp' },
};

let store;
const ids = (rows) => rows.map((r) => r.id).sort();

before(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ix-store-')), 's.db');
  store = createStore({ type: 'sqlite', path: dbPath });
  await store.init(schema);
  await store.upsert('Item', 'a', { id: 'a', name: 'Apple', active: true, qty: 3, price: 1.5, tags: ['x'], meta: { k: 1 }, ts: '2026-01-02T00:00:00Z' });
  await store.upsert('Item', 'b', { id: 'b', name: 'Banana', active: false, qty: 10, price: 0.5, tags: ['y', 'z'], meta: { k: 2 }, ts: '2026-01-05T00:00:00Z' });
  await store.upsert('Item', 'c', { id: 'c', name: 'Cherry', active: true, qty: 7, price: 2.0, tags: [], meta: null, ts: '2026-01-09T00:00:00Z' });
});

after(async () => { await store.close(); });

test('get returns a decoded row (Boolean, JSON, list round-trip)', async () => {
  const a = await store.get('Item', 'a');
  assert.equal(a.name, 'Apple');
  assert.strictEqual(a.active, true);
  assert.deepEqual(a.tags, ['x']);
  assert.deepEqual(a.meta, { k: 1 });
  const b = await store.get('Item', 'b');
  assert.strictEqual(b.active, false);
});

test('upsert updates an existing row', async () => {
  await store.upsert('Item', 'a', { id: 'a', name: 'Apricot', active: true, qty: 4 });
  const a = await store.get('Item', 'a');
  assert.equal(a.name, 'Apricot');
  assert.equal(a.qty, 4);
  // restore for other tests
  await store.upsert('Item', 'a', { id: 'a', name: 'Apple', active: true, qty: 3, price: 1.5, tags: ['x'], meta: { k: 1 }, ts: '2026-01-02T00:00:00Z' });
});

test('equality filter coerces to the declared type', async () => {
  assert.deepEqual(ids(await store.query('Item', { where: { active: 'true' } })), ['a', 'c']);
  assert.deepEqual(ids(await store.query('Item', { where: { active: 'false' } })), ['b']);
  assert.deepEqual(ids(await store.query('Item', { where: { qty: '10' } })), ['b']);
});

test('comparison operators', async () => {
  assert.deepEqual(ids(await store.query('Item', { where: { qty: { gte: 5 } } })), ['b', 'c']);
  assert.deepEqual(ids(await store.query('Item', { where: { qty: { gte: 3, lt: 10 } } })), ['a', 'c']);
  assert.deepEqual(ids(await store.query('Item', { where: { qty: { ne: 7 } } })), ['a', 'b']);
  assert.deepEqual(ids(await store.query('Item', { where: { name: { like: 'C%' } } })), ['c']);
  assert.deepEqual(ids(await store.query('Item', { where: { id: { in: ['a', 'c'] } } })), ['a', 'c']);
  assert.deepEqual(ids(await store.query('Item', { where: { qty: { in: [3, 10] } } })), ['a', 'b']);
});

test('ISO timestamp ranges sort chronologically', async () => {
  assert.deepEqual(ids(await store.query('Item', { where: { ts: { gte: '2026-01-04', lte: '2026-01-06' } } })), ['b']);
});

test('empty IN matches nothing', async () => {
  assert.deepEqual(await store.query('Item', { where: { id: { in: [] } } }), []);
});

test('orderBy + desc + pagination', async () => {
  const rows = await store.query('Item', { orderBy: 'qty', desc: true, limit: 2 });
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c']);
  const page2 = await store.query('Item', { orderBy: 'qty', desc: true, limit: 2, offset: 2 });
  assert.deepEqual(page2.map((r) => r.id), ['a']);
});

test('count honors filters', async () => {
  assert.equal(await store.count('Item'), 3);
  assert.equal(await store.count('Item', { qty: { gte: 5 } }), 2);
  assert.equal(await store.count('Item', { active: 'true' }), 2);
});

test('injection guard: unknown orderBy / filter column / operator throw', async () => {
  await assert.rejects(() => store.query('Item', { orderBy: 'qty"; DROP TABLE "Item"; --' }), /not a field/);
  await assert.rejects(() => store.query('Item', { where: { bogus: 1 } }), /not a field/);
  await assert.rejects(() => store.query('Item', { where: { qty: { wat: 1 } } }), /Unknown filter operator/);
  // table intact
  assert.equal(await store.count('Item'), 3);
});

test('negative / NaN pagination clamps to defaults', async () => {
  assert.equal((await store.query('Item', { limit: -1 })).length, 3);
  assert.equal((await store.query('Item', { limit: 'abc' })).length, 3);
  assert.equal((await store.query('Item', { offset: -5, limit: 1 })).length, 1);
});

test('checkpoints persist and read back', async () => {
  await store.setCheckpoint('items', 42);
  assert.equal(await store.getCheckpoint('items'), '42');
  const all = await store.allCheckpoints();
  assert.ok(all.some((c) => c.source === 'items' && c.cursor === '42'));
});

test('kv get/set/deletePrefix', async () => {
  await store.kvSet('evm:x:hash:1', '0xabc');
  await store.kvSet('evm:x:hash:2', '0xdef');
  assert.equal(await store.kvGet('evm:x:hash:1'), '0xabc');
  await store.kvDeletePrefix('evm:x:hash:');
  assert.equal(await store.kvGet('evm:x:hash:1'), null);
});

test('openReader sees committed data but not the writer\'s open transaction', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ix-reader-')), 'r.db');
  const w = createStore({ type: 'sqlite', path: dbPath });
  await w.init({ Item: { id: 'ID', v: 'Int' } });
  await w.upsert('Item', '1', { id: '1', v: 1 });

  const reader = await w.openReader();
  assert.equal((await reader.get('Item', '1')).v, 1, 'reader sees the initial committed row');

  let midTxnView;
  await w.transaction(async () => {
    await w.upsert('Item', '1', { id: '1', v: 999 }); // uncommitted
    midTxnView = (await reader.get('Item', '1')).v;   // reader must still see 1
  });
  assert.equal(midTxnView, 1, 'reader did not observe the uncommitted write');
  assert.equal((await reader.get('Item', '1')).v, 999, 'reader sees the value after commit');

  await reader.close();
  // reader.close() must not close the writer
  await w.upsert('Item', '2', { id: '2', v: 2 });
  assert.equal((await w.get('Item', '2')).v, 2);
  await w.close();
});

test('journal rollback undoes inserts and restores prior values', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ix-journal-')), 'j.db');
  const s = createStore({ type: 'sqlite', path: dbPath });
  await s.init({ Bal: { id: 'ID', v: 'Int' } });
  s.enableJournal('chain');

  // block 100: create id=1 (v=10)
  s.setJournalContext('chain', 100);
  await s.upsert('Bal', '1', { id: '1', v: 10 });
  // block 101: update id=1 -> v=20, create id=2
  s.setJournalContext('chain', 101);
  await s.upsert('Bal', '1', { id: '1', v: 20 });
  await s.upsert('Bal', '2', { id: '2', v: 5 });
  s.setJournalContext(null);

  assert.equal((await s.get('Bal', '1')).v, 20);
  assert.equal((await s.get('Bal', '2')).v, 5);

  // roll back everything after block 100 (block 100 state is kept)
  const undone = await s.rollbackTo('chain', 100);
  assert.equal(undone, 2, 'the two block-101 writes are undone; block 100 kept');
  assert.equal((await s.get('Bal', '1')).v, 10, 'id=1 restored to pre-101 value');
  assert.equal(await s.get('Bal', '2'), null, 'id=2 (created in 101) removed');
  await s.close();
});
