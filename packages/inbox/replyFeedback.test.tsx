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
import { splitReplyFeedback } from './replyFeedback';

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
