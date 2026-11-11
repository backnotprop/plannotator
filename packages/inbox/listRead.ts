import { applyInboxListDelta, type InboxListDelta, type InboxListDeltaModel } from '@plannotator/core/inbox-list-delta';

export type ListReadAnswer<M> = M | (Omit<M, keyof InboxListDeltaModel> & { delta: InboxListDelta });

export interface ListReader<M> {
  read: () => Promise<M>;
  reset: () => void;
}

const KEPT_LISTS = 4;

export function createListReader<M extends InboxListDeltaModel & { list_version?: string }>(fetchList: (since: string) => Promise<ListReadAnswer<M>>): ListReader<M> {
  const kept = new Map<string, M>();
  let held: { version: string; started: number } | null = null;
  let started = 0;
  let next: Promise<M> | null = null;

  const keep = (version: string, model: M) => {
    kept.delete(version);
    kept.set(version, model);
    while (kept.size > KEPT_LISTS) kept.delete(kept.keys().next().value!);
  };

  const once = async (): Promise<M> => {
    const mine = ++started;
    const answer = await fetchList(held?.version ?? '');
    let model: M | null;
    if ('delta' in answer && answer.delta) {
      const base = kept.get(answer.delta.since);
      model = base ? applyInboxListDelta<M>(base, answer) : null;
      if (!model) {
        kept.clear();
        held = null;
        return once();
      }
    } else model = answer as M;
    if (typeof model.list_version === 'string') {
      keep(model.list_version, model);
      if (!held || mine > held.started) held = { version: model.list_version, started: mine };
    }
    return model;
  };

  const read = (): Promise<M> => {
    if (next) return next;
    // A macrotask later, so every call of this tick joins it.
    const mine: Promise<M> = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      if (next === mine) next = null;
      return once();
    });
    next = mine;
    return mine;
  };

  return {
    read,
    reset: () => {
      kept.clear();
      held = null;
    },
  };
}
