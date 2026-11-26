/**
 * A skill emoji's reply as the person reads it (the owner's pick, 2026-11-26: "As a normal reply with text"): its
 * words are "🦃 /bro" in the thread's drawing, its folded line and the list's preview; a typed `/bro` reply, with no
 * `skill_reaction`, reads as it always did.
 */
import { expect, test } from 'bun:test';
import { foldSnippet, inboxRowPreview, skillReactionShownBody, skillReactionText } from './inbox-folding';
import { inboxReplyQuoteLead } from './inbox-reply-quote';
import type { InboxMessageWire } from './inbox-types';

const ID = 'msg_01M8A00000000000000000003';
const SKILLS = '**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):\n- `bro`';
const LEAD = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: '2:03 PM', text: 'Done. The run: harbor CI #482.', selected: false });

const reply = (body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire =>
  ({ id: 'msg_01M8A00000000000000000009', thread_id: ID, project_id: 'prj_1', reply_to: ID, author: { kind: 'person' }, subject: null, body, created_at: '2026-11-26T14:05:00.000Z', resolved_at: null, idempotency_key: 'k', ...extra }) as InboxMessageWire;
const TURKEY = { skill_reaction: { emoji: '🦃', skill: 'bro' } };

test('the thread draws the emoji in front of the words, after a quoting reply’s lead; the rest of the body as sent', () => {
  expect(skillReactionShownBody(reply(`/bro\n\n${SKILLS}`, TURKEY))).toBe(`🦃 /bro\n\n${SKILLS}`);
  expect(skillReactionShownBody(reply(`${LEAD}\n\n/bro\n\n${SKILLS}`, { ...TURKEY, quote: { of: ID } }))).toBe(`${LEAD}\n\n🦃 /bro\n\n${SKILLS}`);
  expect(skillReactionShownBody(reply('/bro', TURKEY))).toBe('🦃 /bro');
});

test('a body whose words are not the skill’s, or a reply with no skill emoji, is drawn as it is', () => {
  expect(skillReactionShownBody(reply('/brother', TURKEY))).toBe('/brother');
  expect(skillReactionShownBody(reply('Ship it. /bro', TURKEY))).toBe('Ship it. /bro');
  expect(skillReactionShownBody(reply(`/bro\n\n${SKILLS}`))).toBe(`/bro\n\n${SKILLS}`);
  expect(skillReactionText(reply('/bro'))).toBeNull();
});

test('the folded line and the list’s preview read "🦃 /bro"; a typed /bro reply still reads "/bro"', () => {
  const pressed = reply(`${LEAD}\n\n/bro\n\n${SKILLS}`, { ...TURKEY, quote: { of: ID } });
  expect(foldSnippet(pressed)).toEqual({ kind: 'words', text: '🦃 /bro' });
  expect(inboxRowPreview({ message: pressed })).toBe('You: 🦃 /bro');
  const typed = reply(`/bro\n\n${SKILLS}`);
  expect(foldSnippet(typed)).toEqual({ kind: 'words', text: '/bro' });
  expect(inboxRowPreview({ message: typed })).toBe('You: /bro');
});
