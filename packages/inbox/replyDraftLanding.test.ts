/**
 * Dictated words whose thread is no longer open join that thread's draft (`landWordsInReplyDraft`): after what the
 * draft holds then, read again if another save got there first, and not at all once this window discarded it.
 */
import { expect, test } from 'bun:test';
import type { ReplyDraftStore, ReplyDraftSaveInput } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import { landWordsInReplyDraft } from './replyDraft';

const draft = (body: string, updated_at: string) => ({ body, updated_at }) as InboxReplyDraft;

function storeOver(reads: (InboxReplyDraft | null)[], refusals = 0) {
  const saves: { thread: string; input: ReplyDraftSaveInput }[] = [];
  let refuse = refusals;
  const store: ReplyDraftStore = {
    read: async () => (reads.length > 1 ? reads.shift()! : reads[0]!),
    save: async (thread, input) => {
      if (refuse-- > 0) throw Object.assign(new Error('changed'), { code: 'draft_conflict' });
      saves.push({ thread, input });
      return { draft: null };
    },
    discard: async () => {},
  };
  return { store, saves };
}

test('the words go after the draft’s, spaced, named against the draft they were added to', async () => {
  const { store, saves } = storeOver([draft('Before.', 't1')]);
  await landWordsInReplyDraft('thr_a', 'Landed.', store);
  expect(saves).toHaveLength(1);
  expect(saves[0]!.thread).toBe('thr_a');
  expect(saves[0]!.input).toMatchObject({ body: 'Before. Landed.', base: 't1', baseBody: 'Before.' });
});

test('no draft yet: the words are the draft', async () => {
  const { store, saves } = storeOver([null]);
  await landWordsInReplyDraft('thr_a', 'Landed.', store);
  expect(saves[0]!.input).toMatchObject({ body: 'Landed.', base: null, baseBody: null });
});

test('another save got there first: read again, and the words join that one', async () => {
  const { store, saves } = storeOver([draft('Before.', 't1'), draft('Before. Typed.', 't2')], 1);
  await landWordsInReplyDraft('thr_a', 'Landed.', store);
  expect(saves[0]!.input).toMatchObject({ body: 'Before. Typed. Landed.', base: 't2' });
});
