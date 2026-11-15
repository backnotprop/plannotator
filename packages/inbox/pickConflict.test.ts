import { expect, test } from 'bun:test';
import { InboxApiError } from './api';
import { onPickConflict, PICK_CONFLICT_RETRIES, PICK_CONFLICT_RULE } from './pickConflict';

const conflict = (revision: number) => new InboxApiError(409, 'question_revision_conflict', `Question q-1 changed since you read it (revision ${revision}).`, null, null, null, revision);

test('the rule built is the one the owner was shown: the later click wins', () => {
  // Pinned on purpose: flipping it is the owner's decision (pickConflict.ts), not a refactor's.
  expect(PICK_CONFLICT_RULE).toBe('later-click-wins');
});

test('later click wins: the refused answer goes again at the revision the Inbox holds, then gives way rather than loop', () => {
  expect(onPickConflict(conflict(4), 0, 'later-click-wins')).toEqual({ action: 'retry', revision: 4 });
  expect(onPickConflict(conflict(5), PICK_CONFLICT_RETRIES - 1, 'later-click-wins')).toEqual({ action: 'retry', revision: 5 });
  // Still changing under every retry: the Inbox's answer is drawn, never the refusal.
  expect(onPickConflict(conflict(6), PICK_CONFLICT_RETRIES, 'later-click-wins')).toEqual({ action: 'adopt' });
});

test('first save wins (the flip): the refused window draws the Inbox answer', () => {
  expect(onPickConflict(conflict(4), 0, 'first-save-wins')).toEqual({ action: 'adopt' });
});

test('any other refusal, or a conflict from an Inbox that names no revision, fails as before', () => {
  expect(onPickConflict(new InboxApiError(500, 'error', 'The disk is full.'), 0)).toBeNull();
  expect(onPickConflict(new InboxApiError(409, 'question_already_sent', 'Already sent.'), 0)).toBeNull();
  expect(onPickConflict(new InboxApiError(409, 'question_revision_conflict', 'Changed.'), 0)).toBeNull();
  expect(onPickConflict(new Error('offline'), 0)).toBeNull();
});
