// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function writeConfig(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ix-cfg-'));
  const file = join(dir, 'indexa.config.yaml');
  writeFileSync(file, body);
  return file;
}

test('loadConfig applies defaults and resolves sqlite path', () => {
  const file = writeConfig(`
name: demo
source: { type: csv, sources: [{ key: orders, file: data/orders.csv }] }
target: { type: sqlite, path: ./out.db }
schema:
  Order: { id: ID, total: BigDecimal }
`);
  const cfg = loadConfig(file);
  assert.equal(cfg.name, 'demo');
  assert.equal(cfg.batchSize, 500);
  assert.equal(cfg.pollIntervalMs, 2000);
  assert.ok(cfg.target.path.endsWith('out.db'));
  assert.ok(cfg.target.path.includes('ix-cfg-'), 'relative sqlite path resolved against config dir');
});

test('loadConfig defaults target to sqlite when omitted', () => {
  const file = writeConfig(`
source: { type: csv, sources: [] }
schema:
  Order: { id: ID }
`);
  const cfg = loadConfig(file);
  assert.equal(cfg.target.type, 'sqlite');
  assert.equal(cfg.name, 'indexa-app');
});

test('loadConfig rejects an entity without an id', () => {
  const file = writeConfig(`
source: { type: csv }
schema:
  Order: { total: BigDecimal }
`);
  assert.throws(() => loadConfig(file), /must have an "id" field/);
});

test('loadConfig rejects unknown field types', () => {
  const file = writeConfig(`
source: { type: csv }
schema:
  Order: { id: ID, weird: Wat }
`);
  assert.throws(() => loadConfig(file), /unknown type "Wat"/);
});

test('loadConfig accepts entity relations as types', () => {
  const file = writeConfig(`
source: { type: csv }
schema:
  Customer: { id: ID, name: String }
  Order: { id: ID, customer: Customer }
`);
  const cfg = loadConfig(file);
  assert.equal(cfg.schema.Order.customer, 'Customer');
});

test('loadConfig interpolates env vars with defaults', () => {
  process.env.IX_TEST_DB = 'postgres://x';
  const file = writeConfig(`
source: { type: postgres, connection: "\${IX_TEST_DB}" }
target: { type: postgres, connection: "\${IX_MISSING:-postgres://fallback}" }
schema:
  Order: { id: ID }
`);
  const cfg = loadConfig(file);
  assert.equal(cfg.source.connection, 'postgres://x');
  assert.equal(cfg.target.connection, 'postgres://fallback');
  delete process.env.IX_TEST_DB;
});

test('loadConfig throws on a missing required env var', () => {
  const file = writeConfig(`
source: { type: postgres, connection: "\${IX_DEFINITELY_MISSING_VAR}" }
schema:
  Order: { id: ID }
`);
  assert.throws(() => loadConfig(file), /Missing required env var/);
});
