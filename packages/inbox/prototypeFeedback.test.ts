/**
 * Comments made in a question's prototype window ride the next Send filed
 * under the option the page shows (approval "inbox-question-tradeoffs"): a
 * running app's section and an attached HTML file's section are each headed
 * by the option's name, then the address or file. A page no option names
 * keeps its plain heading. Pure: the names come from the thread's messages
 * (prototypes.ts), the text from attachmentFeedback, as Send builds it.
 */
import { expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { attachmentFeedback } from './attachments';
import { prototypeNames, prototypePageCount, prototypeStart, questionPrototypePages, samePrototypePage } from './prototypes';

const ROOT = '/work/shop';
const APP_B = { id: 'liv_0123456789abcdef', url: 'http://localhost:4000/checkout?v=b' };

const FILE_A = {
  id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAA',
  message_id: 'msg_a',
  path: `${ROOT}/proto/a.html`,
  named_path: null,
  name: 'a.html',
  kind: 'html',
  sent_sha256: 'a'.repeat(64),
  size: 10,
  sent_at: '2026-11-09T10:00:00.000Z',
  sent_mtime: '2026-11-09T09:59:00.000Z',
  current: null,
  changed_since_sent: false,
  unavailable: null,
} as unknown as InboxAttachmentState;

const MESSAGE = {
  live_sites: [{ ...APP_B, opened_by: 'agent' as const, opened_at: '2026-11-09T10:00:00.000Z' }],
  attachments: [FILE_A],
  base_path: null,
  questions: [
    {
      kind: 'single',
      prompt: 'Which checkout ships?',
      choices: [
        { label: 'A · Classic', prototype: { target: 'proto/a.html' } },
        { label: 'B · Total first', prototype: { target: `${APP_B.url}#pay` } },
        { label: 'C · Statement' },
      ],
    },
  ],
};

function record(id: string, text: string, at: string, target: { live: true } | { file: InboxAttachmentState }): InboxAnnotationRecord {
  const live = 'live' in target;
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_a',
    message_id: 'msg_a',
    attachment_id: live ? '' : target.file.id,
    path: live ? APP_B.url : target.file.path,
    version: live ? 'current' : target.file.sent_sha256,
    ...(live ? { live: { site_id: APP_B.id, url: APP_B.url, page_url: '/checkout?v=b' } } : {}),
    annotation: { id, blockId: 'html-element', startOffset: 0, endOffset: 0, type: 'COMMENT', text, originalText: 'Pay', createdA: 1, htmlAnchor: { selector: '#pay' } },
    created_at: at,
    updated_at: at,
    removed_at: null,
    sent_reply_id: null,
  };
}

test("each option's page: an attached HTML file by its link, an app by its checked address (fragment aside); C has none", () => {
  const { pages, shared } = questionPrototypePages(MESSAGE.questions[0]!, MESSAGE, ROOT);
  expect(shared).toBe(false);
  expect(pages).toEqual([{ kind: 'file', attachmentId: FILE_A.id, name: 'a.html', start: '' }, { kind: 'app', siteId: APP_B.id, url: APP_B.url }, null]);
});

