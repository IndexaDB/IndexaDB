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
    const hashes = await this._loadHashes(name);

    // --- reorg detection: has our tip block's hash changed? ---
    if (last >= ev.startBlock) {
      const reorg = await this._detectReorg(name, ev, last, hashes);
      if (reorg != null) {
        // Drop the recorded hashes for the orphaned blocks we're rolling back past,
        // so the map never keeps a hash that disagrees with the canonical chain.
        let changed = false;
        for (const h of hashes.keys()) if (h > reorg) { hashes.delete(h); changed = true; }
        if (changed) await this._saveHashes(name, hashes);
        return { records: [], done: false, reorg: { toCursor: reorg } };
      }
    }

    // --- forward scan ---
    const from = last + 1;
    if (from > safeHead) {
      if (this._pruneHashes(hashes, finalizedBelow)) await this._saveHashes(name, hashes);
      return { records: [], done: true, finalizedBelow, advanceTo: safeHead };
    }
    const to = Math.min(from + this.blockBatchSize - 1, safeHead);

    const addresses = [...new Set(ev.contracts.map((c) => c.address))];
    const logs = await this.transport('eth_getLogs', [{
      fromBlock: toHex(from), toBlock: toHex(to),
      address: addresses, topics: [ev.topic0],
    }]);

    const records = [];
    const nearTipFloor = safeHead - this.reorgWindow;
    let dirty = false;

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
      if (blockNumber >= nearTipFloor) { hashes.set(blockNumber, log.blockHash); dirty = true; }
    }
    records.sort((a, b) => a._sort - b._sort);
    records.forEach((r) => delete r._sort);

    // Record the tip block hash (always) so future reorgs are detectable, plus
    // any near-tip block hashes we learned from logs.
    if (to >= nearTipFloor && !hashes.has(to)) {
      const block = await this.transport('eth_getBlockByNumber', [toHex(to), false]);
      if (block?.hash) { hashes.set(to, block.hash); dirty = true; }
    }
    if (this._pruneHashes(hashes, finalizedBelow)) dirty = true;
    if (dirty) await this._saveHashes(name, hashes);

    return {
      records,
      done: to >= safeHead,
      finalizedBelow,
      advanceTo: to, // advance past trailing empty blocks so we never re-scan them
    };
  }

  // Returns the safe rollback block if a reorg is found, else null.
  async _detectReorg(name, ev, last, hashes) {
    const stored = hashes.get(last);
    if (stored == null) return null; // no recorded hash (deep backfill) -> assumed final
    const canonical = await this.transport('eth_getBlockByNumber', [toHex(last), false]);
    if (canonical && canonical.hash === stored) return null; // tip intact, no reorg

    this.logger.warn('tip hash mismatch — searching common ancestor', { stream: name, block: last });
    // Walk back over recorded hashes (deepest-first) to find the last canonical block.
    const recorded = [...hashes.keys()].filter((h) => h < last && h >= ev.startBlock).sort((a, b) => b - a);
    for (const h of recorded) {
      const cb = await this.transport('eth_getBlockByNumber', [toHex(h), false]);
      if (cb && cb.hash === hashes.get(h)) return h; // common ancestor found
    }
    return ev.startBlock - 1; // nothing matches -> re-index whole window
  }

  // Block-hash bookkeeping. The whole reorg window is kept in a single kv value
  // per event ({ block: hash }); pruning finalized entries keeps it bounded to
  // ~reorgWindow instead of leaking one row per indexed block.
  async _loadHashes(name) {
    const raw = await this.kv.get(`evm:${name}:hashes`);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [Number(k), v]));
  }

  async _saveHashes(name, hashes) {
    const obj = {};
    for (const [k, v] of hashes) obj[k] = v;
    await this.kv.set(`evm:${name}:hashes`, JSON.stringify(obj));
  }

  _pruneHashes(hashes, belowBlock) {
    let changed = false;
    for (const h of hashes.keys()) if (h <= belowBlock) { hashes.delete(h); changed = true; }
    return changed;
  }

  async close() {}
}
