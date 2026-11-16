/**
 * The window's create of a routine, once per `idempotency_key`. The editor saves a new routine by itself (after a
 * typing pause, on a retry, and with `keepalive` as the page goes), and a page reloaded mid-create sends its kept
 * draft again with the same key: each answers the one routine that key made, never a second. Held in memory for the
 * Inbox's life (the last 500 keys); a key whose create failed, or whose routine is gone, makes it again.
 */
export function createOnce<Rec extends { id: string }, Row>(made: Map<string, Promise<string>>) {
  return async (key: unknown, create: () => Promise<Rec>, read: (id: string) => Row | null, rowOf: (record: Rec) => Row): Promise<Row> => {
    if (typeof key !== "string" || !key) return rowOf(await create());
    const before = made.get(key);
    if (before) {
      const row = await before.then(read, () => null);
      if (row) return row;
    }
    let record: Rec | null = null;
    const pending = create().then((r) => ((record = r), r.id));
    made.set(key, pending);
    pending.catch(() => made.get(key) === pending && made.delete(key));
    while (made.size > 500) made.delete(made.keys().next().value!);
    await pending;
    return rowOf(record!);
  };
}
