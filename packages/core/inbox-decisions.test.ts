// The decision export's pure builder (`buildDecisionExport`), from records alone: no store, no disk. Questions are
// parsed from message bodies by the Inbox's own parser (`parseInboxQuestionBlocks`), as the store does, and given the
// answers the store would write. What regresses: what each kind of answer becomes as a decision item (its fields are
// the `plannotator.decisions` v1 wire a host reads), a skipped or replaced question passing for a decision, an action
// item counted, or the asking session's id reaching the output.
import { describe, expect, test } from 'bun:test';
import { buildDecisionExport, DECISION_EXPORT_FORMAT, type DecisionExportInput, type DecisionExportItem } from './inbox-decisions';
import { parseInboxQuestionBlocks } from './inbox-questions';
import type { InboxMessage, InboxQuestionRecord } from './inbox-types';
import type { QuestionAnswer } from './question-block';

const SESSION = 'ses-secret-7f3a91';
const PROJECT = 'prj_acme';
const agent = { kind: 'agent' as const, host: 'claude-code', session: SESSION, name: null };
const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;

const message = (id: string, minute: number, body: string, author: InboxMessage['author'] = agent, replyTo: string | null = null): InboxMessage => ({
  id,
  project_id: PROJECT,
  thread_id: 'msg_root',
  reply_to: replyTo,
  author,
  subject: replyTo ? null : 'Sync conflicts',
  body,
  created_at: at(minute),
  resolved_at: null,
  idempotency_key: null,
});

/** The records the store writes for a message's question blocks: asked, nothing picked. */
const recordsOf = (m: InboxMessage): InboxQuestionRecord[] =>
  parseInboxQuestionBlocks(m.body).map((q) => ({
    id: `${m.id}/${q.key}`,
    project_id: PROJECT,
    message_id: m.id,
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    parsed: q.parsed,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: SESSION,
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
  }));

/** A pick saved at `pickedMinute` and sent with the reply `reply`. */
const sent = (record: InboxQuestionRecord, answer: Partial<QuestionAnswer>, pickedMinute: number, reply: InboxMessage): InboxQuestionRecord => ({
  ...record,
  answer: { v: 1, key: record.key, kind: record.kind === 'action' ? 'single' : record.kind, prompt: record.prompt, selected: [], ...answer },
  revision: 1,
  sent_revision: 1,
  picked_at: at(pickedMinute),
  sent_reply_id: reply.id,
});

function thread() {
  const root = message(
    'msg_root',
    0,
    [
      ':::question\nKeep the losing version where?\n- [ ] In a side file\n- [ ] In the note history\n\nRecommended: In a side file\n:::',
      ':::question-multi\nWhich apps first?\n- [ ] Web\n- [ ] Phone\n- [ ] Desktop\n\nRecommended: Web and Phone\n:::',
      ':::question-text\nWhat should the button say?\n:::',
      ':::question\nWhich merge rule?\n- [ ] Newest wins\n- [ ] Ask every time\n\nRecommended: Newest wins\n:::',
      ':::question\nRename Sync?\n- [ ] Yes\n- [ ] No\n:::',
      ':::question\nOld retry question?\n- [ ] Retry\n- [ ] Give up\n:::',
    ].join('\n\n'),
  );
  const reply1 = message('msg_reply1', 5, 'Answered 4 questions, skipped 1.', { kind: 'person' }, root.id);
  const second = message('msg_second', 10, ':::question\nHow should a failed upload retry?\n- [ ] Back off\n- [ ] Retry at once\n:::', agent, root.id);
  const reply2 = message('msg_reply2', 15, 'Answered 1 question.', { kind: 'person' }, second.id);

  const [single, multi, text, other, skipped, old] = recordsOf(root);
  const [replacement] = recordsOf(second);
  // An action item is stored as a question record of kind "action"; it is never a decision.
  const action: InboxQuestionRecord = { ...single!, id: `${root.id}/a-1`, key: 'a-1', kind: 'action', prompt: 'Run the migration.' };
  const questions = [
    sent(single!, { selected: ['In a side file'] }, 3, reply1),
    sent(multi!, { selected: ['Web', 'Desktop'] }, 3, reply1),
    sent(text!, { text: 'Save draft' }, 3, reply1),
    sent(other!, { other: 'Keep both, behind a flag', note: 'Ada wants to see both first.' }, 3, reply1),
    sent(skipped!, { skipped: true }, 3, reply1),
    { ...old!, superseded_by: { message_id: second.id, key: replacement!.key } },
    action,
    sent(replacement!, { selected: ['Back off'] }, 12, reply2),
  ];
  const messages = [root, reply1, second, reply2];
  const input: DecisionExportInput = {
    thread: { id: root.id, subject: 'Sync conflicts', project: 'acme-notes' },
    messages,
    byId: new Map(messages.map((m) => [m.id, m])),
    headOf: (id) => id,
    closedByArchive: () => false,
    questions,
  };
  const { doc } = buildDecisionExport(input, { now: new Date('2026-11-10T12:00:00Z'), tz: 'UTC', generator: 'Plannotator test', pulls: [], home: null });
  const item = (prompt: string): DecisionExportItem => [...doc.decisions, ...doc.others].find((i) => i.prompt === prompt)!;
  return { doc, item, ids: { single: single!.id, old: old!.id, replacement: replacement!.id }, root };
}

