// Stateful handler: maintains a running Customer aggregate by READING the
// previously-indexed entity, then writing the updated value. The engine
// guarantees each source row is processed exactly once (checkpointing),
// so these increments are safe.
export default {
  async orders(row, ctx) {
    // 1) raw fact
    await ctx.store.upsert('Order', row.id, {
      id: row.id, customer: row.customer, total: row.total, status: row.status,
    });

    // 2) derived aggregate (read-modify-write)
    if (row.status === 'refunded') return;
    const existing = await ctx.store.get('Customer', row.customer);
    const prevSpent = existing ? Number(existing.totalSpent) : 0;
    const prevCount = existing ? Number(existing.orderCount) : 0;
    await ctx.store.upsert('Customer', row.customer, {
      id: row.customer,
      name: row.customer,
      totalSpent: prevSpent + Number(row.total),
      orderCount: prevCount + 1,
    });
  },
};
