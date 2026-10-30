/**
 * Threads pinned to the sidebar (approval "inbox-pinned-threads",
 * .product/approved/inbox-pinned-threads/, variant Count): what a pinned row
 * shows, its name, the order a move makes, and the Unpin toast. Pure.
 *
 * A pin is window furniture: it changes nothing about the thread (its
 * section, routing, questions, delivery, counts or notifications), and agents
 * never see it. No limit on pins; an archived thread stays pinned.
 */

import { INBOX_SECTIONS, inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { waitCount } from './format';
import { threadChipName } from './threadChip';

/** What a pinned row's state signal is (Count): a pill, a count, a dot, or nothing. */
export type PinnedStateKind = 'stop' | 'hold' | 'wait' | 'new' | 'sent' | 'quiet' | 'archived';

export interface PinnedState {
  kind: PinnedStateKind;
  /** The state in words, for the row's accessible name. */
  words: string;
  /** Holds N (hold) or the open questions (wait). */
  n: number;
  /** Nothing waits on the person: the row steps back, like a quiet project. */
  calm: boolean;
}

export function pinnedState(row: InboxListRow): PinnedState {
  if (inboxRowArchived(row)) return { kind: 'archived', words: 'Archived', n: 0, calm: true };
  switch (row.section) {
    case 'stopped':
      return { kind: 'stop', words: 'Stopped', n: 0, calm: false };
    case 'holding': {
      const n = row.questions.holds_up.length;
      return { kind: 'hold', words: `Holds up ${n}`, n, calm: false };
    }
    case 'waiting': {
      // The list row's own words for its count ("1 question, 1 action item"), so the two never disagree.
      const n = row.questions.open;
      return { kind: 'wait', words: waitCount(n, row.questions.actions ?? 0), n, calm: false };
    }
    case 'new':
      // Agent news the person has not looked at gets the dot; a row in New only for their own draft does not.
      return row.unseen > 0 ? { kind: 'new', words: 'New', n: 0, calm: false } : { kind: 'quiet', words: 'Draft', n: 0, calm: true };
    case 'sent':
      return { kind: 'sent', words: 'Sent', n: 0, calm: true };
    default:
      return { kind: 'quiet', words: (row.read_at ?? null) !== null ? 'Read' : 'Quiet', n: 0, calm: true };
  }
}

/**
 * What a pinned row calls its thread: the thread's name when it has one (by the
 * list's own rule, `threadChipName`: not when the subject already starts with
 * it), else the subject.
 */
export function pinnedLabel(row: InboxListRow): string {
  const subject = row.subject ?? '(no subject)';
  return (row.thread_name?.trim() ? threadChipName(row.thread_name, subject) : null) ?? subject;
}

/**
 * A pinned row's name: "label, project, state" ("Board names, plannotator, 3 questions"),
 * or "label, subject, project, state" when the label is the thread's name and
 * the subject says something else. `project`: the sidebar's name for it
 * (shortProjectNames); absent, the server's.
 */
export function pinnedRowName(row: InboxListRow, project: string = row.project.name): string {
  const label = pinnedLabel(row);
  const subject = row.subject ?? '(no subject)';
  return `${label}, ${label === subject ? '' : `${subject}, `}${project}, ${pinnedState(row).words}`;
}

/** The pins' order after moving one up (-1) or down (+1); unchanged at an end or for a thread not pinned. */
export function movePin(order: readonly string[], threadId: string, by: -1 | 1): string[] {
  const next = [...order];
  const at = next.indexOf(threadId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= next.length) return next;
  next[at] = next[to]!;
  next[to] = threadId;
  return next;
}

/** Where an unpinned thread still is, for the toast: "Still in Waiting on you", "Still in Archived". */
export function unpinnedWhere(row: InboxListRow | null | undefined): string {
  if (!row) return 'Still in the Inbox';
  if (inboxRowArchived(row)) return 'Still in Archived';
  const label = INBOX_SECTIONS.find((section) => section.id === row.section)?.label;
  return label ? `Still in ${label}` : 'Still in the Inbox';
}
