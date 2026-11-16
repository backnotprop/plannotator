/**
 * Reply with a quote (approval "inbox-reply-quote"), in the store: the quote a Send carries is kept on the reply and
 * its lead goes in front of the person's words (what every agent reads); a reply without one is exactly as before;
 * the wake's "Replying to" line is not said twice; a draft keeps the quote. Each test uses its own temp data dir.
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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-inbox-reply-quote-'));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: 'docs', root: '/work/docs' });
  const claude = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
  const codex = { kind: 'agent' as const, host: 'codex', session: 'ses_codex', name: 'Codex' };
  let n = 0;
  const say = (body: string, author = claude, reply_to: string | null = null) =>
    store.sendMessage({ project_id: project.id, author, body, idempotency_key: `m${++n}`, ...(reply_to ? { reply_to } : {}) }).message;
  const first = say('Here is how the three fit together. Machines run your agents.');
  const later = say('I also linked the terms. Want a PR?', claude, first.id);
  return { dir, store, first, later, say, codex };
}

describe('a Send with a quote', () => {
  test('the lead goes in front of the words, and the reply keeps the quote', () => {
    const { store, first, later } = setup();
    const { reply } = store.sendReply(later.id, { words: 'Say the machines part again.', idempotency_key: 's1', quote: { of: first.id, time: '10:04 AM' } });
    expect(reply.quote).toEqual({ of: first.id });
    expect(reply.body).toBe(`Replying to your message from 10:04 AM (${first.id}):\n> Here is how the three fit together. Machines run your agents.\n\nSay the machines part again.`);
    // Still a reply to the session's latest message: who gets it and what settles it are unchanged.
    expect(reply.reply_to).toBe(later.id);
  });

  test('selected words are quoted whole and kept on the reply', () => {
    const { store, first, later } = setup();
    const { reply } = store.sendReply(later.id, { words: 'Explain this.', idempotency_key: 's1', quote: { of: first.id, words: 'Machines run your agents.', time: '10:04 AM' } });
    expect(reply.quote).toEqual({ of: first.id, words: 'Machines run your agents.' });
    expect(reply.body.startsWith(`Replying to these words in your message from 10:04 AM (${first.id}):\n> Machines run your agents.\n\nExplain this.`)).toBe(true);
  });

  test("the person's own message, and another agent's, are named as such", () => {
    const { store, first, later, say, codex } = setup();
    const mine = store.sendReply(first.id, { words: 'Keep the old path.', idempotency_key: 's0' }).reply;
    const other = say('Codex here: I can take the docs.', codex, first.id);
    const a = store.sendReply(later.id, { words: 'Scratch that.', idempotency_key: 's1', quote: { of: mine.id, time: '9:58 AM' } }).reply;
    expect(a.body.split('\n')[0]).toBe(`Replying to my message from 9:58 AM (${mine.id}):`);
    const b = store.sendReply(later.id, { words: 'Do you agree?', idempotency_key: 's2', quote: { of: other.id, time: '10:01 AM' } }).reply;
    expect(b.body.split('\n')[0]).toBe(`Replying to Codex's message from 10:01 AM (${other.id}):`);
  });

  test('without a quote a reply is exactly as before (an older window sends none)', () => {
    const { store, later } = setup();
    const { reply } = store.sendReply(later.id, { words: 'Yes, open it.', idempotency_key: 's1' });
    expect(reply.body).toBe('Yes, open it.');
    expect('quote' in reply).toBe(false);
  });

  test('a quote rides words only: picks alone carry none', () => {
    const { store, first, later } = setup();
    expect(() => store.sendReply(later.id, { words: '', idempotency_key: 's1', quote: { of: first.id } })).toThrow(expect.objectContaining({ code: 'validation_error', details: expect.objectContaining({ field: 'words' }) }));
  });

  test('a quote of a message not in this thread, or a malformed one, is refused and nothing is written', () => {
    const { store, later, say } = setup();
    const elsewhere = say('Another thread.');
    const cursor = store.cursor();
    expect(() => store.sendReply(later.id, { words: 'x', idempotency_key: 's1', quote: { of: elsewhere.id } })).toThrow(expect.objectContaining({ code: 'validation_error', details: expect.objectContaining({ field: 'quote.of' }) }));
    expect(() => store.sendReply(later.id, { words: 'x', idempotency_key: 's2', quote: 'msg_x' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ field: 'quote' }) }));
    expect(() => store.sendReply(later.id, { words: 'x', idempotency_key: 's3', quote: { of: later.id, words: '' } })).toThrow(expect.objectContaining({ details: expect.objectContaining({ field: 'quote.words' }) }));
    expect(store.cursor()).toBe(cursor);
  });

  test('the quote survives a reopen of the store from disk', () => {
    const { dir, store, first, later } = setup();
    const { reply } = store.sendReply(later.id, { words: 'Again?', idempotency_key: 's1', quote: { of: first.id, words: 'Machines run your agents.' } });
    const again = InboxStore.open(dir).thread(first.thread_id)!.messages.find((m) => m.id === reply.id)!;
    expect(again.quote).toEqual({ of: first.id, words: 'Machines run your agents.' });
  });
});

describe('the wake', () => {
  test('a reply quoting an older message of the session does not say "Replying to" twice', () => {
    const { store, first, later } = setup();
    // Answers on the older message name it in the wake's own line (today's behaviour)…
    const plain = store.sendReply(later.id, { words: 'No quote.', idempotency_key: 's0' }).reply;
    expect(store.wakeContext(plain, 'ses_claude').replying_to).toBeUndefined();
    // …and a reply to it whose words quote it says it in the lead instead.
    const toFirst = store.sendReply(first.id, { words: 'Quoted.', idempotency_key: 's1', quote: { of: first.id } }).reply;
    expect(toFirst.reply_to).toBe(first.id);
    expect(store.wakeContext(toFirst, 'ses_claude').replying_to).toBeUndefined();
    // A reply to that older message that quotes another one keeps the line naming the message it answers.
    const other = store.sendReply(first.id, { words: 'Other.', idempotency_key: 's2', quote: { of: later.id } }).reply;
    expect(store.wakeContext(other, 'ses_claude').replying_to?.id).toBe(first.id);
  });
});

describe('the draft', () => {
  test('a save that names a quote keeps it; a save without one keeps it; null takes it away', () => {
    const { store, first } = setup();
    const thread = first.thread_id;
    const a = store.saveReplyDraft(thread, { body: 'Say it again', base: null, quote: { of: first.id, words: 'Machines run your agents.' } })!;
    expect(a.quote).toEqual({ of: first.id, words: 'Machines run your agents.' });
    const b = store.saveReplyDraft(thread, { body: 'Say it again, please', base: a.updated_at })!;
    expect(b.quote).toEqual({ of: first.id, words: 'Machines run your agents.' });
    const c = store.saveReplyDraft(thread, { body: 'Say it again, please', base: b.updated_at, quote: null })!;
    expect(c.quote).toBeUndefined();
  });

  test('a malformed quote is refused', () => {
    const { store, first } = setup();
    expect(() => store.saveReplyDraft(first.thread_id, { body: 'x', base: null, quote: { of: 'nope' } })).toThrow(expect.objectContaining({ code: 'validation_error', details: expect.objectContaining({ field: 'quote' }) }));
  });
});
