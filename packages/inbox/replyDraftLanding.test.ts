import { beforeEach, expect, test } from 'bun:test';
import type { ReplyDraftStore, ReplyDraftSaveInput } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import { clearLateVoiceMiss, lateVoiceMissOf } from './lateVoice';
import { landWordsInReplyDraft, replyDraftDiscarded, replySendStarts } from './replyDraft';

beforeEach(() => clearLateVoiceMiss('thr_a'));

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

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

test('a Send on its way: nothing is read until it ends, so the words never join what it carries', async () => {
  let reads = 0;
  const { store, saves } = storeOver([null]);
  const counted: ReplyDraftStore = {
    ...store,
    read: (thread) => {
      reads += 1;
      return store.read(thread);
    },
  };
  const firstEnds = replySendStarts('thr_a');
  const secondEnds = replySendStarts('thr_a');
  const landed = landWordsInReplyDraft('thr_a', 'Landed.', counted);
  await settle();
  firstEnds();
  await settle();
  expect(reads).toBe(0);
  secondEnds();
  await landed;
  expect(saves[0]!.input).toMatchObject({ body: 'Landed.' });
});

test('a discard once they have started stops them, and one before does not', async () => {
  const before = storeOver([draft('Before.', 't1')]);
  replyDraftDiscarded('thr_a');
  await landWordsInReplyDraft('thr_a', 'Landed.', before.store);
  expect(before.saves).toHaveLength(1);

  const after = storeOver([draft('Before.', 't1')]);
  let answer: (value: InboxReplyDraft | null) => void = () => {};
  const held: ReplyDraftStore = { ...after.store, read: () => new Promise((done) => (answer = done)) };
  const landed = landWordsInReplyDraft('thr_a', 'Landed.', held);
  await settle();
  replyDraftDiscarded('thr_a');
  answer(draft('Before.', 't1'));
  await landed;
  expect(after.saves).toHaveLength(0);
  expect(lateVoiceMissOf('thr_a')).toBeNull();
});

test('a read or a save that fails stays on offer, and Retry lands the same words', async () => {
  for (const broken of ['read', 'save'] as const) {
    clearLateVoiceMiss('thr_a');
    const { store, saves } = storeOver([draft('Before.', 't1')]);
    const failing: ReplyDraftStore = {
      ...store,
      [broken]: () => Promise.reject(Object.assign(new Error('down'), { code: 'internal' })),
    };
    await landWordsInReplyDraft('thr_a', 'Landed.', failing);
    expect(saves).toHaveLength(0);
    const miss = lateVoiceMissOf('thr_a');
    expect(miss?.retry).toBeFunction();
    if (broken === 'read') failing.read = store.read;
    else failing.save = store.save;
    miss!.retry!();
    await settle();
    await settle();
    expect(lateVoiceMissOf('thr_a')).toBeNull();
    expect(saves[0]!.input).toMatchObject({ body: 'Before. Landed.' });
  }
});

test('refused every time: it stays on offer rather than going quiet', async () => {
  const { store, saves } = storeOver([draft('Before.', 't1')], 99);
  await landWordsInReplyDraft('thr_a', 'Landed.', store);
  expect(saves).toHaveLength(0);
  expect(lateVoiceMissOf('thr_a')?.retry).toBeFunction();
});
