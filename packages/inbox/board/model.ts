/**
 * The Board page's rules, pure (approval "inbox-board", step 2; the look in
 * "inbox-board-look", the unread signal in "inbox-board-signal").
 *
 * - Lanes: the five live columns in COLUMNS.md set d order (Backlog,
 *   Designing, Your look, Building, Your review). Shipped and Icebox are links
 *   to their own lists; Dropped is listed on the Icebox page.
 * - A card (variant C "Lean") is two lines: the title, then "You: …" in the
 *   person's columns or the agent's last word otherwise, and its last-heard
 *   age on the right ("2d ago"). No counts on a card, no amber.
 * - Unread ("type: bold when unread, like mail"): an agent wrote to the card
 *   after the person's last look at the Board (isInboxCardUnread). The look
 *   moves when the Board is opened; the page keeps the marks it opened with
 *   for the visit, and a card the person opens or moves stops being bold.
 * - The person's moves: any live column, Ship, Icebox, Drop (reason), Restore.
 *   The store decides what is allowed; these say what the menu offers.
 */

import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  inboxCardLine,
  isInboxCardDropUnseen,
  isInboxCardPersonColumn,
  isInboxCardSentWaiting,
  isInboxCardUnread,
  type InboxCardHistoryEntry,
  type InboxAuthor,
  type InboxCardColumn,
  type InboxCardWire,
} from '@plannotator/core/inbox-types';

import type { ForgeRefCardData } from '@plannotator/core/forge-ref-card';

export type BoardView = 'lanes' | 'shipped' | 'icebox';

/** The Board's list a hash names (`#board=shipped`); anything else is the lanes. */
export function boardViewOf(value: string | null): BoardView {
  return value === 'shipped' || value === 'icebox' ? value : 'lanes';
}

/**
 * The Board's project filter (`#board&project=prj_…`, the key the list uses
 * for a project): only that project's cards, on the lanes, the counts, the
 * Shipped and Icebox lists and the agents' drops. Null: every card, as
 * before the filter existed.
 */
export function cardsInProject<T extends Pick<InboxCardWire, 'project_id'>>(cards: readonly T[], project: string | null): readonly T[] {
  return project ? cards.filter((card) => card.project_id === project) : cards;
}

/**
 * The projects the Board's Project menu offers: those with a card on the
 * Board in any column (a project of Shipped or Icebox cards only included),
 * in the sidebar's order, and the chosen project even with no card left, so
 * the menu always shows what is picked.
 */
export function boardProjects<P extends { id: string }>(cards: readonly Pick<InboxCardWire, 'project_id'>[], projects: readonly P[], chosen: string | null): P[] {
  const withCards = new Set(cards.map((card) => card.project_id));
  return projects.filter((project) => withCards.has(project.id) || project.id === chosen);
}

/** One lane: a live column and its cards, latest move first (the server's order). */
export interface BoardLane {
  column: InboxCardColumn;
  label: string;
  /** Your look and Your review: the person owes the next move. */
  onYou: boolean;
  cards: InboxCardWire[];
}

export function boardLanes(cards: readonly InboxCardWire[]): BoardLane[] {
  return INBOX_CARD_LIVE_COLUMNS.map((column) => ({
    column,
    label: INBOX_CARD_COLUMN_LABELS[column],
    onYou: isInboxCardPersonColumn(column),
    // A card the person sent to an agent sits at the top of Backlog until it moves (step 2 amendment).
    cards: cards
      .filter((card) => card.column === column)
      .map((card, index) => ({ card, index }))
      .sort((a, b) => Number(isInboxCardSentWaiting(b.card)) - Number(isInboxCardSentWaiting(a.card)) || a.index - b.index)
      .map(({ card }) => card),
  }));
}

/**
 * Where a New card goes unless the person picks another: the project the
 * Board is filtered to, else the project of the card heard from last, else
 * the first project.
 */
export function newCardProject(
  filter: string | null,
  projects: readonly { id: string }[],
  cards: readonly Pick<InboxCardWire, 'project_id' | 'heard_at'>[],
): string | null {
  const known = (id: string | null | undefined) => (id && projects.some((p) => p.id === id) ? id : null);
  const recent = [...cards].sort((a, b) => b.heard_at.localeCompare(a.heard_at)).find((card) => known(card.project_id));
  return known(filter) ?? recent?.project_id ?? projects[0]?.id ?? null;
}

/** Under this page width the Board's Project chip sits on a row of its own under the header (BoardPage). */
export const BOARD_FILTER_ROW_BELOW = 880;

/** A lane's least width, and the gap between lanes (inbox.css `.ib-lane`, `.ib-blanes`). */
export const BOARD_LANE_MIN = 188;
export const BOARD_LANE_GAP = 10;

