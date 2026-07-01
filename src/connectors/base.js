// src/connectors/base.js
//
// A Connector turns an external data source into one or more ordered "streams".
// Each stream has a stable key and a monotonic cursor so the engine can resume
// exactly where it left off (incremental sync) and stay idempotent.
//
// Implement this shape:
//
//   export default class MyConnector {
//     async init(cfg, ctx) {}            // cfg = config.source, ctx = { logger }
//     async streams() {
//       return [{
//         key: 'orders',                 // logical source name (used for handler routing)
//         async fetchBatch(fromCursor, limit) {
//           // fromCursor is null on first run, otherwise the last persisted cursor.
//           // Return records strictly AFTER fromCursor, ascending by cursor.
//           return {
//             records: [{ cursor: '<monotonic>', data: { ... } }],
//             done: true,                // true when no more historical rows remain (live tail)
//           };
//         },
//       }];
//     }
//     async close() {}
//   }
//
// The engine persists the cursor of the last successfully written record per stream,
// inside the same transaction as the entity writes — so a crash never double-writes
// and never skips.
export {};
