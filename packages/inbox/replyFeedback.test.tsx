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
import { attachmentFeedback, imageCommentAnnotation } from './attachments';
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

test("the person's own fences and lists are never taken, even ones that look like an element's", () => {
  const own = 'Like this:\n\n````html\n<div>mine</div>\n````\n\nand\n\n- **path** first\n- **box** second';
  // Outside the files' feedback: as written.
  expect(withoutElementDetails(own)).toBe(own);
  // A fenced example inside a comment, with no details after it: kept.
  const fenced = `${pinFeedback()}\n\n\`\`\`\`html\n<p>an example</p>\n\`\`\`\`\n\nThanks.`;
  const shown = withoutElementDetails(fenced);
  expect(shown).toContain('<p>an example</p>');
  expect(shown).not.toContain('<div class="big warn">');
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
