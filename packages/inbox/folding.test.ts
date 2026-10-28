/**
 * The pure rules a thread folds by (folding.ts): the boundary of "new since
 * you looked", the fold plan, and a folded line's first words. The pane's
 * drawing of them is proved in threadFolding.test.tsx.
 */
import { expect, test } from 'bun:test';
import type { InboxAuthor, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { QUESTION_ANSWERS_HEADING } from '@plannotator/core/question-block';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { SNIPPET_PROMPT_MAX, answerWords, cleanInline, cutAtWord, firstWords, foldSnippet, lookBoundary, newSinceLook, plainLabel, planFolds, replyWords, snippetText } from './folding';

const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const PERSON: InboxAuthor = { kind: 'person' };

function msg(id: string, author: InboxAuthor, seq: number | undefined, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return { id, project_id: 'prj_1', thread_id: 'm1', reply_to: null, author, subject: null, body: id, created_at: '2026-10-10T10:00:00.000Z', resolved_at: null, idempotency_key: null, ...(seq === undefined ? {} : { seq }), ...extra };
}

const thread = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: 'm1', project: { id: 'prj_1', key: 'k', name: 'p', root: '/p', created_at: '' }, subject: null, thread_name: null, resolved_at: null, messages });

test("the boundary is the later of the person's last look and their last reply; an older payload without seqs has none", () => {
  expect(lookBoundary(thread([msg('m1', AGENT, 2, { person_seen_seq: 9 }), msg('m2', PERSON, 5), msg('m3', AGENT, 11)]))).toBe(9);
  expect(lookBoundary(thread([msg('m1', AGENT, 2, { person_seen_seq: 3 }), msg('m2', PERSON, 5), msg('m3', AGENT, 11)]))).toBe(5);
  expect(lookBoundary(thread([msg('m1', AGENT, 2), msg('m3', AGENT, 4)]))).toBe(0);
  expect(lookBoundary(thread([msg('m1', AGENT, 2), msg('m3', AGENT, undefined)]))).toBeNull();
  const messages = [msg('m1', AGENT, 2), msg('m2', PERSON, 5), msg('m3', AGENT, 11)];
  expect([...newSinceLook(messages, 5)]).toEqual(['m3']);
  expect([...newSinceLook(messages, null)]).toEqual([]);
});

test("the Inbox's own notes (set-aside, reopened) are not a look: news before a note stays new", () => {
  const messages = [
    msg('m1', AGENT, 2, { person_seen_seq: 2 }),
    msg('m2', AGENT, 4),
    msg('m3', PERSON, 6, { set_aside: ['m1/q-1'] }),
    msg('m4', PERSON, 8, { reopened: ['m1/q-1'] }),
  ];
  expect(lookBoundary(thread(messages))).toBe(2);
  expect([...newSinceLook(messages, lookBoundary(thread(messages)))]).toEqual(['m2']);
  // The person's real reply still is one.
  expect(lookBoundary(thread([...messages, msg('m5', PERSON, 9)]))).toBe(9);
});

test("the fold plan keeps the last real message open when the Inbox's notes trail it (its reply line sits there)", () => {
  const messages = [msg('m1', AGENT, 2), msg('m2', AGENT, 3), msg('m3', PERSON, 5), msg('m4', PERSON, 7, { set_aside: ['m1/q-1'] })];
  expect([...planFolds(messages, new Set(), 9).folded]).toEqual(['m1', 'm2']);
});

test('the fold plan: open when new, holding an unsent pick, or last; each read run of 4 or more hides all but its first and last two', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `m${i + 1}`);
  const messages = ids.map((id, i) => msg(id, i % 2 ? PERSON : AGENT, i + 1));
  // m5 is new: it splits the read messages into a run of 4 (m1..m4) and a run of 3 (m6..m8); m9 is last.
  const plan = planFolds(messages, new Set(['m5']), 4);
  expect([...plan.folded]).toEqual(['m1', 'm2', 'm3', 'm4', 'm6', 'm7', 'm8']);
  expect(plan.hidden).toEqual([['m2']]);
  // Seven read messages in a row and the last: one fold of four.
  expect(planFolds(messages.slice(0, 8), new Set(), 8).hidden).toEqual([['m2', 'm3', 'm4', 'm5']]);
  // One message, or no seqs: nothing folds.
  expect(planFolds(messages.slice(0, 1), new Set(), 1).folded.size).toBe(0);
  expect(planFolds(messages, new Set(), null).folded.size).toBe(0);
});

test("a folded line's first words: question blocks, fences, tables and images out; marks and link targets gone; cut at a word", () => {
  const body = [
    '## Search',
    '',
    'I looked at **three** ways: see [the plan](plan.md) and ![a mock](mock.png) `docs-search`.',
    '',
    '```ts',
    'const index = build();',
    '```',
    '',
    '| Option | Cost |',
    '| --- | --- |',
    '| Pagefind | 1.6 MB |',
    '',
    ':::question',
    'Which index?',
    '',
    '- [ ] Pagefind',
    ':::',
    '',
    '- Built at deploy',
    '> Quoted',
  ].join('\n');
  expect(firstWords(body)).toBe('Search I looked at three ways: see the plan and docs-search. Built at deploy Quoted');
  expect(firstWords('word '.repeat(100), 40)).toBe(`${'word '.repeat(8).trim()}…`);
});

