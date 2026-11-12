import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_INITIATIVE_PEEK_THREADS,
  displayInboxSubject,
  type InboxAuthor,
  type InboxCardColumn,
  type InboxCardWire,
  type InboxListRow,
} from '@plannotator/core/inbox-types';

export const PEEK_ITEMS = 5;
export const PEEK_THREADS = INBOX_INITIATIVE_PEEK_THREADS;

export const PEEK_COLUMN_ORDER = ['in_review', 'in_progress', 'todo', 'backlog', 'done'] as const satisfies readonly InboxCardColumn[];
const RANK: ReadonlyMap<InboxCardColumn, number> = new Map(PEEK_COLUMN_ORDER.map((col, i) => [col, i]));

export interface PeekItem {
  id: string;
  title: string;
  col: InboxCardColumn;
  column: string;
}

export interface PeekThread {
  id: string;
  title: string;
  agent: InboxAuthor;
}

export interface InitiativePeekModel {
  cards: number;
  projects: string[];
  updated: string | null;
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

export interface TaggedThreads {
  threads: readonly string[];
  total: number;
}

export function initiativePeekModel(
  initiativeId: string,
  cards: readonly InboxCardWire[],
  rows: ReadonlyMap<string, InboxListRow>,
  projectNames: ReadonlyMap<string, string> = new Map(),
  tagged: TaggedThreads = { threads: [], total: 0 },
  exclude: string | null = null,
): InitiativePeekModel {
  const mine = cards.filter((card) => card.initiative === initiativeId && RANK.has(card.column));
  const ordered = [...mine].sort((a, b) => RANK.get(a.column)! - RANK.get(b.column)! || b.heard_at.localeCompare(a.heard_at));
  const items = ordered.map((card): PeekItem => ({ id: card.id, title: card.title, col: card.column, column: INBOX_CARD_COLUMN_LABELS[card.column] }));
  const byColumn = PEEK_COLUMN_ORDER.map((col) => ({ col, column: INBOX_CARD_COLUMN_LABELS[col], count: mine.filter((card) => card.column === col).length })).filter((c) => c.count > 0);
  const linked = new Set(mine.flatMap((card) => card.threads));
  const times = [...mine.map((card) => card.heard_at), ...[...linked].flatMap((id) => rows.get(id)?.last_at ?? [])].sort();
  const projects = [...new Set(mine.map((card) => projectNames.get(card.project_id)).filter((name): name is string => !!name))];
  const others = tagged.threads.filter((id) => id !== exclude && !linked.has(id));
  const linkedSince = tagged.threads.filter((id) => id !== exclude && linked.has(id)).length;
  const here = exclude !== null && tagged.threads.includes(exclude) ? 1 : 0;
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
    moreMentions: Math.max(0, tagged.total - here - linkedSince - mentions.length),
  };
}