describe('buildDecisionExport from records alone', () => {
  test('the decisions come first in the order asked, the skipped and replaced questions after them, the action item nowhere', () => {
    const { doc } = thread();
    expect(doc.format).toBe(DECISION_EXPORT_FORMAT);
    expect(doc.v).toBe(1);
    expect(doc.decisions.map((d) => [d.n, d.prompt, d.state])).toEqual([
      [1, 'Keep the losing version where?', 'decided'],
      [2, 'Which apps first?', 'decided'],
      [3, 'What should the button say?', 'decided'],
      [4, 'Which merge rule?', 'decided'],
      [5, 'How should a failed upload retry?', 'decided'],
    ]);
    expect(doc.others.map((d) => [d.n, d.prompt, d.state])).toEqual([
      [6, 'Rename Sync?', 'skipped'],
      [7, 'Old retry question?', 'replaced'],
    ]);
    expect(doc.counts).toEqual({ decided: 5, picked_unsent: 0, answered_in_words: 0, open: 0, skipped: 1, set_aside: 0, archived: 0, replaced: 1 });
    expect(JSON.stringify(doc)).not.toContain('Run the migration.');
  });

  test('an answered single-choice question: the pick is chosen, it took the recommendation, it was sent', () => {
    const { item, ids, root } = thread();
    expect(item('Keep the losing version where?')).toEqual({
      n: 1,
      id: ids.single,
      state: 'decided',
      kind: 'single',
      prompt: 'Keep the losing version where?',
      choices: [
        { label: 'In a side file', recommended: true, chosen: true },
        { label: 'In the note history', recommended: false, chosen: false },
      ],
      recommendation: { labels: ['In a side file'], text: null, taken: true },
      answer: { selected: ['In a side file'], other: null, text: null, note: null, skipped: false, sent: true },
      asked: { by: 'Claude Code', at: at(0), message_id: root.id },
      answered: { at: at(3), sent_at: at(5) },
      replaces: [],
    });
  });

  test('a multi-choice answer marks every pick, and a set other than the recommended one did not take it', () => {
    const multi = thread().item('Which apps first?');
    expect(multi.kind).toBe('multi');
    expect(multi.choices.map((c) => [c.label, c.recommended, c.chosen])).toEqual([
      ['Web', true, true],
      ['Phone', true, false],
      ['Desktop', false, true],
    ]);
    expect(multi.answer).toEqual({ selected: ['Web', 'Desktop'], other: null, text: null, note: null, skipped: false, sent: true });
    expect(multi.recommendation).toEqual({ labels: ['Web', 'Phone'], text: null, taken: false });
  });

  test('a text answer has no choices and carries its words; with no recommendation offered, taken is null', () => {
    const text = thread().item('What should the button say?');
    expect(text.kind).toBe('text');
    expect(text.choices).toEqual([]);
    expect(text.answer).toEqual({ selected: [], other: null, text: 'Save draft', note: null, skipped: false, sent: true });
    expect(text.recommendation).toEqual({ labels: [], text: null, taken: null });
  });

  test('an "Other" answer with a note: no choice is chosen, the words and the note are kept, the recommendation was not taken', () => {
    const other = thread().item('Which merge rule?');
    expect(other.state).toBe('decided');
    expect(other.choices.map((c) => c.chosen)).toEqual([false, false]);
    expect(other.answer).toEqual({ selected: [], other: 'Keep both, behind a flag', text: null, note: 'Ada wants to see both first.', skipped: false, sent: true });
    expect(other.recommendation.taken).toBe(false);
  });

  test('a skipped question is not a decision: it is listed as skipped, sent, with no verdict on the recommendation', () => {
    const skipped = thread().item('Rename Sync?');
    expect(skipped.state).toBe('skipped');
    expect(skipped.answer).toEqual({ selected: [], other: null, text: null, note: null, skipped: true, sent: true });
    expect(skipped.answered).toEqual({ at: at(3), sent_at: at(5) });
    expect(skipped.recommendation.taken).toBeNull();
    expect(skipped.replaces).toBeUndefined();
  });

  test('a superseded question is listed as replaced, naming its replacement, which in turn names what it replaces', () => {
    const { item, ids } = thread();
    const old = item('Old retry question?');
    expect(old.state).toBe('replaced');
    expect(old.answer).toBeNull();
    expect(old.answered).toBeUndefined();
    expect(old.replaced_by).toEqual({ id: ids.replacement, prompt: 'How should a failed upload retry?' });
    expect(item('How should a failed upload retry?').replaces).toEqual([{ id: ids.old, prompt: 'Old retry question?', asked_at: at(0) }]);
  });

  test("the asking session's id is in no field: an agent is its host's name", () => {
    const { doc } = thread();
    expect(JSON.stringify(doc)).not.toContain(SESSION);
    expect(new Set([...doc.decisions, ...doc.others].map((i) => i.asked.by))).toEqual(new Set(['Claude Code']));
  });
});
