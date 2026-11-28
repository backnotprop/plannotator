import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { InboxCardWire } from '@plannotator/core/inbox-types';
import { InboxHeldError, inboxApi, type CardsModel, type ListModel } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { machineOf } from '../inboxUrl';
import { errorToast } from '../toastError';
import type { BoardMove } from './model';

/** The window's Board writes: a card move and the agents' drops seen, each on the machine that holds the card. */
export function useBoardWrites(context: {
  listTags: ListModel['tags'] | null;
  handleCard: (id: string) => void;
  setCards: Dispatch<SetStateAction<CardsModel | null>>;
  refreshCards: () => Promise<CardsModel | null>;
  showToast: (next: Omit<InboxToastModel, 'id'>) => void;
}) {
  const { listTags, handleCard, setCards, refreshCards, showToast } = context;
  /**
   * A card a write answered, as the merged Board draws it: a linked machine's answer is that machine's own card, so it
   * gets its machine back and its tag reads as the merged tag of that name (the list's `tags`).
   */
  const boardCard = (card: InboxCardWire): InboxCardWire => {
    const machine = machineOf(card.id);
    if (!machine) return card;
    const tag = card.initiative ? (listTags ?? []).find((t) => t.machines?.[machine] === card.initiative) : undefined;
    return { ...card, machine, initiative: tag ? tag.id : (card.initiative ?? null) };
  };
  /** `held`: the move waits for an asleep linked machine (its clock toast says so); null: it did not land. */
  const moveCard = async (card: InboxCardWire, change: BoardMove): Promise<InboxCardWire | 'held' | null> => {
    handleCard(card.id);
    try {
      const moved = boardCard((await inboxApi.moveCard(card.id, change)).card);
      setCards((model) => (model ? { ...model, cards: model.cards.map((c) => (c.id === moved.id ? moved : c)) } : model));
      void refreshCards();
      return moved;
    } catch (cause) {
      void refreshCards();
      if (cause instanceof InboxHeldError) {
        showToast(errorToast(cause, ''));
        return 'held';
      }
      return null;
    }
  };
  const seeDrops = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    // Each machine marks its own cards' drops seen.
    const byMachine = new Map<string | null, string[]>();
    for (const id of ids) byMachine.set(machineOf(id), [...(byMachine.get(machineOf(id)) ?? []), id]);
    void Promise.allSettled([...byMachine].map(([machine, own]) => inboxApi.seeDrops(own, machine)))
      .then(() => refreshCards())
      .catch(() => {});
  }, [refreshCards]);
  return { boardCard, moveCard, seeDrops };
}
