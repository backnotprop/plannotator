import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  inboxCardLine,
  isInboxCardDropUnseen,
  isInboxCardPersonColumn,
  isInboxCardSentWaiting,
  isInboxCardUnread,
  isInboxInitiativeId,
  INBOX_NO_INITIATIVE,
  type InboxInitiative,
  type InboxCardHistoryEntry,
  type InboxAuthor,
  type InboxCardColumn,
  type InboxCardWire,
} from '@plannotator/core/inbox-types';

import type { ForgeRefCardData } from '@plannotator/core/forge-ref-card';

export type BoardView = 'lanes' | 'done' | 'cancelled';

export function boardViewOf(value: string | null): BoardView {
  if (value === 'done' || value === 'cancelled') return value;
  if (value === 'shipped') return 'done';
  return value === 'icebox' ? 'cancelled' : 'lanes';
}

export function cardsInProject<T extends Pick<InboxCardWire, 'project_id'>>(cards: readonly T[], project: string | null): readonly T[] {
  return project ? cards.filter((card) => card.project_id === project) : cards;
}

export function cardsInInitiative<T extends Pick<InboxCardWire, 'initiative'>>(
  cards: readonly T[],
  initiative: string | null,
  live?: readonly Pick<InboxInitiative, 'id'>[],
): readonly T[] {
  if (initiative === null) return cards;
  if (initiative === INBOX_NO_INITIATIVE) {
    const ids = live ? new Set(live.map((i) => i.id)) : null;
    return cards.filter((card) => !card.initiative || (ids !== null && !ids.has(card.initiative)));
  }
  return cards.filter((card) => card.initiative === initiative);
}

export function liveInitiatives(initiatives: readonly InboxInitiative[] | undefined): InboxInitiative[] {
  return (initiatives ?? []).filter((initiative) => initiative.deleted_at === null);
}

