/**
 * What a sent `#Shape` previews (prototype "board-hashtags", the owner: "a
 * hover effect on any initiative rendered in the chat, that shows me all the
 * things relevant to the initiative"). Pure: InitiativePeek draws it.
 *
 * Cards: the few that matter most, the ones waiting on the person first (In
 * review with a "You: …", or a linked thread the Inbox lists as waiting, the
 * Board's own two rules), then In progress, In review, Todo, Backlog, Done;
 * the most recently heard from first within each. Threads: those the cards
 * link that the list knows, latest first, the waiting ones marked.
 */
import { INBOX_CARD_COLUMN_LABELS, INBOX_CARD_LIVE_COLUMNS, displayInboxSubject, type InboxAuthor, type InboxCardColumn, type InboxCardWire, type InboxListRow } from '@plannotator/core/inbox-types';
import { cardLine, waitingThread } from './board/model';

export const PEEK_CARDS = 4;
export const PEEK_THREADS = 3;
/** Round 5's one list: at most this many rows. */
export const PEEK_ITEMS = 5;

const ORDER: Readonly<Record<InboxCardColumn, number>> = { in_progress: 0, in_review: 1, todo: 2, backlog: 3, done: 4, dropped: 5 };
/** Round 7's list order: the Board's lanes from the furthest along that is still open, Done last. */
const BOARD_ORDER: Readonly<Record<InboxCardColumn, number>> = { in_review: 0, in_progress: 1, todo: 2, backlog: 3, done: 4, dropped: 5 };
const WAITING_SECTIONS: ReadonlySet<string> = new Set(['stopped', 'holding', 'waiting']);

export interface PeekCard {
  id: string;
  title: string;
  /** The column id (the Board's lane dot) and its name. */
  col: InboxCardColumn;
  column: string;
  /** The agent the card is with (the Board's mark), or null for the person's own card. */
  agent: InboxAuthor | null;
  /** What the person owes ("You: …"), or "Waiting on you" from a linked thread; null when nothing waits on them. */
  you: string | null;
}

export interface PeekThread {
  id: string;
  title: string;
  /** Who the thread is with (the list's mark). */
  agent: InboxAuthor;
  last_at: string;
  waiting: boolean;
}

/**
 * One row of the preview (round 5, "one list"): a card with its threads folded
 * in, so a piece of work is listed once. `ask` is what the person owes: the
 * card's "You: …", else the open question of a linked thread that waits on
 * them (the Inbox list's own rule, `threadWaits`), else that thread's subject.
 * `thread` is where the row goes: the waiting thread, else its latest thread;
 * a card with none goes to the card on the Board.
 */
export interface PeekItem {
  id: string;
  title: string;
  col: InboxCardColumn;
  column: string;
  agent: InboxAuthor | null;
  ask: string | null;
  thread: string | null;
}

export interface InitiativePeekModel {
  /** Every card in it (dropped left out), how many wait on the person, every thread the list knows. */
  totals: { cards: number; waiting: number; threads: number };
  /** "Active" (work on the lanes), "Done" (all of it done), "Empty". */
  state: 'active' | 'done' | 'empty';
  /** The projects its cards are in, by name, in the order first seen. */
  projects: string[];
  /** The last time anyone wrote to one of its cards or threads, or null. */
  updated: string | null;
  cards: PeekCard[];
  moreCards: number;
  threads: PeekThread[];
  moreThreads: number;
  /** Round 5: every card once, its threads folded in; waiting first. `waiting` counts these rows, so the count and the rows agree. */
  items: PeekItem[];
  moreItems: number;
  waitingItems: number;
  /** How many cards sit in each column, in the Board's order (Done last), for a one-line summary. */
  byColumn: { col: InboxCardColumn; column: string; count: number }[];
  /** Round 7: the other threads a message tags it in, that no card of it links (nor `exclude`), latest first; capped. */
  mentions: PeekThread[];
  moreMentions: number;
}

export function threadWaits(row: Pick<InboxListRow, 'section' | 'waiting_on_person'> | null | undefined): boolean {
  return !!row && (row.waiting_on_person || WAITING_SECTIONS.has(row.section));
}

