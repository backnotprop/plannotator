import { describe, expect, test } from 'bun:test';
import { mergeReplyDraftFiles, replyDraftFilesAfterSave, settleReplyDraftAfterSend } from './inbox-reply-draft';

const f = (id: string, at?: number) => (at === undefined ? { upload_id: id } : { upload_id: id, pasted: { at, preview: id } });
const ids = (list: readonly { upload_id: string }[]) => list.map((file) => file.upload_id);

describe('mergeReplyDraftFiles: two windows change one draft\'s files', () => {
  test('both add: both stay, theirs first', () => {
    expect(ids(mergeReplyDraftFiles(['a'], [f('a'), f('mine')], [f('a'), f('theirs')]))).toEqual(['a', 'theirs', 'mine']);
  });
  test('this window removed one the other kept: it goes; one the other removed stays gone', () => {
    expect(ids(mergeReplyDraftFiles(['a', 'b'], [f('b')], [f('a'), f('b'), f('c')]))).toEqual(['b', 'c']);
    expect(ids(mergeReplyDraftFiles(['a', 'b'], [f('a'), f('b')], [f('b')]))).toEqual(['b']);
  });
  test("a file both hold takes this window's entry (its paste's place)", () => {
    expect(mergeReplyDraftFiles(['p'], [f('p', 9)], [f('p', 3)])).toEqual([f('p', 9)]);
  });
});

describe('replyDraftFilesAfterSave: an older page never drops a file it does not know', () => {
  test('all_files sets the list', () => {
    expect(ids(replyDraftFilesAfterSave([f('img'), f('p', 0)], [f('p', 0)], true))).toEqual(['p']);
  });
  test('without it, the list replaces long pastes only', () => {
    expect(ids(replyDraftFilesAfterSave([f('img'), f('p', 0)], [], false))).toEqual(['img']);
    expect(ids(replyDraftFilesAfterSave([f('img'), f('p', 0)], [f('q', 0)], false))).toEqual(['img', 'q']);
  });
});

describe('settleReplyDraftAfterSend', () => {
  const draft = { body: 'Ship it', updated_at: 't2', files: [f('img'), f('p', 7)] };
  test('its own version: words and carried files go; a file not carried stays, a paste at the start', () => {
    expect(settleReplyDraftAfterSend(draft, { clearDraft: 't2', words: 'Ship it', uploads: ['img', 'p'] })).toEqual({ kind: 'delete' });
    expect(settleReplyDraftAfterSend(draft, { clearDraft: 't2', words: 'Ship it', uploads: [] })).toEqual({ kind: 'files', files: [f('img'), f('p', 0)] });
  });
  test('an older version: gone only while it holds exactly the sent words and only carried files', () => {
    expect(settleReplyDraftAfterSend(draft, { clearDraft: 't1', words: ' Ship it ', uploads: ['img', 'p'] })).toEqual({ kind: 'delete' });
    expect(settleReplyDraftAfterSend(draft, { clearDraft: 't1', words: 'Ship it', uploads: ['img'] })).toEqual({ kind: 'unchanged' });
    expect(settleReplyDraftAfterSend(draft, { clearDraft: 't1', words: 'Other', uploads: ['img', 'p'] })).toEqual({ kind: 'unchanged' });
  });
});
