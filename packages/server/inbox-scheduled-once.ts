/**
 * The window's create of a routine, once per `idempotency_key`. The editor saves a new routine by itself (after a
 * typing pause, on a retry, and with `keepalive` as the page goes), and a page reloaded or restored mid-create sends its
 * kept draft again with the same key: each answers the one routine that key made, never a second. The key is kept on
 * the record (`create_key`), so this holds across an Inbox restart; `inflight` holds only the creates under way, so
 * one sent twice at once makes one. A key whose create failed, or whose routine is gone, makes it again.
 */
import { InboxError } from "@plannotator/shared/inbox/schema";

export const CREATE_KEY_MAX = 128;

export function createOnce<Rec, Row>(inflight: Map<string, Promise<unknown>>) {
  return async (key: unknown, create: (key: string | undefined) => Promise<Rec>, find: (key: string) => Row | null, rowOf: (record: Rec) => Row): Promise<Row> => {
    if (key === undefined || key === null || key === "") return rowOf(await create(undefined));
    if (typeof key !== "string" || key.length > CREATE_KEY_MAX) throw new InboxError("validation_error", `idempotency_key: a string of at most ${CREATE_KEY_MAX} characters.`, { field: "idempotency_key" });
    // Wait out every create under way with this key (one that failed leaves it free), then look again.
    for (let before = inflight.get(key); before; before = inflight.get(key)) await before.catch(() => {});
    const found = find(key);
    if (found) return found;
    const pending = create(key);
    inflight.set(key, pending);
    try {
      return rowOf(await pending);
    } finally {
      if (inflight.get(key) === pending) inflight.delete(key);
    }
  };
}
