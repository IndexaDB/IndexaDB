// examples/custom-connector/webhook-connector.js
//
// Example: a custom source connector you write yourself and register.
// This one replays records from an in-memory array, but the same shape works
// for Kafka, an HTTP webhook buffer, an EVM chain (block number as cursor), etc.
//
// Usage:
//   import { registerConnector } from 'indexa';
//   import WebhookConnector from './webhook-connector.js';
//   registerConnector('webhook', WebhookConnector);
//
// Then in indexa.config.yaml:
//   source:
//     type: webhook
export default class WebhookConnector {
  async init(cfg, ctx) {
    this.logger = ctx.logger;
    // In real life: connect to Kafka / open a queue / subscribe to chain logs.
    this.buffer = cfg.seed || [];
    this.offset = 0;
  }

  async streams() {
    const self = this;
    return [{
      key: 'events',
      async fetchBatch(fromCursor, limit) {
        const from = fromCursor ? Number(fromCursor) : 0;
        const records = self.buffer
          .filter((e) => e.seq > from)
          .slice(0, limit)
          .map((e) => ({ cursor: e.seq, data: e }));
        // done=false would keep the engine polling for live data
        return { records, done: true };
      },
    }];
  }

  async close() {}
}
