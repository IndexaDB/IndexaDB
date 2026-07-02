// test/csv.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CsvConnector from '../src/connectors/csv.js';
import { createLogger } from '../src/logger.js';

function csvFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ix-csv-'));
  writeFileSync(join(dir, 'data.csv'), body);
  return dir;
}

async function readAll(dir) {
  const c = new CsvConnector();
  await c.init({ sources: [{ key: 'rows', file: 'data.csv' }] }, { logger: createLogger('t'), dir });
  const [stream] = await c.streams();
  const { records, done } = await stream.fetchBatch(null, 1000);
  return { records, done };
}

test('parses a simple CSV into header-keyed rows', async () => {
  const dir = csvFixture('id,name,total\n1,Alice,10\n2,Bob,20\n');
  const { records, done } = await readAll(dir);
  assert.equal(done, true);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { cursor: 1, data: { id: '1', name: 'Alice', total: '10' } });
  assert.deepEqual(records[1].data, { id: '2', name: 'Bob', total: '20' });
});

test('handles quoted fields with commas, quotes and newlines', async () => {
  const dir = csvFixture('id,note\n1,"hello, world"\n2,"she said ""hi"""\n3,"line1\nline2"\n');
  const { records } = await readAll(dir);
  assert.equal(records.length, 3);
  assert.equal(records[0].data.note, 'hello, world');
  assert.equal(records[1].data.note, 'she said "hi"');
  assert.equal(records[2].data.note, 'line1\nline2');
});

test('fetchBatch resumes strictly after the cursor and respects limit', async () => {
  const dir = csvFixture('id\n1\n2\n3\n4\n5\n');
  const c = new CsvConnector();
  await c.init({ sources: [{ key: 'rows', file: 'data.csv' }] }, { logger: createLogger('t'), dir });
  const [stream] = await c.streams();
  const first = await stream.fetchBatch(null, 2);
  assert.deepEqual(first.records.map((r) => r.cursor), [1, 2]);
  const next = await stream.fetchBatch(2, 2);
  assert.deepEqual(next.records.map((r) => r.cursor), [3, 4]);
  const tail = await stream.fetchBatch(4, 2);
  assert.deepEqual(tail.records.map((r) => r.cursor), [5]);
});

test('ignores trailing blank lines', async () => {
  const dir = csvFixture('id,name\n1,Alice\n\n');
  const { records } = await readAll(dir);
  assert.equal(records.length, 1);
});

test('picks up appended rows on a later fetch (live tail)', async () => {
  const dir = csvFixture('id,name\n1,Alice\n');
  const c = new CsvConnector();
  await c.init({ sources: [{ key: 'rows', file: 'data.csv' }] }, { logger: createLogger('t'), dir });
  const [stream] = await c.streams();

  let r = await stream.fetchBatch(null, 100);
  assert.equal(r.records.length, 1);

  // Append a new row and bump the mtime so the connector re-reads.
  const path = join(dir, 'data.csv');
  appendFileSync(path, '2,Bob\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);

  r = await stream.fetchBatch(1, 100); // resume after cursor 1
  assert.equal(r.records.length, 1);
  assert.deepEqual(r.records[0], { cursor: 2, data: { id: '2', name: 'Bob' } });
});