function threadOf(row: InboxListRow): PeekThread {
  return {
    id: row.thread_id,
    title: displayInboxSubject(row.subject) ?? row.thread_name ?? 'Untitled thread',
    agent: row.addressee ? ({ kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } as InboxAuthor) : row.author,
    last_at: row.last_at,
    waiting: threadWaits(row),
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
  const rowOf = (id: string) => rows.get(id) ?? null;
  const mine = cards.filter((card) => card.initiative === initiativeId && card.column !== 'dropped');
  const shaped = mine.map((card) => {
    const line = cardLine(card);
    const you = line?.you ? line.text : waitingThread(card, rowOf) ? 'Waiting on you' : null;
    return { card, you };
  });
  shaped.sort((a, b) => Number(!!b.you) - Number(!!a.you) || ORDER[a.card.column] - ORDER[b.card.column] || b.card.heard_at.localeCompare(a.card.heard_at));
  const threadIds = [...new Set(mine.flatMap((card) => card.threads))];
  const threads = threadIds
    .map((id) => rows.get(id))
    .filter((row): row is InboxListRow => !!row)
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
    .map(threadOf);
  const items = [...mine]
    .sort((a, b) => b.heard_at.localeCompare(a.heard_at))
    .map((card): PeekItem => {
      const line = cardLine(card);
      // Its threads the list knows, latest first. One waits on the person only in the list's own sections
      // (Stopped on you, Holding up work, Waiting on you), the Board's rule: a thread that is only New does not.
      const known = card.threads.map((id) => rows.get(id)).filter((row): row is InboxListRow => !!row).sort((a, b) => b.last_at.localeCompare(a.last_at));
      const waits = known.find((row) => WAITING_SECTIONS.has(row.section)) ?? null;
      const asked = waits ? (waits.waits?.[0]?.prompt ?? waits.questions?.prompt ?? displayInboxSubject(waits.subject) ?? 'Reply in the thread') : null;
      const ask = line?.you ? line.text : asked;
      return { id: card.id, title: card.title, col: card.column, column: INBOX_CARD_COLUMN_LABELS[card.column], agent: card.agent, ask, thread: (waits ?? known[0])?.thread_id ?? null };
    })
    // Round 7: the Board's column order only (In review, In progress, Todo, Backlog, Done last); no waiting-first.
    .sort((a, b) => BOARD_ORDER[a.col] - BOARD_ORDER[b.col]);
  const byColumn = (Object.keys(ORDER) as InboxCardColumn[])
    .map((col) => ({ col, column: INBOX_CARD_COLUMN_LABELS[col], count: mine.filter((card) => card.column === col).length }))
    .filter((c) => c.count > 0);
  const times = [...mine.map((card) => card.heard_at), ...threads.map((t) => t.last_at)].sort();
  const projects = [...new Set(mine.map((card) => projectNames.get(card.project_id)).filter((name): name is string => !!name))];
  const linked = new Set(mine.flatMap((card) => card.threads));
  const mentioned = tagged
    .filter((id) => id !== exclude && !linked.has(id))
    .map((id) => rows.get(id))
    .filter((row): row is InboxListRow => !!row)
    .map(threadOf);
  return {
    mentions: mentioned.slice(0, PEEK_THREADS),
    moreMentions: Math.max(0, mentioned.length - PEEK_THREADS),
    totals: { cards: mine.length, waiting: shaped.filter((s) => s.you).length, threads: threads.length },
    state: mine.some((card) => INBOX_CARD_LIVE_COLUMNS.includes(card.column)) ? 'active' : mine.length > 0 ? 'done' : 'empty',
    projects,
    updated: times.at(-1) ?? null,
    cards: shaped.slice(0, PEEK_CARDS).map(({ card, you }) => ({ id: card.id, title: card.title, col: card.column, column: INBOX_CARD_COLUMN_LABELS[card.column], agent: card.agent, you })),
    moreCards: Math.max(0, shaped.length - PEEK_CARDS),
    threads: threads.slice(0, PEEK_THREADS),
    moreThreads: Math.max(0, threads.length - PEEK_THREADS),
    items: items.slice(0, PEEK_ITEMS),
    moreItems: Math.max(0, items.length - PEEK_ITEMS),
    waitingItems: items.filter((item) => item.ask).length,
    byColumn,
  };
}