/** How many whole lanes fit a width (at least one, at most the five). */
export function lanesThatFit(width: number): number {
  return Math.max(1, Math.min(INBOX_CARD_LIVE_COLUMNS.length, Math.floor((width + BOARD_LANE_GAP) / (BOARD_LANE_MIN + BOARD_LANE_GAP))));
}

/** The first lane of the window of `fit` lanes that shows lane `index`: centred on it, held at the ends. */
export function laneWindowStart(index: number, fit: number, total: number): number {
  return Math.max(0, Math.min(total - fit, index - Math.floor(fit / 2)));
}

/** The header's facts: cards in the live lanes, those on the person, and the two links' counts. */
export function boardCounts(cards: readonly InboxCardWire[]) {
  let inFlight = 0;
  let onYou = 0;
  let shipped = 0;
  let icebox = 0;
  let dropped = 0;
  for (const card of cards) {
    if (INBOX_CARD_LIVE_COLUMNS.includes(card.column)) inFlight += 1;
    if (isInboxCardPersonColumn(card.column)) onYou += 1;
    if (card.column === 'shipped') shipped += 1;
    if (card.column === 'icebox') icebox += 1;
    if (card.column === 'dropped') dropped += 1;
  }
  return { inFlight, onYou, shipped, icebox, dropped };
}

/** An agent's drops the person has not seen, newest first: the Board's "N dropped by an agent". */
export function unseenDrops(cards: readonly InboxCardWire[]): InboxCardWire[] {
  return cards.filter(isInboxCardDropUnseen).sort((a, b) => (b.dropped?.at ?? '').localeCompare(a.dropped?.at ?? ''));
}

/** The card's second line: "You: …" in the person's columns, the agent's last word otherwise (or nothing). */
export function cardLine(card: InboxCardWire): { you: boolean; text: string } | null {
  const line = inboxCardLine(card);
  if (!line) {
    // A card the person wrote with no word from an agent yet: its notes' first line.
    const notes = card.notes?.split('\n').find((part) => part.trim())?.trim();
    return notes ? { you: false, text: notes } : null;
  }
  if (isInboxCardPersonColumn(card.column) && card.you) return { you: true, text: card.you };
  return { you: false, text: line };
}

/**
 * How long ago anyone last wrote to the card, short: "now", "5m ago", "3h
 * ago", "2d ago", "5w ago". The words for a screen reader: "just now", "5
 * minutes ago", … (`long`).
 */
export function cardAge(iso: string, now: number = Date.now()): { short: string; long: string } {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { short: '', long: '' };
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return { short: 'now', long: 'just now' };
  const unit = (n: number, s: string, word: string) => ({ short: `${n}${s} ago`, long: `${n} ${word}${n === 1 ? '' : 's'} ago` });
  if (minutes < 60) return unit(minutes, 'm', 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'h', 'hour');
  const days = Math.floor(hours / 24);
  if (days < 14) return unit(days, 'd', 'day');
  return unit(Math.floor(days / 7), 'w', 'week');
}

/** Whether a card shows bold: unread at the visit's look, and not opened or moved by the person this visit. */
export function cardShowsUnread(card: InboxCardWire, visitLook: number | null, handled: ReadonlySet<string>): boolean {
  return !handled.has(card.id) && isInboxCardUnread(card, visitLook);
}

/** One thing the Move menu offers for a card. */
export type CardMove =
  | { kind: 'column'; column: InboxCardColumn; label: string }
  | { kind: 'ship'; label: string }
  | { kind: 'icebox'; label: string }
  | { kind: 'drop'; label: string }
  | { kind: 'restore'; label: string };

/**
 * The Move menu's items for a card. A live card: every other live column,
 * then Ship, Icebox and Drop…. A shipped card: back to a live column, Icebox,
 * Drop…. In the Icebox or Dropped: Restore (where it was), then Drop… for an
 * iceboxed one. The store refuses nothing the person may do here.
 */
export function cardMoves(card: InboxCardWire): CardMove[] {
  if (card.column === 'icebox' || card.column === 'dropped') {
    const back = card.aside_from ?? 'backlog';
    const out: CardMove[] = [{ kind: 'restore', label: `Restore to ${INBOX_CARD_COLUMN_LABELS[back]}` }];
    if (card.column === 'icebox') out.push({ kind: 'drop', label: 'Drop…' });
    return out;
  }
  const out: CardMove[] = INBOX_CARD_LIVE_COLUMNS.filter((column) => column !== card.column).map((column) => ({
    kind: 'column' as const,
    column,
    label: `Move to ${INBOX_CARD_COLUMN_LABELS[column]}`,
  }));
  if (card.column !== 'shipped') out.push({ kind: 'ship', label: 'Ship' });
  out.push({ kind: 'icebox', label: 'Move to Icebox' });
  out.push({ kind: 'drop', label: 'Drop…' });
  return out;
}

