// test/schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseType, sqlColumnType, coerceScalar, generateTypes } from '../src/schema.js';

test('parseType decodes modifiers', () => {
  assert.deepEqual(parseType('String'), { base: 'String', list: false, required: false });
  assert.deepEqual(parseType('String!'), { base: 'String', list: false, required: true });
  assert.deepEqual(parseType('[Order]'), { base: 'Order', list: true, required: false });
  assert.deepEqual(parseType('[Int]!'), { base: 'Int', list: true, required: true });
});

test('sqlColumnType maps per dialect', () => {
  assert.equal(sqlColumnType('Int', false, 'sqlite'), 'INTEGER');
  assert.equal(sqlColumnType('Int', false, 'postgres'), 'BIGINT');
  assert.equal(sqlColumnType('Boolean', false, 'sqlite'), 'INTEGER');
  assert.equal(sqlColumnType('Boolean', false, 'postgres'), 'BOOLEAN');
  assert.equal(sqlColumnType('BigInt', false, 'postgres'), 'NUMERIC');
  // lists are stored as JSON
  assert.equal(sqlColumnType('Int', true, 'sqlite'), 'TEXT');
  assert.equal(sqlColumnType('Int', true, 'postgres'), 'JSONB');
  // unknown base / entity relation -> TEXT foreign id
  assert.equal(sqlColumnType('Customer', false, 'sqlite'), 'TEXT');
});

test('coerceScalar converts strings to declared types', () => {
  assert.equal(coerceScalar('3.9', 'Int'), 3);
  assert.equal(coerceScalar('1.5', 'Float'), 1.5);
  assert.equal(coerceScalar('true', 'Boolean'), true);
  assert.equal(coerceScalar('false', 'Boolean'), false);
  assert.equal(coerceScalar('1', 'Boolean'), true);
  assert.equal(coerceScalar('0', 'Boolean'), false);
  assert.equal(coerceScalar('t', 'Boolean'), true);
  assert.equal(coerceScalar('hello', 'String'), 'hello');
  assert.equal(coerceScalar('', 'String'), null);
  assert.equal(coerceScalar(null, 'Int'), null);
  assert.deepEqual(coerceScalar('{"a":1}', 'JSON'), { a: 1 });
  assert.deepEqual(coerceScalar('[1,2,3]', 'Int', true), [1, 2, 3]);
  // BigInt/BigDecimal stay as their string form (arbitrary precision)
  assert.equal(coerceScalar('123456789012345678901234567890', 'BigInt'), '123456789012345678901234567890');
});

test('generateTypes emits a .d.ts with interfaces and Store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ix-types-'));
  const file = generateTypes({ Order: { id: 'ID', total: 'BigDecimal', items: 'Int' } }, dir);
  const out = readFileSync(file, 'utf8');
  assert.match(out, /export interface Order \{/);
  assert.match(out, /items\?: number;/);
  assert.match(out, /total\?: string;/); // BigDecimal -> string
  assert.match(out, /export interface Store \{/);
  assert.match(out, /upsert\(entity: 'Order'/);
});
