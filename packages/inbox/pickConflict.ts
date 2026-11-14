/**
 * Two windows (two tabs, a laptop and a phone's browser) answer the same question at nearly the same moment. The
 * Inbox keeps whichever save reaches it first and refuses the other one (`question_revision_conflict`: the second
 * save named the revision it had read, and the first save raised it). The refused window used to keep drawing its
 * own answer with the raw refusal ("Question q-… changed since you read it (revision N)"), and the two windows
 * disagreed until a reload (data-layer brief, 2026-11-10).
 *
 * Now both windows end on one answer, quietly, with no new words on screen. Which one is the rule below.
 */
import { InboxApiError } from './api';

/**
 * ┌─ OWNER DECISION POINT ─────────────────────────────────────────────────────────────────────────────────────┐
 * │ 'later-click-wins' (built, the recommendation the owner was shown): the refused window saves its answer   │
 * │   again on top of the one that got there first, so the answer clicked last stands, and the first window   │
 * │   switches to it when its record arrives. "Last" is the order the saves reach the Inbox, which for two    │
 * │   windows on one link is the order of the clicks.                                                         │
 * │ 'first-save-wins': the refused window drops its own answer and draws the one the Inbox kept.              │
 * │ Flip this one constant; nothing else changes (pickConflict.test.ts proves both).                          │
 * └────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 */
export type PickConflictRule = 'later-click-wins' | 'first-save-wins';
export const PICK_CONFLICT_RULE: PickConflictRule = 'later-click-wins';

/** How many times one answer is saved again over another window's: a question two windows keep changing never loops. */
export const PICK_CONFLICT_RETRIES = 2;

/** The revision the Inbox holds now, when `cause` is another window's answer landing first; null for anything else. */
export function conflictRevision(cause: unknown): number | null {
  if (!(cause instanceof InboxApiError) || cause.code !== 'question_revision_conflict') return null;
  return typeof cause.currentRevision === 'number' ? cause.currentRevision : null;
}

/**
 * What a window does with a save refused because another window's answer landed first: `retry` saves its own answer
 * again at the revision the Inbox holds now; `adopt` drops it and draws the Inbox's (also once retried enough). Null:
 * not that refusal, or its revision unknown (an older Inbox): the save fails as before.
 */
export function onPickConflict(cause: unknown, tries: number, rule: PickConflictRule = PICK_CONFLICT_RULE): { action: 'retry'; revision: number } | { action: 'adopt' } | null {
  const revision = conflictRevision(cause);
  if (revision === null) return null;
  if (rule === 'first-save-wins') return { action: 'adopt' };
  // Changed again under every retry (both windows still answering): the Inbox's answer is drawn, never the raw refusal.
  return tries < PICK_CONFLICT_RETRIES ? { action: 'retry', revision } : { action: 'adopt' };
}
