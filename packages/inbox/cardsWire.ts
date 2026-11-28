import type { InboxCardWire, InboxInitiative, InboxListRow, InboxStepsWire } from '@plannotator/core/inbox-types';
import { inboxUrl, machineOf, rememberLocal, rememberMachine, setSelfMachine } from './inboxUrl';

/** `GET /api/inbox/cards`: the Board. `seen_seq` (the person's last look, a store seq) is absent from an Inbox before step 2. */
export interface CardsModel {
  serverSession: string;
  cursor: number;
  cards: InboxCardWire[];
  dropped_unseen: number;
  seen_seq?: number | null;
  /** Each linked thread's list row (archived ones too), for the opened card. Absent from an older Inbox. */
  threads?: Record<string, InboxListRow | null>;
  /** While the person's checklist switch is on: each linked thread's lists with steps (approval "inbox-thread-steps"). Absent: off, or an older Inbox. */
  steps?: Record<string, InboxStepsWire[]>;
  /** The Board's initiatives, deleted ones too (approval "board-initiatives"). Absent from an older Inbox: none. */
  initiatives?: InboxInitiative[];
  /**
   * Approval "board-hashtags": per live initiative that a message tags, the latest-tagged threads no card of it
   * links (at most 4, newest first; their rows are in `threads`) and `total`, how many such threads in all.
   * Absent from an older Inbox: the preview lists no threads.
   */
  initiative_threads?: Record<string, { threads: string[]; total: number }>;
  /**
   * The merged Board (linked machines, mark `cards`): each linked machine's look and the cursor of its cards as read,
   * by its `ibx_` id. Its cards carry `machine`. Absent from an Inbox before it.
   */
  machines?: Record<string, { cursor: number; seen_seq: number | null }>;
  /** The merged Board: this Inbox's own `ibx_` id. */
  self?: string;
}

/** `/cards/<id><rest>` on the machine whose Board holds the card. */
export function cardUrl(cardId: string, rest = ''): string {
  return inboxUrl(`/cards/${encodeURIComponent(cardId)}${rest}`, undefined, machineOf(cardId));
}

/**
 * The merged Board names each card's machine: a linked machine's card, its project and its threads' rows route there
 * (inboxUrl.ts); this Inbox's own (`local`, the read's ids) are local for good.
 */
export function learnCards(model: CardsModel, local: Set<string>): CardsModel {
  setSelfMachine(model.self);
  rememberLocal(local);
  for (const card of model.cards) rememberMachine([card.id, card.project_id, ...card.threads], card.machine);
  for (const row of Object.values(model.threads ?? {})) if (row) rememberMachine([row.thread_id], row.machine);
  return model;
}