/** What the live region says after a move. */
export function moveSaid(card: InboxCardWire, moved: InboxCardWire): string {
  if (moved.column === 'dropped') return `Dropped “${card.title}”. It is kept under Icebox, Dropped.`;
  if (card.column === 'icebox' || card.column === 'dropped') return `Restored “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
  if (moved.column === 'shipped') return `Shipped “${card.title}”.`;
  return `Moved “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
}

/** The agent's name a card belongs to, or "You" for a card the person made. */
export function cardOwnerName(card: InboxCardWire): string {
  return card.agent?.kind === 'agent' ? inboxAgentName(card.agent) : 'You';
}

/** What the person owes on a card ("You: …"), only in Your look and Your review; null otherwise. */
export function cardYou(card: InboxCardWire): string | null {
  return isInboxCardPersonColumn(card.column) && card.you ? card.you : null;
}

/**
 * The thread where the person makes the call a card's "You: …" asks for (owner,
 * 2026-10-27: "it should take me to the thread where I need to make the call"):
 * the thread the card was sent in, else the linked thread with the latest
 * message (the later-linked one when the list does not hold it or on a tie).
 * Null when the card links no thread: the card opens instead.
 */
export function youThread(card: Pick<InboxCardWire, 'threads' | 'sent'>, rowOf: (threadId: string) => { last_at?: string } | null): string | null {
  const sent = card.sent?.thread_id;
  // A send links its thread (store.sendCard), and the wire drops a thread that is gone: so linked is enough.
  if (sent && card.threads.includes(sent)) return sent;
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const threadId of card.threads) {
    const at = Date.parse(rowOf(threadId)?.last_at ?? '');
    const time = Number.isNaN(at) ? -Infinity : at;
    if (best === null || time >= bestAt) {
      best = threadId;
      bestAt = time;
    }
  }
  return best;
}

/** The "You: …" link's accessible name: its visible words first (WCAG 2.5.3), then where it goes: "You: Merge #14, open the thread". */
export function youLinkLabel(you: string): string {
  return `You: ${you}, open the thread`;
}

/** The agent a sent card went to, while it waits in Backlog: "Sent to Codex". */
export function sentTo(card: InboxCardWire): string | null {
  return isInboxCardSentWaiting(card) && card.sent ? inboxAgentName(card.sent.to) : null;
}

/**
 * The opened card's foot: Send to an agent for a Backlog card nobody was
 * asked about (no agent, never sent), Restore in the Icebox or Dropped, else
 * Ship; Icebox and Drop… beside it where they apply.
 */
export function cardFoot(card: InboxCardWire): { primary: 'send' | 'start' | 'ship' | 'restore' | null; icebox: boolean; drop: boolean } {
  if (card.column === 'icebox') return { primary: 'restore', icebox: false, drop: true };
  if (card.column === 'dropped') return { primary: 'restore', icebox: false, drop: false };
  const unasked = card.column === 'backlog' && card.agent === null && card.sent === null;
  if (unasked) return { primary: 'send', icebox: true, drop: true };
  // A Backlog card with an agent (not just sent to it): Start tells that agent to begin (owner's note).
  if (card.column === 'backlog' && card.agent !== null && !isInboxCardSentWaiting(card)) return { primary: 'start', icebox: true, drop: true };
  return { primary: card.column === 'shipped' ? null : 'ship', icebox: true, drop: true };
}

/** The column menu on the opened card: the five lanes (the card's own checked), then Shipped and Icebox. */
export function columnChoices(card: InboxCardWire): { column: InboxCardColumn; label: string; current: boolean }[] {
  const columns: InboxCardColumn[] = [...INBOX_CARD_LIVE_COLUMNS, 'shipped', 'icebox'];
  return columns.map((column) => ({ column, label: INBOX_CARD_COLUMN_LABELS[column], current: card.column === column }));
}

/**
 * What a card sent to an agent says (owner's amendment: its notes are the
 * agent's message; the title when there are none), with one line naming the
 * card so the agent finds it in `card list` and moves it as the work goes.
 */
export function cardMessageBody(title: string, notes: string | null, cardId: string | null): string {
  const text = notes?.trim() ? notes.trim() : title;
  const which = cardId ? `, card ${cardId}` : "";
  return `${text}\n\n(This is “${title}” on my Board${which}. It is yours now: move it there as the work goes.)`;
}

/** An idempotency key for one message a dialog sends: its key, the session and the words, so a retry with the same words replays and a changed one is a new message. */
export function messageKey(key: string, session: string, body: string): string {
  let hash = 5381;
  for (let i = 0; i < body.length; i += 1) hash = ((hash << 5) + hash + body.charCodeAt(i)) >>> 0;
  return `${key}:${session}:${hash.toString(36)}`;
}

