/**
 * Thread files: a file an agent attaches again in later messages is one
 * artifact (the newest record, at its message; opening an earlier record opens
 * it, and stepping counts it once), and a link in a later message to a file an
 * earlier message attached opens its newest version instead of reading "Not attached".
 *
 * The MessageBody test is DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachment, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { artifactKey, artifactOfFile, threadArtifacts } from './artifacts';
import { stepIndexOf, stepsOf } from './stepping';
import { newestAttachmentForLink } from './links';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

const ROOT = '/work/shop';
const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';
const M3 = 'msg_01K7M3MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, messageId: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `${ROOT}/${name}`,
    kind: name.endsWith('.png') ? 'image' : 'markdown',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  } as InboxAttachmentState;
}

function agent(id: string, createdAt: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return { id, thread_id: M1, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' }, body: '', questions: [], ...extra } as unknown as InboxMessageWire;
}

const messages = [agent(M1, '2026-10-10T09:12:00.000Z'), agent(M2, '2026-10-10T11:30:00.000Z'), agent(M3, '2026-10-10T13:52:00.000Z')];

test('a file attached again by later messages is one artifact: the newest record, at its message', () => {
  const v1 = file('att_01K7V1VVVVVVVVVVVVVVVVVVVV', 'plan.md', M1, { sent_at: '2026-10-10T09:12:00.000Z' });
  const v2 = file('att_01K7V2VVVVVVVVVVVVVVVVVVVV', 'plan.md', M2, { sent_at: '2026-10-10T11:30:00.000Z' });
  const v3 = file('att_01K7V3VVVVVVVVVVVVVVVVVVVV', 'plan.md', M3, { sent_at: '2026-10-10T13:52:00.000Z' });
  const spec = file('att_01K7SPECSPECSPECSPECSPECSP', 'spec.md', M1);
  const other = file('att_01K7OTHEROTHEROTHEROTHEROT', 'plan.md', M3, { path: `${ROOT}/docs/plan.md` });
  const list = threadArtifacts(messages, [v2, v1, spec, v3, other]);
  expect(list.map(artifactKey)).toEqual([spec.id, v3.id, other.id]);
  expect(artifactOfFile(list, v1.id)?.attachment.id).toBe(v3.id);
  expect(artifactOfFile(list, v2.id)?.attachment.id).toBe(v3.id);
  expect(artifactOfFile(list, other.id)?.attachment.id).toBe(other.id);
  const steps = stepsOf(list);
  expect(steps).toHaveLength(3);
  expect(stepIndexOf(steps, v1.id)).toBe(stepIndexOf(steps, v3.id));
});

test('an image shown in the text and attached stays one artifact per message', () => {
  const inline = file('att_01K7INLINEINLINEINLINEINLI', 'shot.png', M1, { ref: 'shot.png' });
  const attached = file('att_01K7ATTACHATTACHATTACHATTA', 'shot.png', M1);
  expect(threadArtifacts(messages, [attached], [inline]).map(artifactKey)).toEqual([inline.id]);
});

test("a link resolves across the thread's messages, the newest version of a file first", () => {
  const first = file('att_v1', 'docs/plan.md', M1, { name: 'plan.md', sent_at: '2026-10-10T10:00:00.000Z' });
  const again = file('att_v2', 'docs/plan.md', M2, { name: 'plan.md', sent_at: '2026-10-10T12:00:00.000Z' });
  const mock = file('att_mock', 'design/mock.html', M1, { name: 'mock.html', kind: 'html' });
  const options = { attachments: [again, first, mock], root: ROOT, base: `${ROOT}/docs` };
  expect(newestAttachmentForLink('plan.md', options)?.id).toBe('att_v2');
  expect(newestAttachmentForLink('../design/mock.html', options)?.id).toBe('att_mock');
  expect(newestAttachmentForLink('notes.md', options)).toBeNull();
  // A bare name two folders attached: the newest of them.
  const elsewhere = file('att_b', 'b/plan.md', M3, { name: 'plan.md', sent_at: '2026-10-10T13:00:00.000Z' });
  expect(newestAttachmentForLink('plan.md', { attachments: [first, elsewhere], root: ROOT })?.id).toBe('att_b');
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)('a link to a file an earlier message attached opens its newest version, never "Not attached"', async () => {
  const opened: string[] = [];
  const first = file('att_v1', 'design/mock.html', M1, { name: 'mock.html', kind: 'html', sent_at: '2026-10-10T09:00:00.000Z' }) as InboxAttachment;
  const again = file('att_v2', 'design/mock.html', M2, { name: 'mock.html', kind: 'html', sent_at: '2026-10-10T11:00:00.000Z' }) as InboxAttachment;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={agent(M3, '2026-10-10T13:00:00.000Z', { body: 'Updated: see [the mock](design/mock.html) and [notes](notes.md).', attachments: [] })}
        threadAttachments={[first, again]}
        projectRoot={ROOT}
        onOpenAttachment={(a) => opened.push(a.id)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />,
    );
  });
  const mock = host!.querySelector<HTMLAnchorElement>('a[data-local-link="open"]');
  expect(mock?.getAttribute('href')).toBe(`#thread=${M1}&file=att_v2`);
  await act(async () => mock!.click());
  expect(opened).toEqual(['att_v2']);
  expect(host!.querySelector('[data-local-link="unavailable"]')).not.toBeNull();
});
