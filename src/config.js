// src/config.js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'BigInt', 'BigDecimal', 'JSON', 'Timestamp']);

// Replace ${VAR} and ${VAR:-default} with environment values.
function interpolate(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name, def) => {
      const v = process.env[name];
      if (v == null && def == null) {
        throw new Error(`Missing required env var: ${name}`);
      }
      return v ?? def ?? '';
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

function validate(cfg, file) {
  const errs = [];
  if (!cfg.source) errs.push('`source` is required');
  else if (!cfg.source.type) errs.push('`source.type` is required');

  if (!cfg.target) cfg.target = { type: 'sqlite', path: './indexa.db' };
  if (!cfg.target.type) errs.push('`target.type` is required');

  if (!cfg.schema || typeof cfg.schema !== 'object') {
    errs.push('`schema` is required and must define at least one entity');
  } else {
    for (const [entity, fields] of Object.entries(cfg.schema)) {
      if (!fields || typeof fields !== 'object') {
        errs.push(`schema.${entity} must be an object of field:type`);
        continue;
      }
      if (!('id' in fields)) errs.push(`schema.${entity} must have an "id" field`);
      for (const [field, type] of Object.entries(fields)) {
        const base = String(type).replace(/[!\[\]]/g, '');
        if (!SCALARS.has(base) && !cfg.schema[base]) {
          errs.push(`schema.${entity}.${field}: unknown type "${type}"`);
        }
      }
    }
  }

  // Numeric run options (validated before defaults are applied in loadConfig).
  if (cfg.batchSize != null && (!Number.isInteger(cfg.batchSize) || cfg.batchSize <= 0)) {
    errs.push('`batchSize` must be a positive integer');
  }
  if (cfg.pollIntervalMs != null && (typeof cfg.pollIntervalMs !== 'number' || cfg.pollIntervalMs < 0)) {
    errs.push('`pollIntervalMs` must be a non-negative number');
  }

  // Source-specific checks for built-in connectors. Custom source types validate
  // themselves in their own init(), so we only inspect the ones we ship.
  const s = cfg.source;
  if (s && s.type === 'csv') {
    const list = Array.isArray(s.sources) ? s.sources : [];
    if (list.length === 0 && !s.file) {
      errs.push('csv source needs `sources: [{ key, file }]` (or a single `file`)');
    }
    for (const src of list) if (!src || !src.file) errs.push('each csv source needs a `file`');
  } else if (s && s.type === 'postgres') {
    if (!s.connection) errs.push('postgres source needs a `connection` string');
    if (!Array.isArray(s.tables) || s.tables.length === 0) errs.push('postgres source needs `tables: [...]`');
  } else if (s && s.type === 'evm') {
    if (!s.rpc && !s.transport) errs.push('evm source needs an `rpc` URL');
    const contracts = Array.isArray(s.contracts) ? s.contracts : [];
    if (contracts.length === 0) errs.push('evm source needs `contracts: [...]`');
    for (const c of contracts) {
      if (!c || !c.address) errs.push('each evm contract needs an `address`');
      else if (!c.abi) errs.push(`evm contract ${c.address} needs an \`abi\``);
    }
  }

  if (errs.length) {
    throw new Error(`Invalid config (${file}):\n  - ${errs.join('\n  - ')}`);
  }
  return cfg;
}

export function loadConfig(file) {
  const abs = resolve(file);
  const raw = readFileSync(abs, 'utf8');
  const parsed = interpolate(yaml.load(raw));
  const cfg = validate(parsed, file);
  cfg.__dir = dirname(abs);
  cfg.name = cfg.name || 'indexa-app';
  cfg.batchSize = cfg.batchSize || 500;
  cfg.pollIntervalMs = cfg.pollIntervalMs ?? 2000;
  // Resolve a relative sqlite path against the config file's directory (consistent with source files).
  if (cfg.target.type === 'sqlite' && cfg.target.path && !cfg.target.path.startsWith('/')) {
    cfg.target.path = resolve(cfg.__dir, cfg.target.path);
  }
  return cfg;
}

export { SCALARS };
