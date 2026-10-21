/**
 * The Board (approval "inbox-board", step 2): the pure rules the page draws
 * from. Columns are COLUMNS.md's set d, Asked · Designing · Your look ·
 * Building · Your review; Shipped and the Icebox are links in the Board's
 * header, and dropped cards are listed on the Icebox page under "Dropped".
 *
 * A card is variant C, "Lean": two lines, its title, then "You: …" in the
 * person's columns (Your look, Your review) and the agent's last word
 * otherwise, with how long ago anyone last wrote to it ("2d ago"). There is no
 * amber (the owner dropped it, amendment of 2026-10-20) and nothing here
 * decides that a card is stalled: the age is shown as a fact.
 */

import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  isInboxCardDropUnseen,
  isInboxCardPersonColumn,
  type InboxCardColumn,
  type InboxCardWire,
  type InboxComposeProject,
} from '@plannotator/core/inbox-types';

/** Which Board page is open: the live lanes, or one of the header's links. */
export type BoardView = 'live' | 'shipped' | 'icebox';

export interface BoardLane {
  column: InboxCardColumn;
  label: string;
  /** Your look and Your review: the card waits on the person ("on you"). */
  onYou: boolean;
  cards: InboxCardWire[];
}

export interface BoardModel {
  lanes: BoardLane[];
  /** Cards in a live lane. */
  inFlight: number;
  /** Cards in Your look and Your review: the sidebar's Board count. */
  onYou: number;
  shipped: InboxCardWire[];
  icebox: InboxCardWire[];
  dropped: InboxCardWire[];
  /** An agent's drops the person has not looked at yet: "N dropped by an agent". */
  droppedByAgent: InboxCardWire[];
}

const byTimeDesc = (at: (card: InboxCardWire) => string) => (a: InboxCardWire, b: InboxCardWire) => at(b).localeCompare(at(a)) || a.id.localeCompare(b.id);

/**
 * The Board as the page draws it. Inside a lane the latest move comes first
 * (the store's own order); Shipped by when it shipped, the Icebox by when it
 * was paused, Dropped by when it was dropped, newest first.
 */
export function boardOf(cards: readonly InboxCardWire[]): BoardModel {
  const lanes: BoardLane[] = INBOX_CARD_LIVE_COLUMNS.map((column) => ({
    column,
    label: INBOX_CARD_COLUMN_LABELS[column],
    onYou: isInboxCardPersonColumn(column),
    cards: cards.filter((card) => card.column === column).sort(byTimeDesc((card) => card.moved_at)),
  }));
  const inFlight = lanes.reduce((n, lane) => n + lane.cards.length, 0);
  const onYou = lanes.filter((lane) => lane.onYou).reduce((n, lane) => n + lane.cards.length, 0);
  const shipped = cards.filter((card) => card.column === 'shipped').sort(byTimeDesc((card) => card.moved_at));
  const icebox = cards.filter((card) => card.column === 'icebox').sort(byTimeDesc((card) => card.moved_at));
  const dropped = cards.filter((card) => card.column === 'dropped').sort(byTimeDesc((card) => card.dropped?.at ?? card.moved_at));
  return { lanes, inFlight, onYou, shipped, icebox, dropped, droppedByAgent: dropped.filter(isInboxCardDropUnseen) };
}

/** The card's second line: "You: …" (`you`) in the person's columns, the agent's last word otherwise. */
export function cardLine(card: Pick<InboxCardWire, 'column' | 'you' | 'said'>): { you: boolean; text: string } | null {
  if (isInboxCardPersonColumn(card.column) && card.you) return { you: true, text: card.you };
  return card.said ? { you: false, text: card.said } : null;
}

/** Who the card belongs to, as the person reads it: the agent's name, or "You" for a card they made. */
export function cardAgentName(card: Pick<InboxCardWire, 'agent'>): string {
  return card.agent ? inboxAgentName(card.agent) : 'You';
}

/** Who did something (a drop, the last write), as the person reads it. */
export function authorName(author: InboxCardWire['heard_by']): string {
  return author.kind === 'person' ? 'you' : inboxAgentName(author);
}

/**
 * How long ago `iso` was, short: "just now", "5m ago", "3h ago", "2d ago",
 * "6w ago" (from 14 days). The card's last-heard age, in place of amber.
 */
export function ageShort(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** The same age for a screen reader: "2 days ago". */
export function ageWords(iso: string, nowMs: number): string {
  const short = ageShort(iso, nowMs);
  const m = /^(\d+)([mhdw]) ago$/.exec(short);
  if (!m) return short;
  const n = Number(m[1]);
  const unit = ({ m: 'minute', h: 'hour', d: 'day', w: 'week' } as const)[m[2] as 'm' | 'h' | 'd' | 'w'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** The columns the person can move a card to from the open card: the five live ones, and Shipped. */
export const CARD_MOVE_COLUMNS: readonly InboxCardColumn[] = [...INBOX_CARD_LIVE_COLUMNS, 'shipped'];

/**
 * The words "Ask where this is" puts in a new message to the card's agent:
 * the card's title and id, so the agent can find the card and update it.
 */
export function askWhereText(card: Pick<InboxCardWire, 'id' | 'title'>): string {
  return `Where is “${card.title}”? Please say where it stands, and update its card (${card.id}) so the Board shows it.`;
}

/** "1 card", "3 cards". */
export function cardCount(n: number): string {
  return `${n} card${n === 1 ? '' : 's'}`;
}

/**
 * Where "Ask where this is" goes (the owner's accepted default): the card's
 * own agent session while it is live (`own`), else a live session in the
 * card's project, else nowhere (null: nobody can be asked now). `host` names
 * the session's agent.
 */
export function askTarget(
  card: Pick<InboxCardWire, 'agent' | 'project_id'>,
  projects: readonly InboxComposeProject[] | null | undefined,
): { session: string; own: boolean; host: string } | null {
  if (!projects) return null;
  const own = card.agent?.kind === 'agent' ? card.agent.session : null;
  if (own) {
    for (const p of projects) {
      const live = p.sessions.find((s) => s.session === own);
      if (live) return { session: own, own: true, host: live.host };
    }
  }
  const other = projects.find((p) => p.project.id === card.project_id)?.sessions[0];
  // A card the person made has no agent of its own: any live session in its project is "its" session.
  return other ? { session: other.session, own: !own, host: other.host } : null;
}