export function initiativeCounts(cards: readonly Pick<InboxCardWire, 'initiative'>[], live: readonly Pick<InboxInitiative, 'id'>[]): Map<string, number> {
  const counts = new Map<string, number>([[INBOX_NO_INITIATIVE, 0], ...live.map((i) => [i.id, 0] as [string, number])]);
  for (const card of cards) {
    const key = card.initiative && counts.has(card.initiative) ? card.initiative : INBOX_NO_INITIATIVE;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function boardInitiativeOf(value: string | null | undefined, live: readonly Pick<InboxInitiative, 'id'>[] | null): string | null {
  if (!value) return null;
  if (value === INBOX_NO_INITIATIVE) return value;
  if (!isInboxInitiativeId(value)) return null;
  return live === null || live.some((i) => i.id === value) ? value : null;
}

export function boardFilterHash(filter: { project?: string | null; initiative?: string | null }): string {
  return (
    (filter.project ? `&project=${encodeURIComponent(filter.project)}` : '') + (filter.initiative ? `&initiative=${encodeURIComponent(filter.initiative)}` : '')
  );
}

export function newCardInitiative(filter: string | null): string | null {
  return filter && filter !== INBOX_NO_INITIATIVE ? filter : null;
}

export function initiativeName(initiatives: readonly InboxInitiative[] | undefined, id: string | null): string | null {
  if (!id) return null;
  return initiatives?.find((i) => i.id === id)?.name ?? null;
}

export function boardProjects<P extends { id: string }>(cards: readonly Pick<InboxCardWire, 'project_id'>[], projects: readonly P[], chosen: string | null): P[] {
  const withCards = new Set(cards.map((card) => card.project_id));
  return projects.filter((project) => withCards.has(project.id) || project.id === chosen);
}

export const BOARD_LANE_COLUMNS: readonly InboxCardColumn[] = [...INBOX_CARD_LIVE_COLUMNS, 'done'];

export const DONE_LANE_MS = 7 * 24 * 60 * 60 * 1000;

export function inDoneLane(card: Pick<InboxCardWire, 'column' | 'moved_at'>, now: number): boolean {
  if (card.column !== 'done') return false;
  const at = Date.parse(card.moved_at);
  return !Number.isNaN(at) && now - at < DONE_LANE_MS;
}

export interface BoardLane {
  column: InboxCardColumn;
  label: string;
  onYou: boolean;
  cards: InboxCardWire[];
}

export function boardLanes(cards: readonly InboxCardWire[], now: number = Date.now()): BoardLane[] {
  return BOARD_LANE_COLUMNS.map((column) => ({
    column,
    label: INBOX_CARD_COLUMN_LABELS[column],
    onYou: isInboxCardPersonColumn(column),
    cards: cards
      .filter((card) => (column === 'done' ? inDoneLane(card, now) : card.column === column))
      .map((card, index) => ({ card, index }))
      .sort((a, b) => Number(isInboxCardSentWaiting(b.card)) - Number(isInboxCardSentWaiting(a.card)) || a.index - b.index)
      .map(({ card }) => card),
  }));
}

const WAITING_SECTIONS: ReadonlySet<string> = new Set(['stopped', 'holding', 'waiting']);

export function waitingThread(card: Pick<InboxCardWire, 'column' | 'threads'>, rowOf: (threadId: string) => { section?: string } | null | undefined): string | null {
  if (!INBOX_CARD_LIVE_COLUMNS.includes(card.column) || isInboxCardPersonColumn(card.column)) return null;
  return card.threads.find((threadId) => WAITING_SECTIONS.has(rowOf(threadId)?.section ?? '')) ?? null;
}

export function newCardProject(
  filter: string | null,
  projects: readonly { id: string }[],
  cards: readonly Pick<InboxCardWire, 'project_id' | 'heard_at'>[],
): string | null {
  const known = (id: string | null | undefined) => (id && projects.some((p) => p.id === id) ? id : null);
  const recent = [...cards].sort((a, b) => b.heard_at.localeCompare(a.heard_at)).find((card) => known(card.project_id));
  return known(filter) ?? recent?.project_id ?? projects[0]?.id ?? null;
}

export const BOARD_FILTER_ROW_BELOW = 880;

export const BOARD_LANE_MIN = 188;
export const BOARD_LANE_GAP = 10;

export function lanesThatFit(width: number): number {
  return Math.max(1, Math.min(BOARD_LANE_COLUMNS.length, Math.floor((width + BOARD_LANE_GAP) / (BOARD_LANE_MIN + BOARD_LANE_GAP))));
}

export function laneWindowStart(index: number, fit: number, total: number): number {
  return Math.max(0, Math.min(total - fit, index - Math.floor(fit / 2)));
}

export function boardCounts(cards: readonly InboxCardWire[]) {
  let done = 0;
  let dropped = 0;
  for (const card of cards) {
    if (card.column === 'done') done += 1;
    if (card.column === 'dropped') dropped += 1;
  }
  return { done, dropped };
}

export function unseenDrops(cards: readonly InboxCardWire[]): InboxCardWire[] {
  return cards.filter(isInboxCardDropUnseen).sort((a, b) => (b.dropped?.at ?? '').localeCompare(a.dropped?.at ?? ''));
}

export function cardLine(card: InboxCardWire): { you: boolean; text: string } | null {
  const line = inboxCardLine(card);
  if (!line) {
    const notes = card.notes?.split('\n').find((part) => part.trim())?.trim();
    return notes ? { you: false, text: notes } : null;
  }
  if (isInboxCardPersonColumn(card.column) && card.you) return { you: true, text: card.you };
  return { you: false, text: line };
}

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

export function cardShowsUnread(card: InboxCardWire, visitLook: number | null, handled: ReadonlySet<string>): boolean {
  return !handled.has(card.id) && isInboxCardUnread(card, visitLook);
}

export type BoardMove = { op: 'move'; column: InboxCardColumn } | { op: 'drop'; reason?: string | null } | { op: 'restore' };

export type CardMenuItem =
  | { kind: 'thread'; threadId: string; label: string }
  | { kind: 'column'; column: InboxCardColumn; label: string; current: boolean }
  | { kind: 'restore'; label: string }
  | { kind: 'drop'; label: string };

export function cardMenuItems(card: InboxCardWire, thread: string | null): CardMenuItem[][] {
  if (card.column === 'dropped') return [];
  const groups: CardMenuItem[][] = [];
  if (thread) groups.push([{ kind: 'thread', threadId: thread, label: 'Open thread' }]);
  const choices = columnChoices(card).map((choice) => ({ kind: 'column' as const, ...choice }));
  groups.push(choices.slice(0, INBOX_CARD_LIVE_COLUMNS.length), choices.slice(INBOX_CARD_LIVE_COLUMNS.length));
  groups.push([{ kind: 'drop', label: 'Cancel…' }]);
  return groups;
}

export function cardMenuToast(card: InboxCardWire, moved: InboxCardWire): { lead: string; detail: string; undo: BoardMove } | null {
  if (moved.column === card.column) return null;
  const detail = `“${card.title}”`;
  if (moved.column === 'dropped') return { lead: 'Cancelled', detail, undo: { op: 'restore' } };
  if (moved.column === 'done' && INBOX_CARD_LIVE_COLUMNS.includes(card.column)) return { lead: 'Done', detail, undo: { op: 'move', column: card.column } };
  return null;
}

export function initiativeDeletedToast(deleted: readonly Pick<InboxInitiative, 'name'>[]): { lead: string; detail: string } {
  return { lead: 'Deleted', detail: deleted.length === 1 ? `“${deleted[0]!.name}”` : `${deleted.length} initiatives` };
}

export function cardUndoStillApplies(moved: Pick<InboxCardWire, 'column' | 'moved_at'>, now: Pick<InboxCardWire, 'column' | 'moved_at'> | null): boolean {
  return now !== null && now.column === moved.column && now.moved_at === moved.moved_at;
}

export function moveSaid(card: InboxCardWire, moved: InboxCardWire): string {
  if (moved.column === 'dropped') return `Cancelled “${card.title}”. It is kept under Cancelled.`;
  if (card.column === 'dropped') return `Restored “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
  return `Moved “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
}

export function cardOwnerName(card: InboxCardWire): string {
  return card.agent?.kind === 'agent' ? inboxAgentName(card.agent) : 'You';
}

export function cardYou(card: InboxCardWire): string | null {
  return isInboxCardPersonColumn(card.column) && card.you ? card.you : null;
}

export function youThread(card: Pick<InboxCardWire, 'threads' | 'sent'>, rowOf: (threadId: string) => { last_at?: string } | null): string | null {
  const sent = card.sent?.thread_id;
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

export function youLinkLabel(you: string): string {
  return `You: ${you}, open the thread`;
}

export function waitingLinkLabel(subject: string | null): string {
  return `Waiting on you: ${subject ?? 'a question'}, open the thread`;
}

export function sentTo(card: InboxCardWire): string | null {
  return isInboxCardSentWaiting(card) && card.sent ? inboxAgentName(card.sent.to) : null;
}

export function cardFoot(card: InboxCardWire): { primary: 'send' | 'start' | 'ship' | 'restore' | null; drop: boolean } {
  if (card.column === 'dropped') return { primary: 'restore', drop: false };
  const waiting = card.column === 'backlog' || card.column === 'todo';
  if (waiting && card.agent === null && card.sent === null) return { primary: 'send', drop: true };
  if (waiting && card.agent !== null && !isInboxCardSentWaiting(card)) return { primary: 'start', drop: true };
  return { primary: card.column === 'done' ? null : 'ship', drop: true };
}

export function columnChoices(card: InboxCardWire): { column: InboxCardColumn; label: string; current: boolean }[] {
  const columns: InboxCardColumn[] = [...INBOX_CARD_LIVE_COLUMNS, 'done'];
  return columns.map((column) => ({ column, label: INBOX_CARD_COLUMN_LABELS[column], current: card.column === column }));
}

export function cardMessageBody(title: string, notes: string | null, cardId: string | null): string {
  const text = notes?.trim() ? notes.trim() : title;
  const which = cardId ? `, card ${cardId}` : "";
  return `${text}\n\n(This is “${title}” on my Board${which}. It is yours now: move it there as the work goes.)`;
}

export function messageKey(key: string, session: string, body: string): string {
  let hash = 5381;
  for (let i = 0; i < body.length; i += 1) hash = ((hash << 5) + hash + body.charCodeAt(i)) >>> 0;
  return `${key}:${session}:${hash.toString(36)}`;
}

export function askWhereBody(card: Pick<InboxCardWire, 'id' | 'title'>): string {
  return `Where is “${card.title}”? (Board card ${card.id}) Move the card, or say where it stands with the card action.`;
}

export function startBody(card: Pick<InboxCardWire, 'id' | 'title' | 'notes'>): string {
  const notes = card.notes?.trim() ? `\n\n${card.notes.trim()}` : '';
  return `Please start on “${card.title}” (Board card ${card.id}).${notes}\n\nMove the card as the work goes.`;
}

function prRefOfUrl(url: string): string {
  const gh = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (gh) return `${gh[1]}/${gh[2]}#${gh[3]}`;
  const gl = /\/-\/merge_requests\/(\d+)/.exec(url);
  if (gl) return `!${gl[1]}`;
  const bb = /\/pull-requests\/(\d+)/.exec(url);
  return bb ? `#${bb[1]}` : url;
}

export function shortRef(ref: string): string {
  const match = /([#!]\d+)$/.exec(ref);
  return match ? match[1]! : ref;
}

function authorName(by: InboxAuthor): string {
  return by.kind === 'person' ? 'you' : inboxAgentName(by);
}

export function historyWords(
  entry: InboxCardHistoryEntry,
  initiativeNameOf: (id: string) => string | null = () => null,
): { before: string; bold: string | null; after: string; quote: string | null } {
  const by = authorName(entry.by);
  switch (entry.kind) {
    case 'initiative':
      return entry.initiative
        ? { before: 'Initiative: ', bold: initiativeNameOf(entry.initiative) ?? 'a deleted initiative', after: ` by ${by}`, quote: null }
        : { before: `Initiative cleared by ${by}`, bold: null, after: '', quote: null };
    case 'created':
      return { before: `Created by ${by}`, bold: null, after: '', quote: null };
    case 'sent':
      return { before: 'Sent to ', bold: inboxAgentName(entry.to), after: entry.existing_thread ? ' in the card\u2019s thread' : ' in a new thread', quote: null };
    case 'moved':
      return { before: 'Moved to ', bold: INBOX_CARD_COLUMN_LABELS[entry.column], after: ` by ${by}`, quote: entry.you ? `You: “${entry.you}”` : null };
    case 'restored':
      return { before: 'Restored to ', bold: INBOX_CARD_COLUMN_LABELS[entry.column], after: ` by ${by}`, quote: null };
    case 'dropped':
      return { before: `Cancelled by ${by}`, bold: null, after: '', quote: entry.reason ? `“${entry.reason}”` : null };
    case 'auto_shipped':
      return { before: 'Done automatically: ', bold: entry.prs.map((url) => shortRef(prRefOfUrl(url))).join(', '), after: entry.prs.length === 1 ? ' merged' : ' all merged', quote: null };
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

export function agentState(session: string | null, live: readonly { session: string; busy: boolean | null }[] | null): 'working' | 'idle' | 'ended' | null {
  if (!session || live === null) return null;
  const found = live.find((s) => s.session === session);
  return found ? (found.busy ? 'working' : 'idle') : 'ended';
}

export function cardLabel(card: InboxCardWire, unread: boolean, now: number = Date.now(), project: string | null = null): string {
  const parts = [card.title];
  if (project) parts.push(project);
  const line = cardLine(card);
  if (line) parts.push(line.you ? `You: ${line.text}` : line.text);
  parts.push(INBOX_CARD_COLUMN_LABELS[card.column]);
  const age = cardAge(card.heard_at, now).long;
  if (age) parts.push(`last heard ${age}`);
  if (unread) parts.push(`new from ${cardOwnerName(card)}`);
  return parts.join('. ');
}
