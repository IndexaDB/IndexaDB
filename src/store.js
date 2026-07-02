// src/store.js
import { parseType, sqlColumnType, coerceScalar } from './schema.js';

// orderBy is interpolated straight into SQL as an identifier, so it must never
// come from unvalidated input. Only a real field of the entity is allowed —
// this is the guard against SQL injection via ?orderBy=.
function assertField(name, fields, entity, kind) {
  if (name != null && !(name in fields)) {
    throw new Error(`Cannot ${kind} "${name}": not a field of ${entity}`);
  }
}

// LIMIT/OFFSET reach SQL as bound params, but a negative LIMIT means "unbounded"
// in SQLite, so an unclamped value is a resource footgun. Fall back to defaults
// for NaN/negative input.
function clampInt(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Serialize a value for storage based on its declared type.
function encode(value, base, list, dialect) {
  if (value == null) return null;
  if (list || base === 'JSON') {
    return dialect === 'postgres' ? value : JSON.stringify(value);
  }
  if (base === 'Boolean' && dialect !== 'postgres') return value ? 1 : 0;
  if (base === 'BigInt' || base === 'BigDecimal') return String(value);
  if (base === 'Timestamp' && value instanceof Date) return value.toISOString();
  return value;
}

function decodeRow(row, fields, dialect) {
  if (!row) return null;
  const out = {};
  for (const [field, type] of Object.entries(fields)) {
    const { base, list } = parseType(type);
    let v = row[field];
    if (v != null && dialect !== 'postgres' && (list || base === 'JSON')) {
      try { v = JSON.parse(v); } catch { /* leave as-is */ }
    }
    if (v != null && base === 'Boolean' && dialect !== 'postgres') v = !!v;
    out[field] = v;
  }
  return out;
}

// ---------- SQLite ----------
class SqliteStore {
  constructor(cfg) { this.cfg = cfg; this.dialect = 'sqlite'; }

  async init(schema) {
    const { DatabaseSync } = await import('node:sqlite');
    this.schema = schema;
    this.db = new DatabaseSync(this.cfg.path || './indexa.db');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS _indexa_checkpoints (
      source TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS _indexa_meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS _indexa_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, stream TEXT, block INTEGER,
      entity TEXT, entity_id TEXT, prev TEXT)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS _journal_lookup ON _indexa_journal(stream, block)`);
    this._journal = null; // { stream, block } when journaling is active
    for (const [entity, fields] of Object.entries(schema)) {
      const cols = Object.entries(fields).map(([f, t]) => {
        const { base, list } = parseType(t);
        const sqlT = sqlColumnType(base, list, 'sqlite');
        return f === 'id' ? `"${f}" ${sqlT} PRIMARY KEY` : `"${f}" ${sqlT}`;
      });
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${entity}" (${cols.join(', ')})`);
    }
  }

  async upsert(entity, id, data) {
    const fields = this.schema[entity];
    if (this._journal) {
      const before = this.db.prepare(`SELECT * FROM "${entity}" WHERE id = ?`).get(String(id));
      this.db.prepare(`INSERT INTO _indexa_journal (stream, block, entity, entity_id, prev)
        VALUES (?, ?, ?, ?, ?)`).run(
        this._journal.stream, this._journal.block, entity, String(id),
        before ? JSON.stringify(before) : null);
    }
    const record = { ...data, id };
    const cols = Object.keys(record).filter((k) => k in fields);
    const placeholders = cols.map(() => '?').join(', ');
    const updates = cols.filter((c) => c !== 'id').map((c) => `"${c}"=excluded."${c}"`).join(', ');
    const values = cols.map((c) => {
      const { base, list } = parseType(fields[c]);
      return encode(record[c], base, list, 'sqlite');
    });
    const sql = `INSERT INTO "${entity}" (${cols.map((c) => `"${c}"`).join(', ')})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates || '"id"="id"'}`;
    this.db.prepare(sql).run(...values);
  }

  async get(entity, id) {
    const row = this.db.prepare(`SELECT * FROM "${entity}" WHERE id = ?`).get(id);
    return decodeRow(row, this.schema[entity], 'sqlite');
  }

  async query(entity, { where = {}, orderBy, desc, limit = 100, offset = 0 } = {}) {
    const fields = this.schema[entity];
    if (!fields) throw new Error(`Unknown entity "${entity}"`);
    assertField(orderBy, fields, entity, 'orderBy');
    const conds = [];
    const params = [];
    for (const [k, v] of Object.entries(where)) {
      assertField(k, fields, entity, 'filter by');
      const { base, list } = parseType(fields[k]);
      conds.push(`"${k}" = ?`);
      params.push(encode(coerceScalar(v, base, list), base, list, 'sqlite'));
    }
    let sql = `SELECT * FROM "${entity}"`;
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    if (orderBy) sql += ` ORDER BY "${orderBy}" ${desc ? 'DESC' : 'ASC'}`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(clampInt(limit, 100), clampInt(offset, 0));
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => decodeRow(r, fields, 'sqlite'));
  }

  async getCheckpoint(source) {
    const row = this.db.prepare('SELECT cursor FROM _indexa_checkpoints WHERE source = ?').get(source);
    return row ? row.cursor : null;
  }

  async setCheckpoint(source, cursor) {
    this.db.prepare(`INSERT INTO _indexa_checkpoints (source, cursor, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`)
      .run(source, String(cursor), new Date().toISOString());
  }

  // --- key-value meta (used by connectors to persist state, e.g. block hashes) ---
  async kvGet(k) {
    const row = this.db.prepare('SELECT v FROM _indexa_meta WHERE k = ?').get(k);
    return row ? row.v : null;
  }
  async kvSet(k, v) {
    this.db.prepare(`INSERT INTO _indexa_meta (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v));
  }
  async kvDeletePrefix(prefix) {
    this.db.prepare("DELETE FROM _indexa_meta WHERE k LIKE ?").run(prefix + '%');
  }

  // --- reorg journaling ---
  enableJournal(stream) { /* tables already created in init; nothing else needed */ }
  setJournalContext(stream, block) { this._journal = stream == null ? null : { stream, block }; }

  async rollbackTo(stream, block) {
    const rows = this.db.prepare(
      'SELECT * FROM _indexa_journal WHERE stream = ? AND block > ? ORDER BY seq DESC').all(stream, block);
    for (const j of rows) {
      if (j.prev == null) {
        this.db.prepare(`DELETE FROM "${j.entity}" WHERE id = ?`).run(j.entity_id);
      } else {
        const prev = JSON.parse(j.prev);
        const cols = Object.keys(prev);
        const sql = `INSERT OR REPLACE INTO "${j.entity}" (${cols.map((c) => `"${c}"`).join(',')})
          VALUES (${cols.map(() => '?').join(',')})`;
        this.db.prepare(sql).run(...cols.map((c) => prev[c]));
      }
    }
    this.db.prepare('DELETE FROM _indexa_journal WHERE stream = ? AND block > ?').run(stream, block);
    return rows.length;
  }

  async pruneJournal(stream, beforeBlock) {
    this.db.prepare('DELETE FROM _indexa_journal WHERE stream = ? AND block <= ?').run(stream, beforeBlock);
  }

  async transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = await fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async close() { this.db?.close(); }
}

// ---------- Postgres ----------
class PostgresStore {
  constructor(cfg) { this.cfg = cfg; this.dialect = 'postgres'; }

  async init(schema) {
    let pg;
    try { pg = (await import('pg')).default; }
    catch { throw new Error('Postgres target requires the "pg" package. Run: npm install pg'); }
    this.schema = schema;
    this.pool = new pg.Pool({ connectionString: this.cfg.connection });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS _indexa_checkpoints (
      source TEXT PRIMARY KEY, cursor TEXT, updated_at TIMESTAMPTZ)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS _indexa_meta (k TEXT PRIMARY KEY, v TEXT)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS _indexa_journal (
      seq BIGSERIAL PRIMARY KEY, stream TEXT, block BIGINT,
      entity TEXT, entity_id TEXT, prev JSONB)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS _journal_lookup ON _indexa_journal(stream, block)`);
    this._journal = null;
    for (const [entity, fields] of Object.entries(schema)) {
      const cols = Object.entries(fields).map(([f, t]) => {
        const { base, list } = parseType(t);
        const sqlT = sqlColumnType(base, list, 'postgres');
        return f === 'id' ? `"${f}" ${sqlT} PRIMARY KEY` : `"${f}" ${sqlT}`;
      });
      await this.pool.query(`CREATE TABLE IF NOT EXISTS "${entity}" (${cols.join(', ')})`);
    }
  }

  async upsert(entity, id, data) {
    const fields = this.schema[entity];
    const client = this._tx || this.pool;
    if (this._journal) {
      const { rows: before } = await client.query(`SELECT * FROM "${entity}" WHERE id = $1`, [String(id)]);
      await client.query(`INSERT INTO _indexa_journal (stream, block, entity, entity_id, prev)
        VALUES ($1,$2,$3,$4,$5)`,
        [this._journal.stream, this._journal.block, entity, String(id), before[0] ? JSON.stringify(before[0]) : null]);
    }
    const record = { ...data, id };
    const cols = Object.keys(record).filter((k) => k in fields);
    const values = cols.map((c) => {
      const { base, list } = parseType(fields[c]);
      return encode(record[c], base, list, 'postgres');
    });
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updates = cols.filter((c) => c !== 'id').map((c) => `"${c}"=excluded."${c}"`).join(', ');
    const sql = `INSERT INTO "${entity}" (${cols.map((c) => `"${c}"`).join(', ')})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates || '"id"="id"'}`;
    await client.query(sql, values);
  }

  async get(entity, id) {
    const client = this._tx || this.pool;
    const { rows } = await client.query(`SELECT * FROM "${entity}" WHERE id = $1`, [id]);
    return decodeRow(rows[0], this.schema[entity], 'postgres');
  }

  async query(entity, { where = {}, orderBy, desc, limit = 100, offset = 0 } = {}) {
    const fields = this.schema[entity];
    if (!fields) throw new Error(`Unknown entity "${entity}"`);
    assertField(orderBy, fields, entity, 'orderBy');
    const conds = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(where)) {
      assertField(k, fields, entity, 'filter by');
      const { base, list } = parseType(fields[k]);
      conds.push(`"${k}" = $${i++}`);
      params.push(encode(coerceScalar(v, base, list), base, list, 'postgres'));
    }
    let sql = `SELECT * FROM "${entity}"`;
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    if (orderBy) sql += ` ORDER BY "${orderBy}" ${desc ? 'DESC' : 'ASC'}`;
    sql += ` LIMIT $${i++} OFFSET $${i++}`;
    params.push(clampInt(limit, 100), clampInt(offset, 0));
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => decodeRow(r, fields, 'postgres'));
  }

  async getCheckpoint(source) {
    const { rows } = await this.pool.query('SELECT cursor FROM _indexa_checkpoints WHERE source = $1', [source]);
    return rows[0] ? rows[0].cursor : null;
  }

  async setCheckpoint(source, cursor) {
    const client = this._tx || this.pool;
    await client.query(`INSERT INTO _indexa_checkpoints (source, cursor, updated_at)
      VALUES ($1, $2, now()) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=now()`,
      [source, String(cursor)]);
  }

  async kvGet(k) {
    const { rows } = await this.pool.query('SELECT v FROM _indexa_meta WHERE k = $1', [k]);
    return rows[0] ? rows[0].v : null;
  }
  async kvSet(k, v) {
    await this.pool.query(`INSERT INTO _indexa_meta (k, v) VALUES ($1, $2)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, String(v)]);
  }
  async kvDeletePrefix(prefix) {
    await this.pool.query("DELETE FROM _indexa_meta WHERE k LIKE $1", [prefix + '%']);
  }

  enableJournal(stream) {}
  setJournalContext(stream, block) { this._journal = stream == null ? null : { stream, block }; }

  async rollbackTo(stream, block) {
    const client = this._tx || this.pool;
    const { rows } = await client.query(
      'SELECT * FROM _indexa_journal WHERE stream = $1 AND block > $2 ORDER BY seq DESC', [stream, block]);
    for (const j of rows) {
      if (j.prev == null) {
        await client.query(`DELETE FROM "${j.entity}" WHERE id = $1`, [j.entity_id]);
      } else {
        const prev = typeof j.prev === 'string' ? JSON.parse(j.prev) : j.prev;
        const cols = Object.keys(prev);
        const ph = cols.map((_, i) => `$${i + 1}`).join(',');
        const updates = cols.map((c) => `"${c}"=excluded."${c}"`).join(',');
        await client.query(
          `INSERT INTO "${j.entity}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph})
           ON CONFLICT(id) DO UPDATE SET ${updates}`, cols.map((c) => prev[c]));
      }
    }
    await client.query('DELETE FROM _indexa_journal WHERE stream = $1 AND block > $2', [stream, block]);
    return rows.length;
  }

  async pruneJournal(stream, beforeBlock) {
    await this.pool.query('DELETE FROM _indexa_journal WHERE stream = $1 AND block <= $2', [stream, beforeBlock]);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    this._tx = client;
    try { await client.query('BEGIN'); const r = await fn(); await client.query('COMMIT'); return r; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { this._tx = null; client.release(); }
  }

  async close() { await this.pool?.end(); }
}

export function createStore(cfg) {
  switch (cfg.type) {
    case 'sqlite': return new SqliteStore(cfg);
    case 'postgres': return new PostgresStore(cfg);
    default: throw new Error(`Unknown target type: ${cfg.type}`);
  }
}
