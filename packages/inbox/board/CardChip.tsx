import { INBOX_CARD_COLUMN_LABELS, type InboxCardWire } from '@plannotator/core/inbox-types';

export function CardChip({ card, onOpen }: { card: InboxCardWire | null; onOpen: () => void }) {
  if (!card) return null;
  const column = INBOX_CARD_COLUMN_LABELS[card.column];
  return (
    <button type="button" className="ib-cardchip" onClick={onOpen} data-thread-card={card.id} aria-label={`Board card: ${card.title}, ${column}. Open the card`}>
      <span className="ib-lane-dot" data-col={card.column} aria-hidden="true" />
      <b dir="auto">{card.title}</b>
      <span>· {column}</span>
    </button>
  );
}
