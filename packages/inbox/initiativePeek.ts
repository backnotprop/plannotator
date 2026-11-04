/**
 * What a sent `#Shape` previews (approval "board-hashtags", round 8). Pure:
 * InitiativePeek draws it.
 *
 * Cards: the initiative's Board cards (Cancelled left out) as one list in the
 * Board's order (In review, In progress, Todo, Backlog, Done last), capped,
 * the rest "+N more"; one count per column that has cards, in the same order.
 * Threads: the other threads a message tags it in (the cards read's
 * `initiative_threads`, latest first), minus the ones a card of it links and
 * the thread the tag sits in; capped, the rest "+N more".
 */
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_INITIATIVE_PEEK_THREADS,
  displayInboxSubject,
  type InboxAuthor,
  type InboxCardColumn,
  type InboxCardWire,
  type InboxListRow,
} from '@plannotator/core/inbox-types';

/** Cards listed before "+N more". */
export const PEEK_ITEMS = 5;
export const PEEK_THREADS = INBOX_INITIATIVE_PEEK_THREADS;

/** The Board's lanes from the furthest along that is still open, Done last (Cancelled never shows). */
export const PEEK_COLUMN_ORDER = ['in_review', 'in_progress', 'todo', 'backlog', 'done'] as const satisfies readonly InboxCardColumn[];
const RANK: ReadonlyMap<InboxCardColumn, number> = new Map(PEEK_COLUMN_ORDER.map((col, i) => [col, i]));

export interface PeekItem {
  id: string;
  title: string;
  col: InboxCardColumn;
  /** The column's name, in its badge. */
  column: string;
}

export interface PeekThread {
  id: string;
  title: string;
  /** Who the thread is with (the list's mark). */
  agent: InboxAuthor;
}

export interface InitiativePeekModel {
  /** Every card in it (Cancelled left out). */
  cards: number;
  /** The projects its cards are in, by name, in the order first seen. */
  projects: string[];
  /** The last time anyone wrote to one of its cards or their threads, or null. */
  updated: string | null;
  /** How many cards sit in each column that has any, in the Board's order. */
  byColumn: { col: InboxCardColumn; column: string; count: number }[];
  items: PeekItem[];
  moreItems: number;
  mentions: PeekThread[];
  moreMentions: number;
}

function threadOf(row: InboxListRow): PeekThread {
  return {
    id: row.thread_id,
    title: displayInboxSubject(row.subject) ?? row.thread_name ?? 'Untitled thread',
    agent: row.addressee ? ({ kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } as InboxAuthor) : row.author,
  };
}

export function initiativePeekModel(
  initiativeId: string,
  cards: readonly InboxCardWire[],
  rows: ReadonlyMap<string, InboxListRow>,
  projectNames: ReadonlyMap<string, string> = new Map(),
  tagged: readonly string[] = [],
  exclude: string | null = null,
): InitiativePeekModel {
  const mine = cards.filter((card) => card.initiative === initiativeId && RANK.has(card.column));
  // Within a column, the card last heard from first.
  const ordered = [...mine].sort((a, b) => RANK.get(a.column)! - RANK.get(b.column)! || b.heard_at.localeCompare(a.heard_at));
  const items = ordered.map((card): PeekItem => ({ id: card.id, title: card.title, col: card.column, column: INBOX_CARD_COLUMN_LABELS[card.column] }));
  const byColumn = PEEK_COLUMN_ORDER.map((col) => ({ col, column: INBOX_CARD_COLUMN_LABELS[col], count: mine.filter((card) => card.column === col).length })).filter((c) => c.count > 0);
  const linked = new Set(mine.flatMap((card) => card.threads));
  const times = [...mine.map((card) => card.heard_at), ...[...linked].flatMap((id) => rows.get(id)?.last_at ?? [])].sort();
  const projects = [...new Set(mine.map((card) => projectNames.get(card.project_id)).filter((name): name is string => !!name))];
  // The count is of ids (the server sends every one); only the shown few need a row.
  const others = tagged.filter((id) => id !== exclude && !linked.has(id));
  const mentions = others
    .map((id) => rows.get(id))
    .filter((row): row is InboxListRow => !!row)
    .slice(0, PEEK_THREADS)
    .map(threadOf);
  return {
    cards: mine.length,
    projects,
    updated: times.at(-1) ?? null,
    byColumn,
    items: items.slice(0, PEEK_ITEMS),
    moreItems: Math.max(0, items.length - PEEK_ITEMS),
    mentions,
    moreMentions: Math.max(0, others.length - mentions.length),
  };
}
