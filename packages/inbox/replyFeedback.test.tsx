/**
 * The feedback a Send wrote after the person's words is drawn as its own
 * block (replyFeedback.ts), the hook inbox.css sizes its headings by. The
 * feedback is built by the real export (`attachmentFeedback`), so a change to
 * its section headings that the split no longer finds fails here; an agent's
 * message with the same headings never gets the block, so its headings keep
 * their size. The sizes themselves are proved in a real browser
 * (tests/e2e/inbox-reply-feedback-size.spec.ts).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentFeedback, imageCommentAnnotation, LIVE_SITE_FEEDBACK_HEADING, liveSiteFeedback, messageFeedback, OWN_MESSAGE_FEEDBACK } from './attachments';
import { splitReplyFeedback, withoutElementDetails } from './replyFeedback';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

const ROOT = '/work/shop';
const AGENT_MSG = 'msg_01K7AGENT00000000000000000';
const REPLY = 'msg_01K7REPLY00000000000000000';
const SHA = 'a'.repeat(64);

const IMAGE = {
  id: 'att_image',
  path: `${ROOT}/design/checkout.png`,
  named_path: null,
  name: 'checkout.png',
  kind: 'image',
  sent_sha256: SHA,
  size: 10,
  sent_at: '2026-10-29T18:00:00.000Z',
  sent_mtime: '2026-10-29T18:00:00.000Z',
  message_id: AGENT_MSG,
  current: { sha256: SHA, size: 10, mtime: '2026-10-29T18:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
} as InboxAttachmentState;

function RECORDS_BASE() {
  return { project_id: 'prj_1', thread_id: AGENT_MSG, message_id: AGENT_MSG, version: 'current', created_at: '2026-10-29T18:10:00.000Z', updated_at: '2026-10-29T18:10:00.000Z', removed_at: null, sent_reply_id: null };
}

const RECORDS: InboxAnnotationRecord[] = [
  {
    id: 'a1',
    project_id: 'prj_1',
    thread_id: AGENT_MSG,
    message_id: AGENT_MSG,
    attachment_id: IMAGE.id,
    path: IMAGE.path,
    version: 'current',
    annotation: imageCommentAnnotation({ id: 'a1', name: 'checkout.png', text: 'More weight on the total.' }) as unknown as Record<string, unknown>,
    created_at: '2026-10-29T18:10:00.000Z',
    updated_at: '2026-10-29T18:10:00.000Z',
    removed_at: null,
    sent_reply_id: null,
  } as InboxAnnotationRecord,
];
const PEOPLE = new Set([REPLY]);

// A pin on an HTML page: the export writes the element's outline and details after the comment, for the agent.
const PAGE = { ...IMAGE, id: 'att_page', path: `${ROOT}/ui/canary.html`, name: 'canary.html', kind: 'html' } as InboxAttachmentState;
const PIN: InboxAnnotationRecord = {
  ...RECORDS_BASE(),
  id: 'p1',
  attachment_id: PAGE.id,
  path: PAGE.path,
  annotation: {
    id: 'p1', blockId: 'html', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'Make the amber band explicit.', originalText: '412 ms', createdA: 0,
    htmlAnchor: { selector: 'div.big.warn' },
    elementContext: { tag: 'div', outline: '<div class="big warn">412 ms</div>', path: 'body > main > div.big', name: '412 ms', text: '412 ms', rect: { x: 32, y: 388, w: 329, h: 38, vw: 393, vh: 776 }, landmark: 'section.card', heading: 'h2 "p99 latency"' },
  },
} as unknown as InboxAnnotationRecord;
const pinFeedback = () => attachmentFeedback([PIN], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
const feedback = () => attachmentFeedback(RECORDS, [IMAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
// A pin on an element of a message's live html block.
const BLOCK_PIN = () => ({
  ...RECORDS_BASE(),
  id: 'b1',
  attachment_id: '',
  path: AGENT_MSG,
  message: { at: '2026-10-29T18:00:00.000Z' },
  annotation: {
    id: 'b1', blockId: 'block-1', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'Label this.', originalText: '[element: Pro, W3]', createdA: 0,
    htmlBlockAnchor: { v: 1, index: 1, id: '0123456789abcdef0123456789abcdef', sourceLine: [3, 9] },
    htmlAnchor: { selector: 'rect[aria-label="Pro, W3"]', tagName: 'rect' },
    elementContext: { tag: 'rect', outline: '<rect aria-label="Pro, W3"></rect>', path: 'body > svg > rect' },
  },
});

test("the split finds the export's section after the person's words, never one in a code block", () => {
  const text = feedback();
  expect(splitReplyFeedback(`Notes below.\n\n${text}`)).toEqual({ words: 'Notes below.', feedback: text });
  // Feedback alone: no words.
  expect(splitReplyFeedback(text)?.words).toBe('');
  // The heading quoted in a fence is the person's own words.
  const fenced = 'Like this:\n\n```md\n# Feedback on the attached files\n```';
  expect(splitReplyFeedback(fenced)).toBeNull();
  expect(splitReplyFeedback(`${fenced}\n\n${text}`)?.words).toBe(fenced);
  // A heading glued to a paragraph line is not the export's.
  expect(splitReplyFeedback('Notes.\n# Feedback on the attached files')).toBeNull();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function draw(body: string, author: InboxMessageWire['author']): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const message = { id: REPLY, thread_id: AGENT_MSG, project_id: 'prj_1', author, body, created_at: '2026-10-29T18:20:00.000Z', attachments: [], questions: [] } as unknown as InboxMessageWire;
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message}
        projectRoot={ROOT}
        onOpenAttachment={() => {}}
        readOnly
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        replyFiles={{ files: [IMAGE], personMessageIds: PEOPLE, onOpen: () => {} }}
      />,
    );
  });
  return host;
}

test.skipIf(!hasDom)("the person's reply draws its feedback as its own block; the file heading still links", async () => {
  const el = await draw(`Notes below.\n\n${feedback()}`, { kind: 'person' } as InboxMessageWire['author']);
  const block = el.querySelector('[data-reply-feedback]')!;
  expect(block.querySelector('h1')?.textContent).toBe('Feedback on the attached files');
  expect(block.querySelector('h2 a[data-local-link="open"]')?.textContent).toBe('design/checkout.png');
  // The person's words stay outside it.
  expect(block.textContent).not.toContain('Notes below.');
  expect(el.textContent).toContain('Notes below.');
});

test.skipIf(!hasDom)("an agent's message with the same headings has no feedback block", async () => {
  const el = await draw(`Notes below.\n\n${feedback()}`, { kind: 'agent', session: 'ses_1', host: 'claude-code', name: 'Claude Code' } as unknown as InboxMessageWire['author']);
  expect(el.querySelector('[data-reply-feedback]')).toBeNull();
  expect(el.querySelector('h1')?.textContent).toBe('Feedback on the attached files');
});

test("a pin on an HTML page: the person's reply is drawn without the element's outline and selector lines; the stored text keeps them", () => {
  const stored = `One change on the p99 card.\n\n${pinFeedback()}`;
  // The export still writes them (what the agent reads).
  expect(stored).toContain('````html');
  expect(stored).toContain('- **selector** `div.big.warn`');
  expect(stored).toContain('- **box** 32,388');
  const shown = withoutElementDetails(stored);
  expect(shown).not.toContain('````html');
  for (const detail of ['selector', 'path', 'name', 'text', 'box', 'near']) expect(shown).not.toContain(`- **${detail}** `);
  // The person's words, the file, the comment's heading and its words stay.
  expect(shown).toContain('One change on the p99 card.');
  expect(shown).toContain('## ui/canary.html');
  expect(shown).toContain('### 1. Feedback on: "412 ms"');
  expect(shown).toContain('> Make the amber band explicit.');
  // Nothing to take: the same text back.
  const plain = `Notes.\n\n${feedback()}`;
  expect(withoutElementDetails(plain)).toBe(plain);
});

test("a pin on an element of a message's live html block: the reply is drawn without the outline (it would draw as a live page) and the selector lines", () => {
  const stored = [
    'One note on the chart.',
    '',
    '# Feedback on your messages',
    '',
    'The following feedback is on the text of your messages in this thread, one section per message.',
    '',
    '## Feedback on your message from 2:58 PM (msg_A)',
    '',
    "I've reviewed this message and have 1 piece of feedback:",
    '',
    '### 1. Feedback on: "Pro, W3"',
    'HTML block 1 in the message, lines 3–40',
    '',
    '````html',
    '<rect id="pro-w3" aria-label="Pro, W3"></rect>',
    '````',
    '- **selector** `#pro-w3`',
    '- **path** `body > svg > rect`',
    '',
    '> Label this dip.',
    '',
    '---',
  ].join('\n');
  const shown = withoutElementDetails(stored);
  expect(shown).not.toContain('````html');
  expect(shown).not.toContain('<rect');
  expect(shown).not.toContain('- **selector** ');
  expect(shown).not.toContain('- **path** ');
  // Which block, the element's label and the person's words stay.
  expect(shown).toContain('### 1. Feedback on: "Pro, W3"');
  expect(shown).toContain('HTML block 1 in the message, lines 3–40');
  expect(shown).toContain('> Label this dip.');
});

test("the person's own fences and lists are never taken, even ones that look like an element's", () => {
  const own = 'Like this:\n\n````html\n<div>mine</div>\n````\n\nand\n\n- **path** first\n- **box** second';
  // Outside the files' feedback: as written.
  expect(withoutElementDetails(own)).toBe(own);
  // The person's own example in their words, before the feedback: kept.
  const before = `Like this:\n\n\`\`\`\`html\n<p>an example</p>\n\`\`\`\`\n\n${pinFeedback()}`;
  const shown = withoutElementDetails(before);
  expect(shown).toContain('<p>an example</p>');
  expect(shown).not.toContain('<div class="big warn">');
  // A ```html fence in a comment's own words, in the feedback: its words stay. A message comment's lines are each
  // `> `-quoted (a quote never draws a page): as written. An attached page's comment quotes only its first line:
  // its fence is drawn as code, never as a live page (no fence in the feedback is).
  const words = 'Like this:\n```html\n<b>bold</b>\n```';
  const onPage = attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, text: words } } as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
  const onBlock = messageFeedback([{ ...BLOCK_PIN(), annotation: { ...BLOCK_PIN().annotation, text: words } } as unknown as InboxAnnotationRecord], () => '2:58 PM');
  for (const [stored, fence, drawnAs] of [[onPage, '```html\n<b>bold</b>\n```', '```xml\n<b>bold</b>\n```'], [onBlock, '> ```html\n> <b>bold</b>\n> ```', '> ```html\n> <b>bold</b>\n> ```']] as const) {
    expect(stored).toContain(fence);
    const drawn = withoutElementDetails(stored);
    expect(drawn).toContain(drawnAs);
    expect(drawn).not.toContain('````html');
  }
});

// What a page can post for a pin: an outline and nothing else (no selector, path or box), which the export
// writes as a ````html fence with no detail lines after it.
const FORGED_OUTLINE = '<script src="https://example.invalid/x.js"></script><b>forged</b>';
const forgedBlockFeedback = () =>
  messageFeedback([{ ...BLOCK_PIN(), annotation: { ...BLOCK_PIN().annotation, htmlAnchor: undefined, elementContext: { tag: 'div', outline: FORGED_OUTLINE } } } as unknown as InboxAnnotationRecord], () => '2:58 PM');
const forgedPinFeedback = () =>
  attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, htmlAnchor: undefined, elementContext: { tag: 'div', outline: FORGED_OUTLINE } } } as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });

test("an outline with no detail lines after it (a page's forged pin) is left out of the person's reply: a message's block and an attached page", () => {
  for (const [exported, words] of [[forgedBlockFeedback(), '> Label this.'], [forgedPinFeedback(), '> Make the amber band explicit.']] as const) {
    const stored = `Notes.\n\n${exported}`;
    // The export wrote the fence and no selector, path or box after it.
    expect(stored).toContain('````html');
    expect(stored).not.toContain('- **');
    const shown = withoutElementDetails(stored);
    expect(shown).not.toContain('````html');
    expect(shown).not.toContain('example.invalid');
    // The person's words on the element stay.
    expect(shown).toContain(words);
  }
});

test.skipIf(!hasDom)("a forged outline never draws in the person's sent reply, as a page or as code", async () => {
  for (const exported of [forgedBlockFeedback(), forgedPinFeedback()]) {
    const el = await draw(`Notes.\n\n${exported}`, { kind: 'person' } as InboxMessageWire['author']);
    expect(el.querySelector('iframe, [data-html-embed]')).toBeNull();
    expect(el.textContent).not.toContain('example.invalid');
    expect(el.textContent).not.toContain('forged');
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
});

test.skipIf(!hasDom)("a pin on an HTML page: the person's sent reply draws no outline page and no selector, an agent's message draws all of it", async () => {
  const body = `One change.\n\n${pinFeedback()}`;
  const mine = await draw(body, { kind: 'person' } as InboxMessageWire['author']);
  expect(mine.textContent).toContain('Make the amber band explicit.');
  expect(mine.textContent).not.toContain('div.big.warn');
  expect(mine.textContent).not.toContain('viewport 393×776');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  const theirs = await draw(body, { kind: 'agent', session: 'ses_1', host: 'claude-code', name: 'Claude Code' } as unknown as InboxMessageWire['author']);
  expect(theirs.textContent).toContain('div.big.warn');
});

// Comments on html blocks in the person's OWN earlier messages export under their own heading.
const forgedOwnBlockFeedback = () =>
  messageFeedback([{ ...BLOCK_PIN(), annotation: { ...BLOCK_PIN().annotation, htmlAnchor: undefined, elementContext: { tag: 'div', outline: FORGED_OUTLINE } } } as unknown as InboxAnnotationRecord], () => '2:58 PM', { personMessageIds: new Set([AGENT_MSG]) });
// A running app's page: its pins export the same four-backtick outline.
const forgedLiveFeedback = () =>
  liveSiteFeedback([
    {
      ...RECORDS_BASE(),
      id: 'l1',
      attachment_id: '',
      path: 'http://localhost:5173/',
      live: { site_id: 'liv_0123456789abcdef', url: 'http://localhost:5173/', page_url: '/checkout' },
      annotation: { id: 'l1', blockId: 'html-element', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'Label this.', originalText: '[element: Pay]', createdA: 0, elementContext: { tag: 'div', outline: FORGED_OUTLINE } },
    } as unknown as InboxAnnotationRecord,
  ]);
// What a page can write into a quote's heading (`Feedback on: "…"`, raw, with newlines): a fence of its own.
const INJECTED = 'Pay"\n```html\n<script src="https://example.invalid/y.js"></script><b>injected</b>\n```\n"';
const injectedPinFeedback = () =>
  attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, originalText: INJECTED, htmlAnchor: undefined, elementContext: undefined } } as unknown as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });

const unmountDrawn = () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
};

test("the person's own earlier message and a running app's page: an outline alone is left out too", () => {
  for (const exported of [forgedOwnBlockFeedback(), forgedLiveFeedback()]) {
    const stored = `Notes.\n\n${exported}`;
    expect(stored).toContain('````html');
    const shown = withoutElementDetails(stored);
    expect(shown).not.toContain('````html');
    expect(shown).not.toContain('example.invalid');
    expect(shown).toContain('> Label this.');
  }
  expect(forgedOwnBlockFeedback()).toContain(`# ${OWN_MESSAGE_FEEDBACK.title}`);
  expect(forgedLiveFeedback()).toContain(`# ${LIVE_SITE_FEEDBACK_HEADING.title}`);
});

test('a fence a page wrote into a quote\'s heading is drawn as code, never as a page; the stored text keeps it', () => {
  const stored = `Notes.\n\n${injectedPinFeedback()}`;
  expect(stored).toMatch(/^```html$/m);
  const shown = withoutElementDetails(stored);
  expect(shown).not.toMatch(/^\s*`{3,}\s*html/im);
  expect(shown).toMatch(/^```xml$/m);
  expect(shown).toContain('<b>injected</b>');
});

test("lines the person typed cannot switch the feedback off: a '# ' line or a lone fence before an outline", () => {
  const typed = (text: string) => ({ ...PIN, id: 'p0', annotation: { ...PIN.annotation, id: 'p0', text } }) as InboxAnnotationRecord;
  const forged = { ...PIN, id: 'p9', annotation: { ...PIN.annotation, id: 'p9', startOffset: 5, endOffset: 5, htmlAnchor: undefined, elementContext: { tag: 'div', outline: FORGED_OUTLINE } } } as unknown as InboxAnnotationRecord;
  for (const text of ['First line\n# Not a heading\nmore', 'Look:\n```']) {
    const stored = `Notes.\n\n${attachmentFeedback([typed(text), forged], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE })}`;
    expect(stored).toContain('````html');
    const shown = withoutElementDetails(stored);
    expect(shown).not.toContain('````html');
    expect(shown).not.toContain('example.invalid');
  }
});

test.skipIf(!hasDom)("drawn: no live page anywhere in the person's feedback (own messages, a running app, a page's fence in a heading); their own html above it stays live", async () => {
  for (const exported of [forgedOwnBlockFeedback(), forgedLiveFeedback(), injectedPinFeedback()]) {
    const el = await draw(`Notes.\n\n${exported}`, { kind: 'person' } as InboxMessageWire['author']);
    expect(el.querySelector('iframe, [data-html-embed]')).toBeNull();
    expect(el.textContent).not.toContain('forged');
    unmountDrawn();
  }
  // The page's own fence in a heading: there, as code.
  const shownCode = await draw(`Notes.\n\n${injectedPinFeedback()}`, { kind: 'person' } as InboxMessageWire['author']);
  expect(shownCode.querySelector('iframe, [data-html-embed]')).toBeNull();
  expect(Array.from(shownCode.querySelectorAll('pre, code')).some((code) => code.textContent?.includes('<b>injected</b>'))).toBe(true);
  unmountDrawn();
  // The person's own ```html in their words, above the feedback: a live block, as in any message.
  const own = await draw(`Here is the page:\n\n\`\`\`html\n<p>mine</p>\n\`\`\`\n\n${injectedPinFeedback()}`, { kind: 'person' } as InboxMessageWire['author']);
  expect(own.querySelectorAll('[data-html-embed]').length).toBe(1);
});

// The window's parser reads fences its own way (`parser.ts`, `codeFenceCloseIndex`): backticks only, and any line
// starting with as many backticks closes one. Words the person typed above the feedback can never hide it.
const liveCount = (el: HTMLElement) => el.querySelectorAll('iframe, [data-html-embed]').length;
const anyLiveFence = /^\s*`{3,}\s*(?:html|svg)(?:\s|$)/im;
// A page's quote that closes an open ``` and opens its own ```html (`Feedback on: "…"` is the page's raw text).
const CLOSE_THEN_OPEN = 'Pay"\n```\n```html\n<script src="https://example.invalid/z.js"></script><b>injected</b>\n```\n"';
const closeThenOpenFeedback = () =>
  attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, originalText: CLOSE_THEN_OPEN, htmlAnchor: undefined, elementContext: undefined } } as unknown as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
// A forged outline and a page's ```html in a quote's heading, on one page.
const forgedAndInjected = () =>
  attachmentFeedback(
    [
      { ...PIN, annotation: { ...PIN.annotation, htmlAnchor: undefined, elementContext: { tag: 'div', outline: FORGED_OUTLINE } } } as InboxAnnotationRecord,
      { ...PIN, id: 'p2', annotation: { ...PIN.annotation, id: 'p2', startOffset: 3, endOffset: 3, originalText: INJECTED, htmlAnchor: undefined, elementContext: undefined } } as unknown as InboxAnnotationRecord,
    ],
    [PAGE],
    new Map(),
    ROOT,
    { personMessageIds: PEOPLE },
  );
const TILDE_WORDS = 'Two things.\n\n~~~\n\nThe second one.';
const UNCLOSED_WORDS = 'Like this:\n\n```\nnpm run build';

test("the split reads fences as the window does: '~~~' is text, a fence closes on any line of as many backticks", () => {
  const text = feedback();
  expect(splitReplyFeedback(`${TILDE_WORDS}\n\n${text}`)).toEqual({ words: TILDE_WORDS, feedback: text });
  const closedWithInfo = 'Example:\n\n```js\nlet a;\n```js';
  expect(splitReplyFeedback(`${closedWithInfo}\n\n${text}`)?.words).toBe(closedWithInfo);
});

test("a lone '~~~' or an unclosed ``` in the person's words never switches the feedback's protection off", () => {
  for (const [words, exported] of [
    [TILDE_WORDS, forgedAndInjected()],
    [TILDE_WORDS, forgedLiveFeedback()],
    [UNCLOSED_WORDS, closeThenOpenFeedback()],
    [UNCLOSED_WORDS, forgedLiveFeedback()],
  ] as const) {
    const stored = `${words}\n\n${exported}`;
    expect(stored).toMatch(anyLiveFence);
    const shown = withoutElementDetails(stored);
    expect(shown).not.toMatch(anyLiveFence);
    expect(shown).not.toContain('````html');
    expect(shown).not.toContain(FORGED_OUTLINE);
    // The person's words stay as written.
    expect(shown.startsWith(`${words}\n\n`)).toBe(true);
  }
});

test.skipIf(!hasDom)("drawn: a lone '~~~' or an unclosed ``` above the feedback, and nothing in it is live", async () => {
  for (const body of [
    `${TILDE_WORDS}\n\n${forgedAndInjected()}`,
    `${TILDE_WORDS}\n\n${forgedLiveFeedback()}`,
    `${UNCLOSED_WORDS}\n\n${closeThenOpenFeedback()}`,
    `${UNCLOSED_WORDS}\n\n${forgedLiveFeedback()}`,
  ]) {
    const el = await draw(body, { kind: 'person' } as InboxMessageWire['author']);
    expect(liveCount(el)).toBe(0);
    expect(el.textContent?.includes('forged')).toBe(false);
    unmountDrawn();
  }
  // The person's own ```html above, then a '~~~': still live, and only it.
  const own = await draw(`Here is the page:\n\n\`\`\`html\n<p>mine</p>\n\`\`\`\n\n~~~\n\n${forgedAndInjected()}`, { kind: 'person' } as InboxMessageWire['author']);
  expect(own.querySelectorAll('[data-html-embed]').length).toBe(1);
});

test("the person's own ```html that the window would keep open into the feedback is drawn as code; a closed one stays", () => {
  const stored = `Look:\n\n\`\`\`html\n<p>mine\n\n${closeThenOpenFeedback()}`;
  const shown = withoutElementDetails(stored);
  expect(shown).not.toMatch(anyLiveFence);
  expect(shown.startsWith('Look:\n\n```xml\n<p>mine\n')).toBe(true);
  const closed = `Look:\n\n\`\`\`html\n<p>mine</p>\n\`\`\`\n\n${closeThenOpenFeedback()}`;
  expect(withoutElementDetails(closed).startsWith('Look:\n\n```html\n<p>mine</p>\n```\n')).toBe(true);
});

test.skipIf(!hasDom)("a normal reply: words, then feedback with a file link and the person's line breaks, drawn as before", async () => {
  const words = 'Two notes.\n\nSecond paragraph.';
  const exported = attachmentFeedback([{ ...RECORDS[0]!, annotation: imageCommentAnnotation({ id: 'a1', name: 'checkout.png', text: 'First line\nsecond line\n\nthird' }) as unknown as Record<string, unknown> } as InboxAnnotationRecord], [IMAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
  const body = `${words}\n\n${exported}`;
  // Nothing to change: the same text, split at the same place.
  expect(withoutElementDetails(body)).toBe(body);
  expect(splitReplyFeedback(body)).toEqual({ words, feedback: exported });
  const el = await draw(body, { kind: 'person' } as InboxMessageWire['author']);
  const block = el.querySelector('[data-reply-feedback]')!;
  expect(block.querySelector('h2 a[data-local-link="open"]')?.textContent).toBe('design/checkout.png');
  expect(block.textContent?.includes('second line')).toBe(true);
  expect(block.textContent?.includes('third')).toBe(true);
  expect(block.textContent?.includes('Second paragraph.')).toBe(false);
});

test("diagram fences: in the feedback they are drawn as their source; above it, the person's still draw", () => {
  const ownDiagram = '```mermaid\ngraph LR\n  X-->Y\n```';
  const text = 'See:\n```mermaid\ngraph TD\n  A-->B\n```\n```dot\ndigraph { a -> b }\n```';
  const exported = attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, text } } as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
  expect(exported).toContain('```mermaid\ngraph TD');
  const shown = withoutElementDetails(`Mine:\n\n${ownDiagram}\n\n${exported}`);
  expect(shown).toContain(`Mine:\n\n${ownDiagram}\n\n`);
  expect(shown).toContain('```text\ngraph TD');
  expect(shown).toContain('```text\ndigraph { a -> b }');
  expect(shown.match(/^```(?:mermaid|dot)/gm)?.length).toBe(1);
});

test.skipIf(!hasDom)('drawn: a diagram in the feedback is code, the one above it a diagram', async () => {
  const text = 'See:\n```mermaid\ngraph TD\n  A-->B\n```\n```dot\ndigraph { a -> b }\n```';
  const exported = attachmentFeedback([{ ...PIN, annotation: { ...PIN.annotation, text } } as InboxAnnotationRecord], [PAGE], new Map(), ROOT, { personMessageIds: PEOPLE });
  const el = await draw(`Mine:\n\n\`\`\`mermaid\ngraph LR\n  X-->Y\n\`\`\`\n\n${exported}`, { kind: 'person' } as InboxMessageWire['author']);
  expect(el.querySelectorAll('[data-diagram-block]').length).toBe(1);
  expect(el.querySelectorAll('[data-reply-feedback] [data-diagram-block]').length).toBe(0);
  expect(Array.from(el.querySelectorAll('[data-reply-feedback] pre, [data-reply-feedback] code')).some((code) => code.textContent?.includes('digraph'))).toBe(true);
});
