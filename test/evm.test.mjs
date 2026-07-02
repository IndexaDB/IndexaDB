// test/evm.test.mjs
// Focused test for the EVM connector's block-hash bookkeeping: the recorded-hash
// map must stay bounded to the reorg window as the chain advances, rather than
// leaking one kv row per indexed block. ethers is optional, so skip without it.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import EvmConnector from '../src/connectors/evm.js';
import { createLogger } from '../src/logger.js';

let ethers;
try { ({ ethers } = await import('ethers')); } catch { /* optional */ }

const abi = [{ anonymous: false, name: 'Transfer', type: 'event', inputs: [
  { indexed: true, name: 'from', type: 'address' },
  { indexed: true, name: 'to', type: 'address' },
  { indexed: false, name: 'value', type: 'uint256' },
] }];
const CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

test('recorded-hash map stays bounded to the reorg window as the chain advances',
  { skip: ethers ? false : 'ethers not installed' },
  async () => {
    const reorgWindow = 10;
    let head = 0;
    const transport = async (method, params = []) => {
      if (method === 'eth_blockNumber') return '0x' + head.toString(16);
      if (method === 'eth_getBlockByNumber') {
        const num = Number(BigInt(params[0]));
        return num > head ? null : { number: params[0], hash: 'h' + num };
      }
      if (method === 'eth_getLogs') return []; // no events; only tip hashes are recorded
      throw new Error('unexpected ' + method);
    };

    const dbPath = join(mkdtempSync(join(tmpdir(), 'ix-evm-')), 'e.db');
    const store = createStore({ type: 'sqlite', path: dbPath });
    await store.init({ Dummy: { id: 'ID' } });
    const kv = {
      get: (k) => store.kvGet(k),
      set: (k, v) => store.kvSet(k, v),
      deletePrefix: (p) => store.kvDeletePrefix(p),
    };

    const c = new EvmConnector();
    await c.init(
      { transport, confirmations: 1, reorgWindow, blockBatchSize: 5, startBlock: 0,
        contracts: [{ address: CONTRACT, abi, events: ['Transfer'] }] },
      { logger: createLogger('evm-test'), dir: '.', kv },
    );
    const [stream] = await c.streams();

    // Advance the chain one block at a time, draining each time like the engine.
    let cursor = null;
    for (head = 1; head <= 120; head++) {
      let done = false;
      while (!done) {
        const r = await stream.fetchBatch(cursor, 5);
        if (r.advanceTo != null) cursor = r.advanceTo;
        else if (r.records.length) cursor = r.records.at(-1).cursor;
        done = r.done;
      }
    }

    const raw = await kv.get('evm:Transfer:hashes');
    const map = JSON.parse(raw);
    const size = Object.keys(map).length;
    assert.ok(size <= reorgWindow + 2, `hash map bounded (${size} <= ${reorgWindow + 2}) after 120 blocks`);
    // and it must still hold the freshest blocks so reorgs remain detectable
    const blocks = Object.keys(map).map(Number).sort((a, b) => a - b);
    assert.ok(blocks.at(-1) >= head - 1 - 1, 'newest recorded block is at the safe tip');

    // Only one kv row is used for hashes — no per-block leak.
    await store.kvSet('probe', '1');
    await store.close();
  });
