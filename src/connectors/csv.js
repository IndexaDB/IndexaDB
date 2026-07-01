// src/connectors/csv.js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, commas, newlines).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

export default class CsvConnector {
  async init(cfg, ctx) {
    this.cfg = cfg;
    this.logger = ctx.logger;
    this.dir = ctx.dir;
    // sources: [{ key, file }]  OR  file + key shorthand
    this.sources = cfg.sources || [{ key: cfg.key || 'rows', file: cfg.file }];
  }

  async streams() {
    return this.sources.map((s) => {
      const path = resolve(this.dir, s.file);
      const rows = parseCSV(readFileSync(path, 'utf8'));
      const header = rows[0];
      const dataRows = rows.slice(1).map((cells, idx) => {
        const obj = {};
        header.forEach((h, i) => { obj[h] = cells[i]; });
        return { cursor: idx + 1, data: obj }; // 1-based row index as cursor
      });
      return {
        key: s.key,
        async fetchBatch(fromCursor, limit) {
          const from = fromCursor ? Number(fromCursor) : 0;
          const batch = dataRows.filter((r) => r.cursor > from).slice(0, limit);
          return { records: batch, done: true };
        },
      };
    });
  }

  async close() {}
}
