/**
 * The shortcut map's layout (components/ShortcutMap.tsx): which registry
 * actions share a row, in what order, in which group and column. The keys and
 * words come from the registry; this says only where they go.
 */
import type { ShortcutScopeDefinition } from '@plannotator/ui/shortcuts';
import { inboxAppShortcuts, inboxArtifactsShortcuts, inboxBoardShortcuts, inboxFileViewerShortcuts, inboxListShortcuts, inboxSearchShortcuts, inboxThreadShortcuts } from './index';

export type Ref = { scope: ShortcutScopeDefinition<any>; action: string; only?: number };

export interface MapRow {
  /** The row's words; absent: the first action's description. */
  label?: string;
  /** The actions whose keys the row shows, in order (J K: next, then previous). */
  keys: Ref[];
  /** Actions the row stands for without showing their keys again (Escape in every scope). */
  also?: Ref[];
}

export interface MapGroup {
  title: string;
  rows: MapRow[];
}

const app = (action: string): Ref => ({ scope: inboxAppShortcuts, action });
const list = (action: string): Ref => ({ scope: inboxListShortcuts, action });
const thread = (action: string): Ref => ({ scope: inboxThreadShortcuts, action });
const file = (action: string, only?: number): Ref => ({ scope: inboxFileViewerShortcuts, action, only });
const grid = (action: string, only?: number): Ref => ({ scope: inboxArtifactsShortcuts, action, only });
const board = (action: string, only?: number): Ref => ({ scope: inboxBoardShortcuts, action, only });
/** The four arrows of a move, each its own keycap with no "or" between them. */
const arrows = (ref: (action: string, only?: number) => Ref, action: string): Ref[] => [0, 1, 2, 3].map((i) => ref(action, i));

/**
 * Two columns: Everywhere and List on the left, Thread and Files on the right. Every key of an open file or of the
 * Artifacts grid is in Files (approval "inbox-keyboard-keys-2026-11-07", item 6), so Thread keeps movement and verbs.
 */
export const MAP_COLUMNS: MapGroup[][] = [
  [
    {
      title: 'Everywhere',
      rows: [
        { keys: [{ scope: inboxSearchShortcuts, action: 'openSearch' }] },
        { keys: [app('openMap')] },
        { keys: [app('compose')] },
        { keys: [app('refresh')] },
        { keys: [app('goInbox')] },
        { keys: [app('goBoard')] },
        { keys: [app('goPulls')] },
        { keys: [app('goDrafts')] },
        { keys: [app('goSettings')] },
        { keys: [app('toggleSidebar')] },
      ],
    },
    {
      title: 'List',
      rows: [
        { label: 'Move between threads', keys: [list('previous'), list('next')] },
        { label: 'First or last thread', keys: [list('first'), list('last')] },
        { keys: [list('open')] },
        { keys: [thread('markRead')] },
        { keys: [thread('archive')] },
        { keys: [thread('snooze')] },
        { keys: [thread('undo')] },
        { label: 'Row, card or message menu', keys: [list('rowMenu')], also: [thread('messageMenu')] },
        { keys: arrows(board, 'move') },
        { keys: [board('ends')] },
      ],
    },
  ],
  [
    {
      title: 'Thread',
      rows: [
        { keys: [thread('reply')] },
        { label: 'Send the reply', keys: [thread('send')] },
        { label: 'Next or previous thread', keys: [thread('nextThread'), thread('previousThread')] },
        { label: 'Next or previous message', keys: [thread('nextMessage'), thread('previousMessage')] },
        { keys: [thread('firstNew')] },
        { keys: [thread('openItems')] },
        { keys: [thread('close')], also: [app('leavePage'), file('escape')] },
      ],
    },
    {
      title: 'Files',
      rows: [
        { keys: [thread('openNewest')] },
        { keys: [thread('artifacts')] },
        { keys: arrows(grid, 'move') },
        { keys: [grid('ends')] },
        { keys: [thread('fullScreen')] },
        { label: 'Next or previous file', keys: [file('next', 0), file('previous', 0)], also: [file('next'), file('previous')] },
        { keys: [file('toggleTools')] },
        { keys: [file('toggleAnnotate')] },
      ],
    },
  ],
];

export const present = (ref: Ref) => ref.scope.shortcuts[ref.action] !== undefined;

/** The map's rows as they are drawn now: a row whose actions are all absent (an extra that is off) is left out. */
export function mapColumns(columns: MapGroup[][] = MAP_COLUMNS): MapGroup[][] {
  return columns.map((groups) => groups.map((group) => ({ ...group, rows: group.rows.filter((row) => row.keys.some(present)) })).filter((group) => group.rows.length > 0));
}

