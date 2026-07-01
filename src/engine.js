// src/engine.js
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseType } from './schema.js';
import { loadConnector } from './registry.js';
import { createStore } from './store.js';

function coerce(value, base, list) {
  if (value == null || value === '') return null;
  if (list && typeof value === 'string') { try { return JSON.parse(value); } catch { return value; } }
  switch (base) {
    case 'Int': return Math.trunc(Number(value));
    case 'Float': return Number(value);
    case 'Boolean': return value === true || value === 'true' || value === '1' || value === 't';
    case 'JSON': return typeof value === 'string' ? JSON.parse(value) : value;
    default: return value; // String/ID/BigInt/BigDecimal/Timestamp/relations stay as-is
  }
}

// When no handler is defined for a stream, map raw columns straight into the
// matching entity, coercing each field to its declared schema type.
function defaultMapping(streamKey, schema, sourceMap) {
  const norm = (s) => s.toLowerCase().replace(/s$/, ''); // crude singularize for table->entity
  const entity = sourceMap?.[streamKey]
    || Object.keys(schema).find((e) => e.toLowerCase() === streamKey.toLowerCase())
    || Object.keys(schema).find((e) => norm(e) === norm(streamKey));
  if (!entity) return null;
  const fields = schema[entity];
  return async (record, ctx) => {
    const data = {};
    for (const [field, type] of Object.entries(fields)) {
      if (field in record) {
        const { base, list } = parseType(type);
        data[field] = coerce(record[field], base, list);
      }
    }
    if (data.id == null) throw new Error(`Record for "${entity}" is missing an "id" field`);
    await ctx.store.upsert(entity, String(data.id), data);
  };
}

async function loadHandlers(cfg) {
  if (!cfg.handlers) return {};
  const abs = resolve(cfg.__dir, cfg.handlers);
  const mod = await import(pathToFileURL(abs).href);
  return mod.default || mod;
}

export class Engine {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger.child('engine');
    this.running = false;
  }

  async setup() {
    this.store = createStore(this.cfg.target);
    await this.store.init(this.cfg.schema);

    const ConnectorClass = await loadConnector(this.cfg.source.type);
    this.connector = new ConnectorClass();
    const kv = {
      get: (k) => this.store.kvGet(k),
      set: (k, v) => this.store.kvSet(k, v),
      deletePrefix: (p) => this.store.kvDeletePrefix(p),
    };
    await this.connector.init(this.cfg.source, { logger: this.logger.child('source'), dir: this.cfg.__dir, kv });
    this.streams = await this.connector.streams();
    for (const s of this.streams) if (s.reorgAware) this.store.enableJournal(s.key);

    this.handlers = await loadHandlers(this.cfg);
    this.logger.info(`setup complete`, {
      source: this.cfg.source.type,
      target: this.cfg.target.type,
      streams: this.streams.map((s) => s.key),
      handlers: Object.keys(this.handlers),
    });
  }

  // Process one batch for one stream. Returns { processed, done }.
  async pump(stream) {
    const handler = this.handlers[stream.key] || defaultMapping(stream.key, this.cfg.schema, this.cfg.source.map);
    if (!handler) {
      throw new Error(`No handler and no matching entity for stream "${stream.key}". ` +
        `Add a handler or a source.map entry.`);
    }
    const reorgAware = !!stream.reorgAware;
    const fromCursor = await this.store.getCheckpoint(stream.key);
    const { records, done, reorg, finalizedBelow, advanceTo } = await stream.fetchBatch(fromCursor, this.cfg.batchSize);

    const hasWork = reorg || records.length > 0 || (advanceTo != null && advanceTo > Number(fromCursor ?? -Infinity));
    if (!hasWork) {
      if (reorgAware && finalizedBelow != null) await this.store.pruneJournal(stream.key, finalizedBelow);
      return { processed: 0, done: true };
    }

    try {
      await this.store.transaction(async () => {
        if (reorg) {
          const undone = await this.store.rollbackTo(stream.key, reorg.toCursor);
          await this.store.setCheckpoint(stream.key, reorg.toCursor);
          this.logger.warn('reorg detected — rolled back', {
            stream: stream.key, toBlock: Number(reorg.toCursor), entitiesUndone: undone,
          });
        }
        for (const rec of records) {
          if (reorgAware) this.store.setJournalContext(stream.key, Number(rec.cursor));
          const ctx = {
            store: this.store,
            source: stream.key,
            cursor: rec.cursor,
            logger: this.logger.child(stream.key),
          };
          await handler(rec.data, ctx);
          await this.store.setCheckpoint(stream.key, rec.cursor);
        }
        if (advanceTo != null) await this.store.setCheckpoint(stream.key, advanceTo);
      });
    } finally {
      if (reorgAware) this.store.setJournalContext(null);
    }

    if (reorgAware && finalizedBelow != null) await this.store.pruneJournal(stream.key, finalizedBelow);
    if (records.length) {
      this.logger.info('indexed batch', {
        stream: stream.key, count: records.length, cursor: String(records.at(-1).cursor),
      });
    }
    return { processed: records.length, done };
  }

  // Drain all streams until caught up.
  async backfill() {
    for (const stream of this.streams) {
      let done = false;
      while (!done) {
        const r = await this.pump(stream);
        done = r.done;
      }
    }
    this.logger.info('backfill caught up');
  }

  // Backfill, then keep polling for new rows (live tail).
  async watch() {
    this.running = true;
    await this.backfill();
    const interval = this.cfg.pollIntervalMs;
    while (this.running) {
      await new Promise((r) => setTimeout(r, interval));
      for (const stream of this.streams) {
        if (!this.running) break;
        let done = false;
        while (!done && this.running) { const r = await this.pump(stream); done = r.done; }
      }
    }
  }

  stop() { this.running = false; }

  async close() {
    await this.connector?.close();
    await this.store?.close();
  }
}
