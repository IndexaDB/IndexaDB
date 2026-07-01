// src/registry.js
const builtin = {
  csv: () => import('./connectors/csv.js'),
  postgres: () => import('./connectors/postgres.js'),
  evm: () => import('./connectors/evm.js'),
};

const custom = {};

// Allow users to register their own connector plugin:
//   import { registerConnector } from 'indexa';
//   registerConnector('kafka', KafkaConnector);
export function registerConnector(type, ConnectorClass) {
  custom[type] = ConnectorClass;
}

export async function loadConnector(type) {
  if (custom[type]) return custom[type];
  if (builtin[type]) {
    const mod = await builtin[type]();
    return mod.default;
  }
  throw new Error(`Unknown source type "${type}". Built-in: ${Object.keys(builtin).join(', ')}. ` +
    `Register custom ones with registerConnector().`);
}
