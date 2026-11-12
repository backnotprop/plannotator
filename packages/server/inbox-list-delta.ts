import { randomBytes } from "node:crypto";
import { inboxListDeltaShape, inboxListRowsById, type InboxListDelta, type InboxListDeltaModel } from "@plannotator/core/inbox-list-delta";

const MAX_KINDS = 8;

const MAX_CHANGED_SHARE = 0.5;
const MIN_CHANGED_FOR_FULL = 16;

interface Kind {
  id: number;
  from: number;
  rows: Map<string, { hash: number | bigint; at: number }>;
}

export type InboxListAnswer<M> = (M & { list_version: string }) | (Omit<M, keyof InboxListDeltaModel> & { list_version: string; delta: InboxListDelta });

export function createInboxListVersions(options: { hash?: (text: string) => number | bigint } = {}) {
  const hash = options.hash ?? ((text: string) => Bun.hash(text));
  const run = randomBytes(6).toString("hex");
  const kinds = new Map<string, Kind>();
  let kindIds = 0;
  let version = 0;

  const kindOf = (key: string): Kind => {
    let kind = kinds.get(key);
    if (kind) {
      kinds.delete(key);
      kinds.set(key, kind);
      return kind;
    }
    kind = { id: ++kindIds, from: version + 1, rows: new Map() };
    kinds.set(key, kind);
    while (kinds.size > MAX_KINDS) kinds.delete(kinds.keys().next().value!);
    return kind;
  };

  const versionOf = (since: string | null, kind: Kind): number | null => {
    const match = since ? /^([0-9a-f]+)\.(\d+)\.(\d+)$/.exec(since) : null;
    if (!match || match[1] !== run || Number(match[2]) !== kind.id) return null;
    const at = Number(match[3]);
    return at >= kind.from && at <= version ? at : null;
  };

  const answer = <M extends InboxListDeltaModel>(key: string, model: M, since: string | null): InboxListAnswer<M> => {
    const kind = kindOf(key);
    const now = ++version;
    const listVersion = `${run}.${kind.id}.${now}`;
    const texts = new Map<unknown, string>();
    const textOf = (row: object) => {
      let text = texts.get(row);
      if (text === undefined) texts.set(row, (text = JSON.stringify(row)));
      return text;
    };
    const rows = inboxListRowsById(model, (a, b) => textOf(a) === textOf(b));
    if (!rows) {
      kind.rows.clear();
      kind.from = now + 1;
      return { ...model, list_version: listVersion };
    }
    const changed: InboxListDelta["rows"] = [];
    const base = versionOf(since, kind);
    for (const [id, row] of rows) {
      const h = hash(textOf(row));
      const held = kind.rows.get(id);
      const fresh = !held || held.hash !== h;
      if (fresh) kind.rows.set(id, { hash: h, at: now });
      if (base !== null && (fresh || held!.at > base)) changed.push(row);
    }
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
