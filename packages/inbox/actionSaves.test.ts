/**
 * The window's action item saves (approval "inbox-action-items-in-reply").
 * Failures to catch: an error toast the person cannot act on when a note
 * saved in its typing pause finds the item already sent or replaced; a
 * refused Done or Can't do it (pressed by the person) going unreported; a
 * Send not saving a note still in its pause.
 */
import { expect, test } from 'bun:test';
import { InboxApiError } from './api';
import { actionSavesSettled, isMootNoteRefusal, registerActionFlush, trackActionSave } from './actionSaves';

test('a quiet note save refused because the item was sent or closed meanwhile is moot; anything else is shown', () => {
  const sent = new InboxApiError(409, 'action_already_sent', 'Action item a-1 was already sent to the agent.');
  const closed = new InboxApiError(409, 'action_closed', 'Action item a-1 is superseded: it can no longer be marked.');
  expect(isMootNoteRefusal({ quiet: true }, sent)).toBe(true);
  expect(isMootNoteRefusal({ quiet: true }, closed)).toBe(true);
  // The person's own Done, Can't do it or take-back: its refusal is theirs to see.
  expect(isMootNoteRefusal({}, sent)).toBe(false);
  expect(isMootNoteRefusal(null, closed)).toBe(false);
  // Another failure of a note save (a bad note, the Inbox gone) is shown too.
  expect(isMootNoteRefusal({ quiet: true }, new InboxApiError(422, 'validation_error', 'note: at most 2,000 characters.'))).toBe(false);
  expect(isMootNoteRefusal({ quiet: true }, new TypeError('Failed to fetch'))).toBe(false);
});

test('settling first saves every note still in its pause, then waits for every save on its way', async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const unregister = registerActionFlush(() => {
    order.push('flushed');
    void trackActionSave(
      new Promise<void>((resolve) => {
        release = () => {
          order.push('saved');
          resolve();
        };
      }),
    );
  });
  const settled = actionSavesSettled().then(() => order.push('settled'));
  await Promise.resolve();
  expect(order).toEqual(['flushed']);
  release();
  await settled;
  expect(order).toEqual(['flushed', 'saved', 'settled']);
  unregister();
});
