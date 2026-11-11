import type { InboxListRow, InboxListSection } from "./inbox-types";

/** The model's lists of rows besides the sections: kept in order by id in a delta. */
export const INBOX_LIST_DELTA_LISTS = ["snoozed", "pins"] as const;
export type InboxListDeltaList = (typeof INBOX_LIST_DELTA_LISTS)[number];

/** A section in a delta: its id and label, and its rows by thread id, in order. */
export type InboxListDeltaSection = Omit<InboxListSection, "threads"> & { threads: string[] };

/** The `delta` of a list read answered as a change (`?since=` named a version the server still knows). */
export interface InboxListDelta {
  since: string;
  rows: InboxListRow[];
  sections: InboxListDeltaSection[];
  lists: Partial<Record<InboxListDeltaList, string[]>>;
}

/** What a list model needs for a delta: its sections, and the other lists of rows when it has them. */
export interface InboxListDeltaModel {
  sections: InboxListSection[];
  snoozed?: InboxListRow[];
  pins?: InboxListRow[];
}

/** Every row of a model by thread id; null when one id stands for two different rows (never sent as a delta). */
export function inboxListRowsById(model: InboxListDeltaModel, same: (a: InboxListRow, b: InboxListRow) => boolean): Map<string, InboxListRow> | null {
  const rows = new Map<string, InboxListRow>();
  const add = (row: InboxListRow): boolean => {
    const held = rows.get(row.thread_id);
    if (held && held !== row && !same(held, row)) return false;
    if (!held) rows.set(row.thread_id, row);
    return true;
  };
  for (const section of model.sections) for (const row of section.threads) if (!add(row)) return null;
  for (const list of INBOX_LIST_DELTA_LISTS) for (const row of model[list] ?? []) if (!add(row)) return null;
  return rows;
}

/** The order of a model, by thread id: what a delta carries besides the changed rows. */
export function inboxListDeltaShape(model: InboxListDeltaModel): Pick<InboxListDelta, "sections" | "lists"> {
  const lists: InboxListDelta["lists"] = {};
  for (const list of INBOX_LIST_DELTA_LISTS) {
    const rows = model[list];
    if (Array.isArray(rows)) lists[list] = rows.map((row) => row.thread_id);
  }
  return { sections: model.sections.map((section) => ({ ...section, threads: section.threads.map((row) => row.thread_id) })), lists };
}

export function applyInboxListDelta<M extends InboxListDeltaModel>(base: M, answer: Omit<M, keyof InboxListDeltaModel> & { delta: InboxListDelta }): M | null {
  const rows = inboxListRowsById(base, () => true);
  if (!rows) return null;
  for (const row of answer.delta.rows) rows.set(row.thread_id, row);
  let missing = false;
  const take = (ids: readonly string[]): InboxListRow[] =>
    ids.map((id) => {
      const row = rows.get(id);
      if (!row) missing = true;
      return row!;
    });
  const { delta, ...rest } = answer;
  const model = { ...rest, sections: delta.sections.map((section) => ({ ...section, threads: take(section.threads) })) } as Record<string, unknown>;
  for (const list of INBOX_LIST_DELTA_LISTS) {
    const ids = delta.lists[list];
    if (ids) model[list] = take(ids);
  }
  return missing ? null : (model as unknown as M);
}
