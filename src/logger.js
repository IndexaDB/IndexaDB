// src/logger.js
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS[process.env.INDEXA_LOG_LEVEL] ?? LEVELS.info;
let json = process.env.INDEXA_LOG_FORMAT === 'json';

const ts = () => new Date().toISOString();
// JSON.stringify throws on BigInt; coerce to string so logging never crashes.
const safe = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const fmt = (level, scope, msg, extra) => {
  if (json) {
    return safe({ ts: ts(), level, scope, msg, ...(extra ? { data: extra } : {}) });
  }
  const base = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  return extra ? `${base} ${safe(extra)}` : base;
};

export function createLogger(scope = 'indexa') {
  const make = (level) => (msg, extra) => {
    if (LEVELS[level] >= current) {
      const out = level === 'error' || level === 'warn' ? console.error : console.log;
      out(fmt(level, scope, msg, extra));
    }
  };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export function setLevel(level) {
  if (LEVELS[level] != null) current = LEVELS[level];
}

export function setFormat(format) {
  json = format === 'json';
}
