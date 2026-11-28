/**
 * Where a thread's reply draft is kept (machineDrafts.ts): this Inbox's thread always; a linked machine's thread once
 * that machine's list says it keeps reply drafts (mark `reply-drafts`), and then dictated words for its closed box land
 * in its draft as on this Inbox's own thread. An older Plannotator there (its list read, no mark) or a machine whose list
 * is not read yet keeps none: the words wait in this page for the box, as before, and nothing is written anywhere.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import { hasMachineMark, rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import { keepsReplyDraft, replyDraftHost } from './machineDrafts';
import { landWordsInReplyDraft, takeHeldVoiceWords } from './replyDraft';

const SELF = 'ibx_01HAAAAAAAAAAAAAAAAAAAAAAA';
const NEWER = 'ibx_01HBBBBBBBBBBBBBBBBBBBBBBB';
const OLDER = 'ibx_01HCCCCCCCCCCCCCCCCCCCCCCC';
const UNLISTED = 'ibx_01HDDDDDDDDDDDDDDDDDDDDDDD';

afterEach(() => resetMachineRoutes());

function machines(): void {
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: NEWER, name: 'MacBook', marks: ['star', 'reply-drafts'], list_cursor: 12, state: 'online' },
    { id: OLDER, name: 'Mini', marks: ['star'], list_cursor: 4, state: 'online' },
    { id: UNLISTED, name: 'Air', list_cursor: null, state: 'connecting' },
  ]);
  rememberMachine(['msg_newer'], NEWER);
  rememberMachine(['msg_older'], OLDER);
  rememberMachine(['msg_unlisted'], UNLISTED);
}

/** A draft store that records what reached it. */
function recording(): { store: ReplyDraftStore; saved: string[] } {
  const saved: string[] = [];
  let draft: InboxReplyDraft | null = null;
  return {
    saved,
    store: {
      read: async () => draft,
      save: async (threadId, input) => {
        saved.push(`${threadId}: ${input.body}`);
        draft = { v: 1, thread_id: threadId, body: input.body, created_at: 'now', updated_at: `t${saved.length}` };
        return { draft };
      },
      discard: async () => {},
    },
  };
}

describe('where a reply draft is kept', () => {
  test("this Inbox's threads, and a linked machine's once its list takes reply drafts; never an older or unread one", () => {
    machines();
    expect(keepsReplyDraft('msg_local')).toBe(true);
    expect(keepsReplyDraft('msg_newer')).toBe(true);
    expect(keepsReplyDraft('msg_older')).toBe(false);
    expect(keepsReplyDraft('msg_unlisted')).toBe(false);
  });

  test("the client is told which threads live on a linked machine, whether or not it keeps drafts: its words wait in the page only for those", () => {
    machines();
    expect(['msg_local', 'msg_newer', 'msg_older', 'msg_unlisted'].map(replyDraftHost.isRemote)).toEqual([false, true, true, true]);
  });

  test('a mark is asked one way: this Inbox (no machine, or its own id) takes every mark; a linked one as its list says', () => {
    machines();
    expect([null, SELF, NEWER, OLDER, UNLISTED, 'ibx_01HZZZZZZZZZZZZZZZZZZZZZZZ'].map((id) => hasMachineMark(id, 'reply-drafts'))).toEqual([true, true, true, false, false, false]);
    expect(hasMachineMark({ id: OLDER, marks: ['reply-drafts'] }, 'reply-drafts')).toBe(true);
  });

  test("dictated words for a closed box land in the draft of a linked machine's thread that keeps drafts", async () => {
    machines();
    const { store, saved } = recording();
    await landWordsInReplyDraft('msg_newer', 'and retry after the deploy', store, replyDraftHost.canPersist);
    expect(saved).toEqual(['msg_newer: and retry after the deploy']);
    expect(takeHeldVoiceWords('msg_newer')).toEqual([]);
  });

  test('on an older machine they wait in this page for the box, and nothing is written', async () => {
    machines();
    const { store, saved } = recording();
    await landWordsInReplyDraft('msg_older', 'and retry after the deploy', store, replyDraftHost.canPersist);
    expect(saved).toEqual([]);
    expect(takeHeldVoiceWords('msg_older')).toEqual(['and retry after the deploy']);
  });
});
