/**
 * Comments on the person's own messages and on questions (approval "inbox-annotate-own-and-questions"), in the
 * store: the person's own message takes a comment and a Send carries it; the Inbox's own notes (a 👍's note) take
 * none; a comment on a question's words never answers, skips or settles it. Each test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from './store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUESTION = ['One call before I move it:', '', ':::question', 'Should the machines page sit under Accounts?', '', '- [ ] Under Accounts', '- [ ] Its own entry', ':::'].join('\n');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-inbox-own-comments-'));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: 'docs', root: '/work/docs' });
  const claude = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
  let n = 0;
  const say = (body: string, reply_to: string | null = null) =>
    store.sendMessage({ project_id: project.id, author: claude, body, idempotency_key: `m${++n}`, ...(reply_to ? { reply_to } : {}) }).message;
  return { store, say };
}

const comment = (id: string, originalText: string, text = 'A note.') => ({ id, blockId: 'block-0', startOffset: 0, endOffset: originalText.length, type: 'COMMENT', text, originalText, createdA: 1 });

describe("the person's own message", () => {
  test('takes a comment, and a Send carries it', () => {
    const { store, say } = setup();
    const first = say('Here is the plan.');
    const mine = store.sendReply(first.id, { words: 'Keep the old URL for the projects page.', idempotency_key: 'r1' }).reply;
    const later = say('Kept it.', mine.id);
    const record = store.saveMessageAnnotation(mine.id, comment('ann-own', 'Keep the old URL', 'I meant the machines page too.'));
    expect(record.message_id).toBe(mine.id);
    const { reply } = store.sendReply(later.id, { words: 'One more thing.', idempotency_key: 'r2', feedback: '# Feedback on my messages', annotation_ids: ['ann-own'] });
    expect(store.thread(first.thread_id)!.messages.some((m) => m.id === reply.id)).toBe(true);
    // Sent with that reply: closed to edits.
    expect(() => store.saveMessageAnnotation(mine.id, comment('ann-own', 'Keep the old URL', 'Edit after send.'))).toThrow(expect.objectContaining({ code: 'annotation_closed' }));
  });

  test("the Inbox's own notes take none (a 👍's note)", () => {
    const { store, say } = setup();
    const first = say('Done: the page moved.');
    store.ackMessage(first.id, true);
    const noteId = store.settleAcks(0)[0]?.ack?.note_id;
    expect(typeof noteId).toBe('string');
    expect(() => store.saveMessageAnnotation(noteId!, comment('ann-note', 'Looks good'))).toThrow(expect.objectContaining({ code: 'annotation_not_allowed' }));
  });
});

describe('a question', () => {
  test("a comment on its words, sent with a reply, does not answer, skip or settle it", () => {
    const { store, say } = setup();
    const asked = say(QUESTION);
    const before = store.thread(asked.thread_id)!.messages.find((m) => m.id === asked.id)!.questions!;
    expect(before.map((q) => q.state)).toEqual(['open']);
    store.saveMessageAnnotation(asked.id, comment('ann-q', 'Its own entry', 'Top-level, but below Projects.'));
    store.sendReply(asked.id, { words: 'See my note on the choice.', idempotency_key: 'r1', feedback: 'In question 1, choice "Its own entry":', annotation_ids: ['ann-q'] });
    const after = store.thread(asked.thread_id)!.messages.find((m) => m.id === asked.id)!.questions!;
    expect(after.map((q) => [q.key, q.state, q.answer ?? null])).toEqual(before.map((q) => [q.key, 'open', null]));
  });
});
