// src/logger.js
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS[process.env.INDEXA_LOG_LEVEL] ?? LEVELS.info;

const ts = () => new Date().toISOString();
const fmt = (level, scope, msg, extra) => {
  const base = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  return extra ? `${base} ${JSON.stringify(extra)}` : base;
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
