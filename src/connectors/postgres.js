// src/connectors/postgres.js
//
// Tails one or more Postgres tables incrementally using a monotonic cursor column
// (e.g. an auto-increment id, or an updated_at timestamp). This is the
// "production" source: point it at a table and it backfills history, then keeps
// pulling new/changed rows on each poll.
export default class PostgresConnector {
  async init(cfg, ctx) {
    let pg;
    try { pg = (await import('pg')).default; }
    catch { throw new Error('Postgres source requires the "pg" package. Run: npm install pg'); }
    this.cfg = cfg;
    this.logger = ctx.logger;
    this.pool = new pg.Pool({ connectionString: cfg.connection });
    // tables: [{ key, table, cursorColumn }]  (cursorColumn defaults to "id")
    this.tables = (cfg.tables || []).map((t) =>
      typeof t === 'string' ? { key: t, table: t, cursorColumn: 'id' }
        : { key: t.key || t.table, table: t.table, cursorColumn: t.cursorColumn || 'id' });
  }

  async streams() {
    return this.tables.map((t) => {
      const pool = this.pool;
      const col = t.cursorColumn;
      return {
        key: t.key,
        async fetchBatch(fromCursor, limit) {
          const params = [];
          let where = '';
          if (fromCursor != null) { where = `WHERE "${col}" > $1`; params.push(fromCursor); }
          params.push(limit);
          const sql = `SELECT * FROM "${t.table}" ${where} ORDER BY "${col}" ASC LIMIT $${params.length}`;
          const { rows } = await pool.query(sql, params);
          const records = rows.map((r) => ({ cursor: r[col], data: r }));
          // not "done" until a partial batch returns -> means we've caught up
          return { records, done: rows.length < limit };
        },
      };
    });
  }

  async close() { await this.pool?.end(); }
}
