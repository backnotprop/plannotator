import { describe, expect, test } from 'bun:test';
import {
  applyReplyDraftFileOps,
  composeReplyDraftFileOps,
  diffReplyDraftFiles,
  replyDraftFilesAfterSave,
  settleReplyDraftAfterSend,
} from './inbox-reply-draft';

const f = (id: string, at?: number) => (at === undefined ? { upload_id: id } : { upload_id: id, pasted: { at, preview: id } });
const ids = (list: readonly { upload_id: string }[]) => list.map((file) => file.upload_id);
const ops = (add: ReturnType<typeof f>[], remove: string[] = [], place: { upload_id: string; pasted: { at: number; preview: string } }[] = []) => ({ add, remove, place });

describe("applyReplyDraftFileOps: a save's file changes on the draft's files as they are", () => {
  test("a file the save does not name stays (another window's); one it adds joins after them; one it removes goes", () => {
    expect(ids(applyReplyDraftFileOps([f('theirs'), f('old')], ops([f('mine')], ['old'])))).toEqual(['theirs', 'mine']);
  });
  test('removing a file another window already removed, or adding one already there, changes nothing more (twice is once)', () => {
    const once = applyReplyDraftFileOps([f('a')], ops([f('a'), f('b')], ['gone']));
    expect(ids(once)).toEqual(['a', 'b']);
    expect(applyReplyDraftFileOps(once, ops([f('a'), f('b')], ['gone']))).toEqual(once);
  });
  test("a long paste still there takes its new place; a place for a file not there does nothing", () => {
    expect(applyReplyDraftFileOps([f('p', 3), f('x')], ops([], [], [{ upload_id: 'p', pasted: { at: 9, preview: 'p' } }, { upload_id: 'q', pasted: { at: 1, preview: 'q' } }]))).toEqual([
      f('p', 9),
      f('x'),
    ]);
  });
});

describe('diffReplyDraftFiles and composeReplyDraftFileOps: what a box changed, kept until it lands', () => {
  test('the box against what it last held: added files and removed ids', () => {
    expect(diffReplyDraftFiles(['a', 'b'], [f('b'), f('c')])).toEqual(ops([f('c')], ['a']));
  });
  test('two changes in a row are one: the later says last for an id (added then removed is removed)', () => {
    const first = ops([f('c')], ['a']);
    const then = ops([f('a')], ['c']);
    expect(composeReplyDraftFileOps(first, then)).toEqual(ops([f('a')], ['c']));
    // The same files either way (their order is not part of the draft's meaning).
    const together = ids(applyReplyDraftFileOps([f('a'), f('b')], composeReplyDraftFileOps(first, then))).sort();
    expect(together).toEqual(ids(applyReplyDraftFileOps(applyReplyDraftFileOps([f('a'), f('b')], first), then)).sort());
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
