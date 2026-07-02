// src/api.js
import http from 'node:http';

const RESERVED = new Set(['limit', 'offset', 'orderBy', 'desc']);
// Query-string operator suffixes: ?total_gte=100&status_in=paid,pending
const FILTER_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'ne', 'in', 'like']);

// Turn flat query params into a store `where` object, supporting operator
// suffixes (field_gte) and comma lists for `in`. Exact field names win over the
// suffix parse, so a field literally named foo_in stays an equality filter.
function parseWhere(searchParams, schemaFields) {
  const where = {};
  const add = (field, op, value) => {
    if (op === 'eq' && where[field] === undefined) { where[field] = value; return; }
    if (where[field] === undefined || typeof where[field] !== 'object' || Array.isArray(where[field])) {
      const prev = where[field];
      where[field] = {};
      if (prev !== undefined) where[field].eq = prev;
    }
    where[field][op] = value;
  };
  for (const [k, v] of searchParams.entries()) {
    if (RESERVED.has(k)) continue;
    if (k in schemaFields) { add(k, 'eq', v); continue; }
    const idx = k.lastIndexOf('_');
    if (idx > 0) {
      const field = k.slice(0, idx);
      const op = k.slice(idx + 1);
      if (FILTER_OPS.has(op) && field in schemaFields) {
        add(field, op, op === 'in' ? v.split(',') : v);
      }
    }
  }
  return where;
}

function send(res, code, body, headers) {
  const json = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(json);
}

// Build an HTTP server that exposes every schema entity as a queryable REST resource.
//   createApi(store, cfg, { logger })
export function createApi(store, cfg, { logger } = {}) {
  const entities = Object.keys(cfg.schema);
  const startedAt = Date.now();

  // CORS: this is a read-only query API, so a permissive default is convenient
  // for browsers / dApps. Override via config:
  //   api.cors: false            -> no CORS headers
  //   api.cors: true (default)   -> Access-Control-Allow-Origin: *
  //   api.cors: "https://x.com"  -> that exact origin
  const corsOpt = cfg.api?.cors ?? true;
  const corsOrigin = corsOpt === true ? '*' : (corsOpt || null);
  const cors = corsOrigin ? {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  } : {};

  // Resolve a path segment to an entity, tolerating case and a trailing plural.
  const resolveEntity = (seg) => {
    const norm = (s) => s.toLowerCase().replace(/s$/, '');
    return entities.find((e) => e.toLowerCase() === seg.toLowerCase())
      || entities.find((e) => norm(e) === norm(seg));
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let status = 200;
    const reply = (code, body) => { status = code; send(res, code, body, cors); };
    try {
      if (req.method === 'OPTIONS') { // CORS preflight
        status = 204;
        res.writeHead(204, cors);
        return res.end();
      }
      if (req.method !== 'GET') {
        return reply(405, { error: `Method ${req.method} not allowed` });
      }

      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts.length === 0) {
        return reply(200, {
          app: cfg.name,
          entities,
          endpoints: entities.flatMap((e) => [`GET /${e}`, `GET /${e}/:id`]),
          schema: cfg.schema,
        });
      }
      if (parts[0] === '_health') {
        try {
          const checkpoints = await store.allCheckpoints();
          return reply(200, {
            ok: true,
            app: cfg.name,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
            checkpoints,
          });
        } catch (e) {
          return reply(503, { ok: false, error: e.message });
        }
      }

      const entity = resolveEntity(parts[0]);
      if (!entity) return reply(404, { error: `Unknown entity "${parts[0]}"` });

      if (parts.length >= 2) { // GET /<entity>/:id
        const row = await store.get(entity, decodeURIComponent(parts[1]));
        return row ? reply(200, row) : reply(404, { error: 'Not found' });
      }

      // GET /<entity> — filtered list with pagination
      const where = parseWhere(url.searchParams, cfg.schema[entity]);
      const orderBy = url.searchParams.get('orderBy') || undefined;
      if (orderBy && !(orderBy in cfg.schema[entity])) {
        return reply(400, { error: `Cannot orderBy "${orderBy}": not a field of ${entity}` });
      }
      const limit = Math.max(0, Math.min(Number(url.searchParams.get('limit')) || 100, 1000));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const [rows, total] = await Promise.all([
        store.query(entity, { where, limit, offset, orderBy, desc: url.searchParams.get('desc') === 'true' }),
        store.count(entity, where),
      ]);
      return reply(200, { data: rows, count: rows.length, total, limit, offset });
    } catch (e) {
      reply(500, { error: e.message });
    } finally {
      logger?.debug('request', { method: req.method, path: req.url, status, ms: Date.now() - started });
    }
  });

  return server;
}