test('emphasis marks go only where they pair at word boundaries; snake_case, arithmetic and inline code keep their characters', () => {
  expect(firstWords('Rename retry_count to max_retry_count in `queue_worker.ts`.')).toBe('Rename retry_count to max_retry_count in queue_worker.ts.');
  expect(firstWords('It costs 2 * 3 = 6 seconds, and **this** is _the_ ~~old~~ *new* plan.')).toBe('It costs 2 * 3 = 6 seconds, and this is the old new plan.');
  expect(cleanInline('The `**not bold**` stays, __a__ goes.')).toBe('The **not bold** stays, a goes.');
  // A closing mark followed by `.` and a word character is part of a name.
  expect(firstWords('__init__.py is here, and so is *main*.')).toBe('__init__.py is here, and so is main.');
  expect(firstWords('Read **this**: it is _short_; (*really*) "**quoted**".')).toBe('Read this: it is short; (really) "quoted".');
});

test("a person's reply snippet: its own words, without the store's 'Answered N questions.' and the answers section after them", () => {
  const body = [
    'Answered 2 questions.',
    '',
    'Pagefind is fine. Keep the blog out for now.',
    '',
    `## ${QUESTION_ANSWERS_HEADING}`,
    '',
    '1. **Which search index?** Pagefind',
    '',
    '# Feedback on the attached files',
  ].join('\n');
  expect(replyWords(body).trim()).toBe('Pagefind is fine. Keep the blog out for now.');
  expect(replyWords('Read it, looks good.')).toBe('Read it, looks good.');
});

test('a long prompt is cut at a word near 40 characters, so the answer after it stays on the line', () => {
  const prompt = 'Which of the **three** options in the `search` table should the docs site use for its first release, given the deploy cost?';
  const message = msg('m1', AGENT, 2, {
    body: `:::question\n${prompt}\n\n- [ ] Pagefind\n:::`,
    questions: [{ key: 'q-1', prompt, state: 'sent', orphaned: false, answer: { v: 1, key: 'q-1', kind: 'single', prompt, selected: ['Pagefind'] } } as never],
  });
  const snippet = foldSnippet(message);
  expect(snippet.kind).toBe('answers');
  if (snippet.kind !== 'answers') return;
  expect(snippet.parts[0]!.prompt).toBe('Which of the three options in the search…');
  expect(snippet.parts[0]!.prompt.length).toBeLessThanOrEqual(SNIPPET_PROMPT_MAX + 1);
  expect(snippet.parts[0]!.full).toBe('Which of the three options in the search table should the docs site use for its first release, given the deploy cost');
  expect(cutAtWord('short', 40)).toBe('short');
});

test("a picked label's markdown (a link, code, bold) reads as its words on the line; Other and free text stay as typed", () => {
  const prompt = 'Which discount should the promo run?';
  const message = msg('m1', AGENT, 2, {
    body: `:::question-multi\n${prompt}\n\n- [ ] [15% off](forecast-15.html)\n- [ ] \`FLAT10\` code\n- [ ] **20%** for members\n- [ ] No discount\n:::`,
    questions: [
      {
        key: 'q-1',
        prompt,
        state: 'sent',
        orphaned: false,
        answer: { v: 1, key: 'q-1', kind: 'multi', prompt, selected: ['[15% off](forecast-15.html)', '`FLAT10` code', '**20%** for members', 'No discount'], other: 'a **custom** deal' },
      } as never,
    ],
  });
  const snippet = foldSnippet(message);
  expect(snippet).toEqual({
    kind: 'answers',
    parts: [{ prompt: 'Which discount should the promo run', full: 'Which discount should the promo run', answer: '15% off, FLAT10 code, 20% for members, No discount, a **custom** deal' }],
  });
  expect(snippetText(snippet)).toBe('Which discount should the promo run: 15% off, FLAT10 code, 20% for members, No discount, a **custom** deal');
  // A label that is only a picture reads as its alt text, never as nothing.
  expect(plainLabel('![The dark mock](dark.png)')).toBe('The dark mock');
  expect(plainLabel('snake_case and 2 * 3')).toBe('snake_case and 2 * 3');
});

test('a picked label keeps <…> text, as the live card shows it; a prompt still drops tags', () => {
  expect(plainLabel('Array<string> type')).toBe('Array<string> type');
  expect(plainLabel('Use <Button> component')).toBe('Use <Button> component');
  expect(plainLabel('Return Result<T, E>')).toBe('Return Result<T, E>');
  expect(plainLabel('x<y>z')).toBe('x<y>z');
  expect(cleanInline('Ship <b>now</b>?')).toBe('Ship now?');
  // An autolink reads as its address.
  expect(plainLabel('Mail <ops@example.com>')).toBe('Mail ops@example.com');
  expect(plainLabel('See <https://example.com/a>')).toBe('See https://example.com/a');
});

