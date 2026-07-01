// src/api.js
import http from 'node:http';

const RESERVED = new Set(['limit', 'offset', 'orderBy', 'desc']);

function send(res, code, body) {
  const json = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json);
}

// Build an HTTP server that exposes every schema entity as a queryable REST resource.
export function createApi(store, cfg) {
  const entities = Object.keys(cfg.schema);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts.length === 0) {
        return send(res, 200, {
          app: cfg.name,
          entities,
          endpoints: entities.flatMap((e) => [`GET /${e}`, `GET /${e}/:id`]),
          schema: cfg.schema,
        });
      }
      if (parts[0] === '_health') return send(res, 200, { ok: true });

      const norm = (s) => s.toLowerCase().replace(/s$/, '');
      const entity = entities.find((e) => e.toLowerCase() === parts[0].toLowerCase())
        || entities.find((e) => norm(e) === norm(parts[0]));
      if (!entity) return send(res, 404, { error: `Unknown entity "${parts[0]}"` });

      if (parts.length === 2) {
        const row = await store.get(entity, parts[1]);
        return row ? send(res, 200, row) : send(res, 404, { error: 'Not found' });
      }

      const where = {};
      for (const [k, v] of url.searchParams.entries()) {
        if (!RESERVED.has(k) && k in cfg.schema[entity]) where[k] = v;
      }
      const rows = await store.query(entity, {
        where,
        limit: Math.min(Number(url.searchParams.get('limit')) || 100, 1000),
        offset: Number(url.searchParams.get('offset')) || 0,
        orderBy: url.searchParams.get('orderBy') || undefined,
        desc: url.searchParams.get('desc') === 'true',
      });
      return send(res, 200, { data: rows, count: rows.length });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  return server;
}
