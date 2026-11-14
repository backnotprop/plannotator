/**
 * Which reply drafts float in the corner (approval "inbox-reply-floaters"). Failures to catch: a draft floating
 * though the person only read the thread (nothing typed on this visit), or with a stray half word; a draft that
 * stays in the corner after it was sent or discarded elsewhere, or for days; the open thread's own draft drawn in
 * the corner too (two boxes for one draft); a draft dropped before the drafts list caught up with its save.
 */
import { expect, test } from 'bun:test';
import type { InboxReplyDraftRow } from '@plannotator/core/inbox-types';
import { FLOAT_MAX_AGE_MS, FLOAT_SETTLE_MS, floatingDrafts, floatsAfterVisit, staleFloats } from './model';

const AT = '2026-11-07T10:00:00.000Z';
const LATER = '2026-11-07T10:05:00.000Z';

function row(id: string, words = true, picks = 0, editedAt = AT): InboxReplyDraftRow {
  return { thread_id: id, subject: `Thread ${id}`, thread_name: null, unsent: { reply_at: words ? editedAt : null, picks, comments: 0 } } as unknown as InboxReplyDraftRow;
}

test('a draft floats only when the person typed on this visit and it holds 8 characters or a file', () => {
  const typed = { body: 'Key on invoice_id alone', updated_at: LATER, files: [] };
  // Typed: the draft moved since the thread opened (or there was none).
  expect(floatsAfterVisit(AT, typed)).toBe(true);
  expect(floatsAfterVisit(null, typed)).toBe(true);
  // Read only: the draft is as it was when the thread opened.
  expect(floatsAfterVisit(LATER, typed)).toBe(false);
  // Discarded or sent on this visit: nothing floats.
  expect(floatsAfterVisit(AT, null)).toBe(false);
  // A stray half word stays a draft, but floats nowhere; a file alone floats.
  expect(floatsAfterVisit(AT, { body: 'ok  ', updated_at: LATER, files: [] })).toBe(false);
  expect(floatsAfterVisit(AT, { body: '', updated_at: LATER, files: [{ upload_id: 'up_1' } as never] })).toBe(true);
  // The entry read had not come back: the person could not have seen it, so a change counts as typed.
  expect(floatsAfterVisit(undefined, typed)).toBe(true);
});

test('the corner shows floating drafts with words, newest first, never the open thread’s own', () => {
  const entries = [
    { id: 'thr_c', at: 3 },
    { id: 'thr_a', at: 2 },
    { id: 'thr_b', at: 1 },
    { id: 'thr_gone', at: 0 },
  ];
  const rows = [row('thr_a'), row('thr_b'), row('thr_c'), row('thr_picks', false, 2)];
  expect(floatingDrafts(entries, rows, null).map((r) => r.thread_id)).toEqual(['thr_c', 'thr_a', 'thr_b']);
  // In its own thread the thread's box has it.
  expect(floatingDrafts(entries, rows, 'thr_a').map((r) => r.thread_id)).toEqual(['thr_c', 'thr_b']);
  // Picks alone never float: only the thread's Send carries them.
  expect(floatingDrafts([{ id: 'thr_picks', at: 1 }], rows, null)).toEqual([]);
});

test('a draft stops floating once sent or discarded anywhere, or a day untouched; one just set aside waits for the list', () => {
  const now = Date.parse(AT) + 10 * FLOAT_MAX_AGE_MS;
  // Floated more than a day ago, but edited in its window a minute ago: it is not untouched, so it keeps floating.
  const rows = [row('thr_kept'), row('thr_old'), row('thr_words_gone', false, 1), row('thr_edited', true, 0, new Date(now - 60_000).toISOString())];
  const entries = [
    { id: 'thr_kept', at: now - 60_000 },
    { id: 'thr_old', at: now - FLOAT_MAX_AGE_MS - 1 },
    { id: 'thr_sent', at: now - 60_000 },
    { id: 'thr_words_gone', at: now - 60_000 },
    { id: 'thr_new', at: now - FLOAT_SETTLE_MS + 500 },
    { id: 'thr_open', at: now - 60_000 },
    { id: 'thr_edited', at: now - FLOAT_MAX_AGE_MS - 1 },
  ];
  expect(staleFloats(entries, rows, ['thr_open'], now).sort()).toEqual(['thr_old', 'thr_sent', 'thr_words_gone']);
});