test('a picked label reads a backslash escape as its character, as the live card does', () => {
  expect(plainLabel('\\*literal stars\\*')).toBe('*literal stars*');
  expect(plainLabel('C\\+\\+')).toBe('C++');
  expect(plainLabel('a \\_b\\_ c')).toBe('a _b_ c');
});

test('a picked label that links to an address with parentheses reads as its link text', () => {
  expect(plainLabel('[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('Wiki');
  expect(plainLabel('![Mock](shots/mock_(dark).png)')).toBe('Mock');
});

test('a picked label: a link with brackets in its text, and a picture with no alt text', () => {
  expect(plainLabel('[a [nested] label](x.html)')).toBe('a [nested] label');
  expect(plainLabel('![](shots/dark.png)')).toBe('dark.png');
});

test('a picked label keeps names and arithmetic whole', () => {
  expect(plainLabel('snake_case')).toBe('snake_case');
  expect(plainLabel('`__init__.py`')).toBe('__init__.py');
  expect(plainLabel('__init__.py')).toBe('__init__.py');
  expect(plainLabel('2*3*4')).toBe('2*3*4');
  expect(plainLabel('`*args` and `**kwargs`')).toBe('*args and **kwargs');
  expect(plainLabel('*args and **kwargs')).toBe('*args and **kwargs');
  expect(plainLabel('Inline `a\\*b` code')).toBe('Inline a\\*b code');
});

test('a markdown label written with a (Recommended) marker answers as its plain words, with no marker', () => {
  // The parser takes the marker out of the label it stores; the folded line shows that label's words.
  for (const choice of ['[Pagefind](x.html) (Recommended)', '[Recommended] [Pagefind](x.html)']) {
    for (const line of ['', '\nRecommended: Pagefind\n']) {
      const body = `:::question\nWhich search?\n\n- [ ] ${choice}\n- [ ] [Algolia](y.html)\n${line}:::`;
      const stored = parseInboxQuestionBlocks(body)[0]!.parsed.choices[0]!.label;
      expect(stored).toBe('[Pagefind](x.html)');
      expect(answerWords({ v: 1, key: 'q-1', kind: 'single', prompt: 'Which search?', selected: [stored] })).toBe('Pagefind');
    }
  }
});

test("a reply of skips or of answers and skips: the store's first line is dropped too", () => {
  expect(replyWords('Skipped 3 questions.\n\nRedo the design.')).toBe('Redo the design.');
  expect(replyWords('Answered 1 question, skipped 2.\n\nRedo the design.')).toBe('Redo the design.');
  expect(replyWords('Skipped 1 question.')).toBe('');
});

test("a reply that answered nothing: the store's still-open line and what follows it are dropped", () => {
  const line = "No questions answered yet; all 3 are still open. Don't re-ask them; the person will answer in the Inbox.";
  expect(replyWords(`Later today.\n\n${line}`).trim()).toBe('Later today.');
  expect(replyWords(`Later today.\n\n${line}\n\n# Feedback on the attached files\n\nTighten it.`).trim()).toBe('Later today.');
  expect(replyWords(line)).toBe('');
  expect(replyWords("Later.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.").trim()).toBe('Later.');
  expect(replyWords("Later.\n\nNo new answers in this reply; 2 questions are still open. Don't re-ask them; the person will answer in the Inbox.").trim()).toBe('Later.');
  // The person's own sentence that merely starts the same way is kept.
  expect(replyWords('No questions answered yet, sorry.')).toBe('No questions answered yet, sorry.');
});

test("a reply that answered some (approval inbox-explicit-skip): the line about the others is dropped with the answers", () => {
  const line = "You have 10 other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.";
  expect(replyWords(`Answered 1 question.\n\nShip it.\n\n${line}\n\n## Answers to your questions\n\n1 of 1 question answered.`).trim()).toBe('Ship it.');
  expect(replyWords(`Answered 1 question.\n\n${line}`).trim()).toBe('');
  expect(replyWords("Skipped 1 question.\n\nYou have 1 other question open in this thread. It stays open; the person will answer it in the Inbox. Don't re-ask it.").trim()).toBe('');
});

test('a reply of pasted files alone: the snippet names the files, never the still-open line the agent reads', () => {
  const line = "No question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.";
  const file = (name: string) => ({ id: `att_${name}`, name }) as NonNullable<InboxMessageWire['attachments']>[number];
  const reply = msg('m2', PERSON, 5, { body: line, attachments: [file('pasted-image-2026-10-16-0912.png'), file('notes.md')] });
  expect(foldSnippet(reply)).toEqual({ kind: 'words', text: 'pasted-image-2026-10-16-0912.png, notes.md' });
  // With words, the words.
  expect(foldSnippet({ ...reply, body: `See these.\n\n${line}` })).toEqual({ kind: 'words', text: 'See these.' });
});