test("Send files a prototype's comments under the option's name, then its address or file; an unnamed page keeps its plain heading", () => {
  const records = [
    record('ann-app', 'Make Pay bigger.', '2026-11-09T10:01:00.000Z', { live: true }),
    record('ann-file', 'The total reads small.', '2026-11-09T10:02:00.000Z', { file: FILE_A }),
  ];
  const named = attachmentFeedback(records, [FILE_A], new Map(), ROOT, { prototypeNames: prototypeNames([MESSAGE], ROOT) });
  expect(named).toContain(`## Prototype of "B · Total first": ${APP_B.url}\n`);
  expect(named).toMatch(/## Prototype of "A · Classic": proto\/a\.html \(the version you sent\)\n/);
  expect(named).toContain('Make Pay bigger.');
  expect(named).toContain('The total reads small.');
  // Without names (an older window, a page no option names): the address and the file, as before.
  const plain = attachmentFeedback(records, [FILE_A], new Map(), ROOT);
  expect(plain).toContain(`## ${APP_B.url} (live site)\n`);
  expect(plain).not.toContain('Prototype of');
});

test("a question's shared page is named for the question", () => {
  const shared = { ...MESSAGE, questions: [{ kind: 'single', prompt: 'Which invoice?', prototype: { target: 'a.html' }, choices: [{ label: 'Lean' }, { label: 'Full' }] }] };
  expect(questionPrototypePages(shared.questions[0]!, shared, ROOT)).toEqual({ pages: [{ kind: 'file', attachmentId: FILE_A.id, name: 'a.html', start: '' }, { kind: 'file', attachmentId: FILE_A.id, name: 'a.html', start: '' }], shared: true });
  expect(prototypeNames([shared], ROOT).attachments.get(FILE_A.id)).toBe('Prototype for "Which invoice?"');
});

test('the tab counts pages: several options\' pages are plural, one shared page or one option\'s page is one, none is none', () => {
  expect(prototypePageCount(MESSAGE.questions[0]!, MESSAGE, ROOT)).toBe(2);
  const shared = { ...MESSAGE, questions: [{ kind: 'single', prompt: 'Which invoice?', prototype: { target: 'a.html' }, choices: [{ label: 'Lean' }, { label: 'Full' }] }] };
  expect(prototypePageCount(shared.questions[0]!, shared, ROOT)).toBe(1);
  const one = { ...MESSAGE, questions: [{ kind: 'single', prompt: 'Which?', choices: [{ label: 'A', prototype: { target: 'proto/a.html' } }, { label: 'B' }] }] };
  expect(prototypePageCount(one.questions[0]!, one, ROOT)).toBe(1);
  const none = { ...MESSAGE, questions: [{ kind: 'single', prompt: 'Which?', choices: [{ label: 'A' }, { label: 'B' }] }] };
  expect(prototypePageCount(none.questions[0]!, none, ROOT)).toBe(0);
});

// The owner, 2026-11-11: "why don't those URLs work". `Prototype: proto/a.html?variant=2` opens the page with that
// query, as a tab opens that address, so several options can show one file at different variants.
test("a file's query and fragment ride its page: options sharing one file at different queries are different pages", () => {
  const variants = {
    ...MESSAGE,
    questions: [
      {
        kind: 'single',
        prompt: 'Which variant?',
        choices: [
          { label: '1 · Names', prototype: { target: 'proto/a.html?variant=1' } },
          { label: '2 · Faces', prototype: { target: 'proto/a.html?variant=2#top' } },
          { label: '3 · Plain', prototype: { target: 'proto/a.html' } },
        ],
      },
    ],
  };
  const { pages, shared } = questionPrototypePages(variants.questions[0]!, variants, ROOT);
  expect(shared).toBe(false);
  expect(pages.map((page) => page?.kind === 'file' && [page.attachmentId, page.start])).toEqual([
    [FILE_A.id, '?variant=1'],
    [FILE_A.id, '?variant=2#top'],
    [FILE_A.id, ''],
  ]);
  expect(samePrototypePage(pages[0]!, pages[1]!)).toBe(false);
  expect(samePrototypePage(pages[0]!, { kind: 'file', attachmentId: FILE_A.id, name: 'a.html', start: '?variant=1' })).toBe(true);
  // Three options' pages: the tab is plural.
  expect(prototypePageCount(variants.questions[0]!, variants, ROOT)).toBe(3);
  // Their comments are the file's, not one option's: the question names them.
  expect(prototypeNames([variants], ROOT).attachments.get(FILE_A.id)).toBe('Prototype for "Which variant?"');
});

test('prototypeStart: the query and fragment as written; an empty ? or # is none', () => {
  expect(prototypeStart('proto/a.html?variant=2')).toBe('?variant=2');
  expect(prototypeStart('a.html#step-2')).toBe('#step-2');
  expect(prototypeStart(' a.html?v=1&n=3#top ')).toBe('?v=1&n=3#top');
  expect(prototypeStart('a.html?')).toBe('');
  expect(prototypeStart('a.html#')).toBe('');
  expect(prototypeStart('a.html')).toBe('');
});
