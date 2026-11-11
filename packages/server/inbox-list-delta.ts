/**
 * Which list rows changed since a version the window holds (#2593; the
 * window's side and the wire are `packages/core/inbox-list-delta.ts`).
 *
 * The list is still computed whole on every read, exactly as before; only
 * the answer gets smaller. Per kind of list read (its query: the window always
 * asks the same one) the server keeps, for every row it last answered, a hash
 * of the row and the version at which it last changed, appeared or came back.
 * A read naming a version from this run and kind gets the rows changed after
 * it; every row it does not get is, by construction, the row the window
 * already holds. Anything else (no version, another run's, another kind's, a
 * version from before the kind was last reset, too many changes, one thread
 * with two different rows) gets the whole list, as before, plus a version.
 *
 * Only a read that asks (`since`, the window) is touched: the phone, a linked
 * machine and an older window ask without it and get the very same answer as
 * before. Memory: one small entry per row per kind, at most `MAX_KINDS` kinds.
 */

import { randomBytes } from "node:crypto";
import { inboxListDeltaShape, inboxListRowsById, type InboxListDelta, type InboxListDeltaModel } from "@plannotator/core/inbox-list-delta";
import type { InboxListRow } from "@plannotator/core/inbox-types";

/** Kinds of list read remembered at once (the window asks one; the rest is a bound). */
const MAX_KINDS = 8;

/** Past this share of the rows changed, the whole list is sent instead (it would be about as big). */
const MAX_CHANGED_SHARE = 0.5;
/** ...but a short list always gets its changes. */
const MIN_CHANGED_FOR_FULL = 16;

interface Kind {
  id: number;
  /** The first version this kind's rows are known from: an older one cannot be answered. */
  from: number;
  rows: Map<string, { hash: number | bigint; at: number }>;
}

export type InboxListAnswer<M> = (M & { list_version: string }) | (Omit<M, keyof InboxListDeltaModel> & { list_version: string; delta: InboxListDelta });

export function createInboxListVersions(options: { hash?: (text: string) => number | bigint } = {}) {
  const hash = options.hash ?? ((text: string) => Bun.hash(text));
  // A version names this run, so one from before a restart is never taken for one of now.
  const run = randomBytes(6).toString("hex");
  const kinds = new Map<string, Kind>();
  let kindIds = 0;
  let version = 0;

  const kindOf = (key: string): Kind => {
    let kind = kinds.get(key);
    if (kind) {
      // Most recently used last.
      kinds.delete(key);
      kinds.set(key, kind);
      return kind;
    }
    kind = { id: ++kindIds, from: version + 1, rows: new Map() };
    kinds.set(key, kind);
    while (kinds.size > MAX_KINDS) kinds.delete(kinds.keys().next().value!);
    return kind;
  };

  /** `run.kind.version` → the version, when it is this run's and this kind's. */
  const versionOf = (since: string | null, kind: Kind): number | null => {
    const match = since ? /^([0-9a-f]+)\.(\d+)\.(\d+)$/.exec(since) : null;
    if (!match || match[1] !== run || Number(match[2]) !== kind.id) return null;
    const at = Number(match[3]);
    return at >= kind.from && at <= version ? at : null;
  };

  /**
   * The answer to a list read of kind `key` (its query) whose whole model is
   * `model`: the model, or only what changed since `since`. Every answer
   * carries `list_version`, the version to name next time.
   */
  const answer = <M extends InboxListDeltaModel>(
    key: string,
    model: M,
    since: string | null,
    /** A row's hash already worked out (the list feed's, the same hash of the same JSON), so its JSON is not made again. */
    known?: (row: InboxListRow) => number | bigint | undefined,
  ): InboxListAnswer<M> => {
    const kind = kindOf(key);
    const now = ++version;
    const listVersion = `${run}.${kind.id}.${now}`;
    // The JSON of each row, as the answer sends it: the same text is the same row.
    const texts = new Map<unknown, string>();
    const textOf = (row: object) => {
      let text = texts.get(row);
      if (text === undefined) texts.set(row, (text = JSON.stringify(row)));
      return text;
    };
    const rows = inboxListRowsById(model, (a, b) => textOf(a) === textOf(b));
    if (!rows) {
      // One thread with two different rows (two linked machines claim it): never sent as a change. Start the kind
      // again, so no later change is measured from rows the window may hold either way.
      kind.rows.clear();
      kind.from = now + 1;
      return { ...model, list_version: listVersion };
    }
    const changed: InboxListDelta["rows"] = [];
    const base = versionOf(since, kind);
    for (const [id, row] of rows) {
      const h = known?.(row) ?? hash(textOf(row));
      const held = kind.rows.get(id);
      const fresh = !held || held.hash !== h;
      if (fresh) kind.rows.set(id, { hash: h, at: now });
      if (base !== null && (fresh || held!.at > base)) changed.push(row);
    }
    // Rows gone since: forgotten, so one that comes back is sent again.
    for (const id of kind.rows.keys()) if (!rows.has(id)) kind.rows.delete(id);
    if (base === null || (changed.length > MIN_CHANGED_FOR_FULL && changed.length > rows.size * MAX_CHANGED_SHARE)) {
      return { ...model, list_version: listVersion };
    }
    const { sections: _sections, snoozed: _snoozed, pins: _pins, ...rest } = model;
    return { ...rest, list_version: listVersion, delta: { since: since!, rows: changed, ...inboxListDeltaShape(model) } } as InboxListAnswer<M>;
  };

  return { answer };
}

export type InboxListVersions = ReturnType<typeof createInboxListVersions>;
