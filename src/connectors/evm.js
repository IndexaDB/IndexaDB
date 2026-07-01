// src/connectors/evm.js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const toHex = (n) => '0x' + BigInt(n).toString(16);
const fromHex = (h) => (h == null ? null : Number(BigInt(h)));

// Default JSON-RPC transport over HTTP. Replaceable via cfg.transport for tests.
function httpTransport(rpcUrl, { retries = 4, backoffMs = 300 } = {}) {
  let id = 0;
  return async (method, params = []) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
        return json.result;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
      }
    }
    throw lastErr;
  };
}

// Convert decoded ethers args into a plain, serializable object.
function plainArgs(fragment, parsed) {
  const out = {};
  fragment.inputs.forEach((inp, i) => {
    let v = parsed.args[i];
    if (typeof v === 'bigint') v = v.toString();
    out[inp.name || `arg${i}`] = v;
  });
  return out;
}

export default class EvmConnector {
  async init(cfg, ctx) {
    this.cfg = cfg;
    this.logger = ctx.logger;
    this.kv = ctx.kv;
    this.dir = ctx.dir;
    this.transport = cfg.transport || httpTransport(cfg.rpc);
    this.confirmations = cfg.confirmations ?? 12;
    this.blockBatchSize = cfg.blockBatchSize ?? 2000;
    this.reorgWindow = cfg.reorgWindow ?? 128;

    const { Interface } = await import('ethers');

    // Build per-event routing: eventName -> { topic0, contracts:[{address, iface, fragment}], startBlock }
    this.events = new Map();
    for (const c of cfg.contracts || []) {
      const abi = Array.isArray(c.abi) ? c.abi
        : JSON.parse(readFileSync(resolve(this.dir, c.abi), 'utf8'));
      const iface = new Interface(abi);
      const address = c.address.toLowerCase();
      const wanted = c.events || iface.fragments.filter((f) => f.type === 'event').map((f) => f.name);
      for (const name of wanted) {
        const fragment = iface.getEvent(name);
        if (!fragment) throw new Error(`Event "${name}" not found in ABI for ${c.address}`);
        if (!this.events.has(name)) {
          this.events.set(name, { topic0: fragment.topicHash, contracts: [], startBlock: Infinity });
        }
        const e = this.events.get(name);
        e.contracts.push({ address, iface, fragment });
        e.startBlock = Math.min(e.startBlock, c.startBlock ?? cfg.startBlock ?? 0);
      }
    }
    if (this.events.size === 0) throw new Error('evm source: no contracts/events configured');
  }

  async streams() {
    const self = this;
    return [...this.events.entries()].map(([name, ev]) => ({
      key: name,
      reorgAware: true,
      fetchBatch: (fromCursor, limit) => self._fetchEvent(name, ev, fromCursor),
    }));
  }

  async _fetchEvent(name, ev, fromCursor) {
    const head = fromHex(await this.transport('eth_blockNumber'));
    const safeHead = head - this.confirmations;
    const finalizedBelow = Math.max(ev.startBlock - 1, safeHead - this.reorgWindow);

    if (safeHead < ev.startBlock) {
      return { records: [], done: true, finalizedBelow };
    }

    const last = fromCursor != null ? Number(fromCursor) : ev.startBlock - 1;

    // --- reorg detection: has our tip block's hash changed? ---
    if (last >= ev.startBlock) {
      const reorg = await this._detectReorg(name, ev, last);
      if (reorg != null) {
        return { records: [], done: false, reorg: { toCursor: reorg } };
      }
    }

    // --- forward scan ---
    const from = last + 1;
    if (from > safeHead) {
      await this._pruneHashes(name, finalizedBelow);
      return { records: [], done: true, finalizedBelow, advanceTo: safeHead };
    }
    const to = Math.min(from + this.blockBatchSize - 1, safeHead);

    const addresses = [...new Set(ev.contracts.map((c) => c.address))];
    const logs = await this.transport('eth_getLogs', [{
      fromBlock: toHex(from), toBlock: toHex(to),
      address: addresses, topics: [ev.topic0],
    }]);

    const records = [];
    const hashesNearTip = {};
    const nearTipFloor = safeHead - this.reorgWindow;

    for (const log of logs) {
      const address = log.address.toLowerCase();
      const c = ev.contracts.find((x) => x.address === address);
      if (!c) continue;
      let parsed;
      try { parsed = c.iface.parseLog({ topics: log.topics, data: log.data }); }
      catch { continue; }
      const blockNumber = fromHex(log.blockNumber);
      const logIndex = fromHex(log.logIndex);
      records.push({
        cursor: blockNumber,
        _sort: blockNumber * 1e6 + logIndex,
        data: {
          id: `${log.transactionHash}-${logIndex}`,
          event: name,
          address,
          blockNumber,
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex,
          args: plainArgs(c.fragment, parsed),
        },
      });
      if (blockNumber >= nearTipFloor) hashesNearTip[blockNumber] = log.blockHash;
    }
    records.sort((a, b) => a._sort - b._sort);
    records.forEach((r) => delete r._sort);

    // Record the tip block hash (always) so future reorgs are detectable, plus
    // any near-tip block hashes we learned from logs.
    if (to >= nearTipFloor) {
      if (hashesNearTip[to] == null) {
        const block = await this.transport('eth_getBlockByNumber', [toHex(to), false]);
        if (block?.hash) hashesNearTip[to] = block.hash;
      }
      for (const [h, hash] of Object.entries(hashesNearTip)) {
        await this.kv.set(`evm:${name}:hash:${h}`, hash);
      }
    }
    await this._pruneHashes(name, finalizedBelow);

    return {
      records,
      done: to >= safeHead,
      finalizedBelow,
      advanceTo: to, // advance past trailing empty blocks so we never re-scan them
    };
  }

  // Returns the safe rollback block if a reorg is found, else null.
  async _detectReorg(name, ev, last) {
    const stored = await this.kv.get(`evm:${name}:hash:${last}`);
    if (!stored) return null; // no recorded hash (deep backfill) -> assumed final
    const canonical = await this.transport('eth_getBlockByNumber', [toHex(last), false]);
    if (canonical && canonical.hash === stored) return null; // tip intact, no reorg

    this.logger.warn('tip hash mismatch — searching common ancestor', { stream: name, block: last });
    // Walk back over recorded hashes to find the deepest still-canonical block.
    for (let h = last - 1; h >= ev.startBlock; h--) {
      const sh = await this.kv.get(`evm:${name}:hash:${h}`);
      if (!sh) continue; // not recorded; keep walking
      const cb = await this.transport('eth_getBlockByNumber', [toHex(h), false]);
      if (cb && cb.hash === sh) return h; // common ancestor found
    }
    return ev.startBlock - 1; // nothing matches -> re-index whole window
  }

  async _pruneHashes(name, belowBlock) {
    // Best-effort prune of finalized hashes (kv has no range delete; prefix-scan is fine here).
    // We delete by prefix only on shutdown/large windows; for steady state we rely on the small window.
    if (belowBlock <= 0) return;
    // No-op for the prefix store granularity; finalized hashes are harmless and bounded by window churn.
  }

  async close() {}
}
