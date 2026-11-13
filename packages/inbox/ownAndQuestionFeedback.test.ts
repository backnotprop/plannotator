/**
 * What an agent reads for comments on the person's own messages and on questions (approval
 * "inbox-annotate-own-and-questions", words approved "Yes, as written"), and which reply such a comment rides.
 * Failures this catches: a note on the person's own message filed as "your message" (the agent would read the
 * person's words as its own), or riding a reply to the person's own message; a comment on a question's words that
 * does not say which question (or which choice) it is about; a thread with no own-message notes whose text changes.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import { messageFeedback, questionCommentLine } from './attachments';
import { routeSendAnnotations, sendTargetsOf } from './sendTargets';
import { splitReplyFeedback } from './replyFeedback';

/** The record's annotation, as the export reads it. */
const of = (r: InboxAnnotationRecord) => r.annotation as unknown as Pick<Annotation, 'blockId' | 'originalText'>;

const AT = '2026-11-11T21:58:00.000Z';
const time = () => '2:58 PM';

function record(id: string, originalText: string, text: string, messageId: string, extra: Record<string, unknown> = {}): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_T',
    message_id: messageId,
    attachment_id: '',
    path: messageId,
    version: 'current',
    message: { at: AT },
    annotation: { id, blockId: 'block-0', startOffset: 0, endOffset: 1, type: 'COMMENT', text, originalText, createdA: 1, ...extra },
    created_at: AT,
    updated_at: AT,
    removed_at: null,
    sent_reply_id: null,
  };
}

const QUESTION = [
  'The machines page is drafted. One call before I move it:',
  '',
  ':::question',
  'Should the machines page sit under **Accounts**, or get its own entry?',
  'It holds the list of linked computers.',
  '',
  '- [ ] Under Accounts — keeps the sidebar short',
  '- [ ] Its own top-level entry — easier to find',
  ':::',
].join('\n');

describe('notes on the person\x27s own messages', () => {
  test('go in their own section, after the one on the agent\x27s messages, in the approved words', () => {
    const onAgent = record('c1', 'two, four and eight seconds', 'Cap the total wait.', 'msg_A');
    const onMine = record('c2', 'Keep the old URL', 'I meant the machines page too.', 'msg_ME');
    const text = messageFeedback([onAgent, onMine], time, { personMessageIds: new Set(['msg_ME']) });
    expect(text).toBe(
      [
        '# Feedback on your messages',
        '',
        'The following feedback is on the text of your messages in this thread, one section per message. Each quote is the words I selected (as shown on screen) in your message.',
        '',
        '## Feedback on your message from 2:58 PM (msg_A)',
        '',
        "I've reviewed this message and have 1 piece of feedback:",
        '',
        '### 1. Feedback on: "two, four and eight seconds"',
        '> Cap the total wait.',
        '',
        '---',
        '',
        '# Feedback on my messages',
        '',
        'The following are notes on what I wrote earlier in this thread, one section per message. Each quote is the words I selected in my own message.',
        '',
        '## Feedback on my message from 2:58 PM (msg_ME)',
        '',
        '### 1. Note on: "Keep the old URL"',
        '> I meant the machines page too.',
        '',
        '---',
      ].join('\n'),
    );
    // The sent reply draws both sections as its feedback, after the person's words.
    expect(splitReplyFeedback(`Go ahead.\n\n${text}`)?.words.trim()).toBe('Go ahead.');
  });

  test('alone, only their section; without the person\x27s ids the text is as before', () => {
    const onMine = record('c2', 'Keep the old URL', 'Too.', 'msg_ME');
    expect(messageFeedback([onMine], time, { personMessageIds: new Set(['msg_ME']) }).startsWith('# Feedback on my messages\n')).toBe(true);
    expect(messageFeedback([onMine], time).startsWith('# Feedback on your messages\n')).toBe(true);
  });

  test('ride the last reply, with the words, never a reply to the person\x27s own message', () => {
    const agent = (id: string, session: string) => ({ id, thread_id: 'msg_A', author: { kind: 'agent', host: 'claude-code', session, name: 'Claude Code' }, body: '', questions: [], created_at: AT }) as unknown as InboxMessageWire;
    const mine = { id: 'msg_ME', thread_id: 'msg_A', author: { kind: 'person' }, body: 'Keep the old URL.', created_at: AT } as unknown as InboxMessageWire;
    const t = { thread_id: 'msg_A', messages: [agent('msg_A', 'ses_a'), mine, agent('msg_B', 'ses_a')] } as unknown as InboxThread;
    const routed = routeSendAnnotations(t, sendTargetsOf(t), [record('c1', 'Keep', 'x', 'msg_ME')]);
    expect(routed.targets.map((x) => x.message.id)).toEqual(['msg_B']);
    expect(routed.carried.get('msg_B')!.map((r) => r.id)).toEqual(['c1']);
  });
});

describe('a comment on a question', () => {
  test('on its prompt or context: "In question 1" with the prompt, under the words', () => {
    const onPrompt = record('q1', 'sit under Accounts', 'Not under Accounts.', 'msg_Q', { blockId: 'block-1' });
    expect(questionCommentLine(of(onPrompt), QUESTION)).toBe('In question 1: "Should the machines page sit under Accounts, or get its own entry?"');
    const onContext = record('q2', 'list of linked computers', 'And their names.', 'msg_Q', { blockId: 'block-1' });
    expect(questionCommentLine(of(onContext), QUESTION)).toBe('In question 1: "Should the machines page sit under Accounts, or get its own entry?"');
    const text = messageFeedback([onPrompt], time, { bodies: new Map([['msg_Q', QUESTION]]) });
    expect(text).toContain('### 1. Feedback on: "sit under Accounts"\nIn question 1: "Should the machines page sit under Accounts, or get its own entry?"\n> Not under Accounts.\n');
  });

  test("on a choice's label or description: the choice's line", () => {
    const onLabel = record('q3', 'Its own top-level entry', 'Below Projects.', 'msg_Q', { blockId: 'block-1' });
    expect(questionCommentLine(of(onLabel), QUESTION)).toBe('In question 1, choice "Its own top-level entry":');
    const onDescription = record('q4', 'keeps the sidebar short', 'It is long already.', 'msg_Q', { blockId: 'block-1' });
    expect(questionCommentLine(of(onDescription), QUESTION)).toBe('In question 1, choice "Under Accounts":');
    const text = messageFeedback([onLabel], time, { bodies: new Map([['msg_Q', QUESTION]]) });
    expect(text).toContain('### 1. Feedback on: "Its own top-level entry"\nIn question 1, choice "Its own top-level entry":\n> Below Projects.\n');
  });

  test('words outside the question have no line; a message with no question is unchanged', () => {
    expect(questionCommentLine(of(record('w1', 'The machines page is drafted', 'x', 'msg_Q', { blockId: 'block-0' })), QUESTION)).toBeNull();
    expect(questionCommentLine(of(record('w2', 'anything', 'x', 'msg_P')), 'Plain words.')).toBeNull();
    const plain = record('w3', 'Plain', 'x', 'msg_P');
    expect(messageFeedback([plain], time, { bodies: new Map([['msg_P', 'Plain words.']]) })).toBe(messageFeedback([plain], time));
  });
});
