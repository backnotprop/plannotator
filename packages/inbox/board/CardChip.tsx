import { INBOX_CARD_COLUMN_LABELS, type InboxCardWire } from '@plannotator/core/inbox-types';

/**
 * The chip a thread opened from a Board card carries under its subject (as
 * mocked): the card's column dot, its title and its column. A button: it goes
 * back to the opened card, as "‹ Board" does.
 */
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
