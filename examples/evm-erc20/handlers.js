// examples/evm-erc20/handlers.js
//
// One handler per event name. Indexa decodes the log and gives you `event.args`.
// Reorg safety is automatic: if a block is reverted, the engine rolls back every
// write below (including these balance mutations) before re-indexing the new chain.
const ZERO = '0x0000000000000000000000000000000000000000';

async function adjustBalance(ctx, address, delta) {
  if (address.toLowerCase() === ZERO) return; // skip mint/burn sink
  const h = await ctx.store.get('Holder', address);
  const prev = h ? BigInt(h.balance) : 0n;
  const count = h ? Number(h.transferCount) : 0;
  await ctx.store.upsert('Holder', address, {
    id: address,
    address,
    balance: (prev + delta).toString(),
    transferCount: count + 1,
  });
}

export default {
  async Transfer(event, ctx) {
    const { from, to, value } = event.args;

    // 1) raw fact
    await ctx.store.upsert('Transfer', event.id, {
      id: event.id,
      from,
      to,
      value: String(value),
      blockNumber: event.blockNumber,
      txHash: event.txHash,
    });

    // 2) derived balances (read-modify-write; safe under reorg via the undo journal)
    const v = BigInt(value);
    await adjustBalance(ctx, from, -v);
    await adjustBalance(ctx, to, v);
  },
};
