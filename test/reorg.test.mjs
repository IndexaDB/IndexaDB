// test/reorg.test.mjs
// Proves the EVM connector + engine handle a chain reorg correctly:
// orphaned transfers are undone (including aggregated balances) and the new
// canonical chain is re-indexed. Uses a mock JSON-RPC transport (no live node).
//
// ethers is an optional dependency (only the evm connector needs it), so this
// integration test skips itself when ethers is not installed.
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { Engine } from '../src/index.js';
import { createLogger, setLevel } from '../src/logger.js';

setLevel(process.env.INDEXA_LOG_LEVEL || 'warn');
const __dir = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(__dir, '..', 'examples', 'evm-erc20');

let ethers;
try { ({ ethers } = await import('ethers')); } catch { /* optional dep absent */ }

test('EVM reorg: orphaned writes undone, chain re-indexed, balances corrected',
  { skip: ethers ? false : 'ethers not installed (run: npm install ethers)' },
  async () => {
    const CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const A = '0x' + 'aa'.repeat(20);
    const B = '0x' + 'bb'.repeat(20);
    const C = '0x' + 'cc'.repeat(20);
    const D = '0x' + 'dd'.repeat(20);

    const abi = [
      { anonymous: false, name: 'Transfer', type: 'event', inputs: [
        { indexed: true, name: 'from', type: 'address' },
        { indexed: true, name: 'to', type: 'address' },
        { indexed: false, name: 'value', type: 'uint256' },
      ] },
    ];
    const iface = new ethers.Interface(abi);
    const TRANSFER = iface.getEvent('Transfer');

    const hex = (n) => '0x' + BigInt(n).toString(16);
    const blockHash = (num, ver) => ethers.id(`block-${num}-v${ver}`);

    // ---- mutable mock chain ----
    function makeChain() {
      const blocks = new Map(); // number -> { ver, transfers: [{from,to,value,txHash}] }
      let head = 0;
      return {
        setBlock(num, ver, transfers = []) { blocks.set(num, { ver, transfers }); head = Math.max(head, num); },
        setHead(n) { head = n; },
        get head() { return head; },
        transport: async (method, params = []) => {
          if (method === 'eth_blockNumber') return hex(head);
          if (method === 'eth_getBlockByNumber') {
            const num = Number(BigInt(params[0]));
            if (num > head) return null;
            const b = blocks.get(num) || { ver: 0 };
            return { number: hex(num), hash: blockHash(num, b.ver), parentHash: blockHash(num - 1, (blocks.get(num - 1) || { ver: 0 }).ver) };
          }
          if (method === 'eth_getLogs') {
            const { fromBlock, toBlock, address } = params[0];
            const from = Number(BigInt(fromBlock));
            const to = Math.min(Number(BigInt(toBlock)), head);
            const addrs = (address || []).map((a) => a.toLowerCase());
            const out = [];
            for (let n = from; n <= to; n++) {
              const b = blocks.get(n);
              if (!b) continue;
              b.transfers.forEach((t, i) => {
                const { data, topics } = iface.encodeEventLog(TRANSFER, [t.from, t.to, BigInt(t.value)]);
                if (addrs.length && !addrs.includes(CONTRACT)) return;
                out.push({
                  address: CONTRACT, topics, data,
                  blockNumber: hex(n), blockHash: blockHash(n, b.ver),
                  transactionHash: t.txHash, logIndex: hex(i),
                });
              });
            }
            return out;
          }
          throw new Error('unexpected RPC ' + method);
        },
      };
    }

    function makeConfig(transport, dbPath) {
      return {
        __dir: exampleDir,
        name: 'erc20-test',
        batchSize: 5000,
        pollIntervalMs: 0,
        source: {
          type: 'evm', transport, confirmations: 1, blockBatchSize: 2000, reorgWindow: 100,
          contracts: [{ address: CONTRACT, abi: './erc20.abi.json', events: ['Transfer'], startBlock: 100 }],
        },
        target: { type: 'sqlite', path: dbPath },
        handlers: './handlers.js',
        schema: {
          Transfer: { id: 'ID', from: 'String', to: 'String', value: 'BigInt', blockNumber: 'Int', txHash: 'String' },
          Holder: { id: 'ID', address: 'String', balance: 'BigInt', transferCount: 'Int' },
        },
      };
    }

    async function balances(store) {
      const rows = await store.query('Holder', { limit: 100 });
      const m = {};
      for (const r of rows) m[r.address.toLowerCase()] = r.balance;
      return m;
    }

    const dbPath = join(mkdtempSync(join(tmpdir(), 'indexa-')), 'erc20.db');
    const chain = makeChain();

    // ---- canonical chain v1 (blocks 100..110, head 110) ----
    chain.setBlock(101, 1, [{ from: A, to: B, value: '100', txHash: ethers.id('t101') }]);
    chain.setBlock(103, 1, [{ from: B, to: C, value: '40', txHash: ethers.id('t103') }]);
    chain.setBlock(108, 1, [{ from: A, to: C, value: '30', txHash: ethers.id('t108old') }]); // will be orphaned
    chain.setBlock(109, 1, [{ from: C, to: B, value: '10', txHash: ethers.id('t109old') }]); // will be orphaned
    chain.setHead(110);

    const engine = new Engine(makeConfig(chain.transport, dbPath), createLogger('test'));
    await engine.setup();
    await engine.backfill();

    const before = await balances(engine.store);
    assert.equal(before[A.toLowerCase()], '-130', 'A should be -130 (100 + 30)');
    assert.equal(before[B.toLowerCase()], '70', 'B should be 70 (100 - 40 + 10)');
    assert.equal(before[C.toLowerCase()], '60', 'C should be 60 (40 + 30 - 10)');
    const txCountV1 = (await engine.store.query('Transfer', { limit: 100 })).length;
    assert.equal(txCountV1, 4, 'v1 should have 4 transfers');

    // ---- REORG: rewrite from block 108 with a different history, extend head ----
    chain.setBlock(108, 2, [{ from: A, to: D, value: '5', txHash: ethers.id('t108new') }]);
    chain.setBlock(109, 2, []); // empty in new chain
    chain.setBlock(110, 2, [{ from: B, to: D, value: '20', txHash: ethers.id('t110new') }]);
    chain.setHead(112);

    // one more sync pass -> should detect reorg, roll back, re-index new chain
    await engine.backfill();

    const after = await balances(engine.store);
    assert.equal(after[A.toLowerCase()], '-105', 'A should be -105 (100 + 5)');
    assert.equal(after[B.toLowerCase()], '40', 'B should be 40 (100 - 40 - 20)');
    assert.equal(after[C.toLowerCase()], '40', 'C should be 40 (40 only; orphaned -10 and +30 undone)');
    assert.equal(after[D.toLowerCase()], '25', 'D should be 25 (5 + 20)');

    const txs = await engine.store.query('Transfer', { limit: 100 });
    const ids = txs.map((t) => t.txHash);
    assert.ok(!ids.includes(ethers.id('t108old')), 'orphaned transfer t108old must be removed');
    assert.ok(!ids.includes(ethers.id('t109old')), 'orphaned transfer t109old must be removed');
    assert.ok(ids.includes(ethers.id('t108new')), 'new transfer t108new must be present');
    assert.ok(ids.includes(ethers.id('t110new')), 'new transfer t110new must be present');
    assert.equal(txs.length, 4, 'should still have 4 transfers (2 kept + 2 new)');

    await engine.close();
  });
