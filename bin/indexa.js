#!/usr/bin/env node
// bin/indexa.js
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/api.js';
import { generateTypes } from '../src/schema.js';
import { createLogger, setLevel } from '../src/logger.js';

const logger = createLogger('cli');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

const HELP = `
indexa — declarative database indexer

Usage:
  indexa deploy   --config <file> [--port 4000] [--once] [--no-api]
  indexa validate --config <file>
  indexa types    --config <file>      generate TypeScript types for handlers
  indexa init     [dir]                scaffold a starter project

Env:
  INDEXA_LOG_LEVEL=debug|info|warn|error
`;

async function cmdDeploy(args) {
  if (args.loglevel) setLevel(args.loglevel);
  const cfg = loadConfig(args.config);
  const engine = new Engine(cfg, logger);
  await engine.setup();

  let server;
  if (!args['no-api']) {
    const port = Number(args.port) || 4000;
    server = createApi(engine.store, cfg, { logger: logger.child('api') });
    await new Promise((r) => server.listen(port, r));
    logger.info(`query API listening`, { url: `http://localhost:${port}` });
  }

  const shutdown = async () => {
    logger.info('shutting down...');
    engine.stop();
    server?.close();
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.once) {
    await engine.backfill();
    logger.info('backfill complete (--once), exiting');
    if (!args['no-api']) logger.info('API still up; Ctrl+C to exit'); else await shutdown();
  } else {
    await engine.watch();
  }
}

async function cmdValidate(args) {
  const cfg = loadConfig(args.config);
  logger.info('config valid', {
    name: cfg.name,
    source: cfg.source.type,
    target: cfg.target.type,
    entities: Object.keys(cfg.schema),
  });
}

async function cmdTypes(args) {
  const cfg = loadConfig(args.config);
  const file = generateTypes(cfg.schema, cfg.__dir);
  logger.info('types generated', { file });
}

function cmdInit(args) {
  const dir = resolve(args._[0] || 'indexa-app');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const cfgPath = join(dir, 'indexa.config.yaml');
  if (existsSync(cfgPath)) { logger.error('already initialized'); return; }
  writeFileSync(cfgPath, `name: my-indexer

source:
  type: csv
  sources:
    - { key: orders, file: data/orders.csv }

target:
  type: sqlite
  path: ./indexa.db

# Optional: only needed when raw columns != entity shape.
handlers: ./handlers.js

schema:
  Order:
    id: ID
    customer: String
    total: BigDecimal
    status: String
    created_at: Timestamp
`);
  writeFileSync(join(dir, 'handlers.js'), `// Optional handlers. Delete this file to use automatic column->entity mapping.
export default {
  async orders(row, ctx) {
    await ctx.store.upsert('Order', row.id, {
      id: row.id,
      customer: row.customer,
      total: row.total,
      status: row.status,
      created_at: row.created_at,
    });
  },
};
`);
  writeFileSync(join(dir, 'data', 'orders.csv'),
    `id,customer,total,status,created_at
1,Alice,120.50,paid,2026-01-02T10:00:00Z
2,Bob,80.00,pending,2026-01-02T11:30:00Z
3,Alice,42.25,paid,2026-01-03T09:15:00Z
`);
  logger.info('project created', { dir });
  logger.info('next steps', { run: `cd ${dir} && indexa deploy --config indexa.config.yaml` });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'deploy': return await cmdDeploy(args);
      case 'validate': return await cmdValidate(args);
      case 'types': return await cmdTypes(args);
      case 'init': return cmdInit(args);
      case 'help': case undefined: console.log(HELP); return;
      default: console.log(`Unknown command: ${cmd}\n${HELP}`); process.exit(1);
    }
  } catch (e) {
    logger.error(e.message);
    if (process.env.INDEXA_LOG_LEVEL === 'debug') console.error(e.stack);
    process.exit(1);
  }
}

main();