/** "Where is this?": the message "Ask for an update" sends to the card's agent. */
export function askWhereBody(card: Pick<InboxCardWire, 'id' | 'title'>): string {
  return `Where is “${card.title}”? (Board card ${card.id}) Move the card, or say where it stands with the card action.`;
}

/** Start (a Backlog card that has an agent): the short message telling it to begin, with the card's title and notes. */
export function startBody(card: Pick<InboxCardWire, 'id' | 'title' | 'notes'>): string {
  const notes = card.notes?.trim() ? `\n\n${card.notes.trim()}` : '';
  return `Please start on “${card.title}” (Board card ${card.id}).${notes}\n\nMove the card as the work goes.`;
}

/** A ref as the opened card writes it: its number (`#2018`, GitLab's `!7`), the repository left to the link. */
export function shortRef(ref: string): string {
  const match = /([#!]\d+)$/.exec(ref);
  return match ? match[1]! : ref;
}

function authorName(by: InboxAuthor): string {
  return by.kind === 'person' ? 'you' : inboxAgentName(by);
}

/** One history line, in words: a lead, the bold part, the rest, and a quote under it. */
export function historyWords(entry: InboxCardHistoryEntry): { before: string; bold: string | null; after: string; quote: string | null } {
  const by = authorName(entry.by);
  switch (entry.kind) {
    case 'created':
      return { before: `Created by ${by}`, bold: null, after: '', quote: null };
    case 'sent':
      return { before: 'Sent to ', bold: inboxAgentName(entry.to), after: entry.existing_thread ? ' in the card\u2019s thread' : ' in a new thread', quote: null };
    case 'moved':
      return { before: 'Moved to ', bold: INBOX_CARD_COLUMN_LABELS[entry.column], after: ` by ${by}`, quote: entry.you ? `You: “${entry.you}”` : null };
    case 'restored':
      return { before: 'Restored to ', bold: INBOX_CARD_COLUMN_LABELS[entry.column], after: ` by ${by}`, quote: null };
    case 'dropped':
      return { before: `Dropped by ${by}`, bold: null, after: '', quote: entry.reason ? `“${entry.reason}”` : null };
    case 'said':
      return { before: by === 'you' ? 'You' : by, bold: null, after: '', quote: `“${entry.text}”` };
    case 'you':
      return { before: `${by === 'you' ? 'You' : by} asked you`, bold: null, after: '', quote: `“${entry.text}”` };
    case 'linked_thread':
      return { before: 'Linked a thread', bold: null, after: by === 'you' ? '' : ` (${by})`, quote: null };
    case 'linked_ref':
      return { before: 'Linked ', bold: shortRef(entry.ref), after: '', quote: null };
    case 'renamed':
      return { before: 'Renamed by ', bold: null, after: by, quote: `“${entry.title}”` };
    case 'notes':
      return { before: `Notes edited by ${by}`, bold: null, after: '', quote: null };
  }
}

/**
 * A link's live state as the opened card shows it, the hover card's words
 * with the date it closed or merged: "Open", "Draft", "Merged Oct 20",
 * "Closed Oct 18", "Not planned". Display only: it never moves the card.
 */
export function refState(data: Pick<ForgeRefCardData, 'state' | 'kind' | 'closedAt'>): { label: string; tone: 'open' | 'merged' | 'closed' | 'neutral' } {
  const day = data.closedAt ? ` ${dayOfMonth(data.closedAt)}` : '';
  switch (data.state) {
    case 'open':
      return { label: 'Open', tone: 'open' };
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'merged':
      return { label: `Merged${day}`, tone: 'merged' };
    case 'completed':
      return { label: `Closed${day}`, tone: 'merged' };
    case 'not_planned':
      return { label: `Not planned${day}`, tone: 'neutral' };
    default:
      return { label: `Closed${day}`, tone: data.kind === 'pull' ? 'closed' : 'neutral' };
  }
}

function dayOfMonth(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The working state of a card's agent, from the live sessions: working, idle, or ended (not live). */
export function agentState(session: string | null, live: readonly { session: string; busy: boolean | null }[] | null): 'working' | 'idle' | 'ended' | null {
  if (!session || live === null) return null;
  const found = live.find((s) => s.session === session);
  return found ? (found.busy ? 'working' : 'idle') : 'ended';
}

/**
 * A card's whole accessible name: the title, its line, the lane, the age,
 * whether it is new, and where a click goes.
 */
export function cardLabel(card: InboxCardWire, unread: boolean, now: number = Date.now()): string {
  const parts = [card.title];
  const line = cardLine(card);
  if (line) parts.push(line.you ? `You: ${line.text}` : line.text);
  parts.push(INBOX_CARD_COLUMN_LABELS[card.column]);
  const age = cardAge(card.heard_at, now).long;
  if (age) parts.push(`last heard ${age}`);
  if (unread) parts.push(`new from ${cardOwnerName(card)}`);
  return parts.join('. ');
}
