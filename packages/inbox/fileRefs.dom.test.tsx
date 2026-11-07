/**
 * Every file an agent's message names opens beside the thread (approval "inbox-file-refs-open-viewer"), drawn by
 * MessageBody: a link to a file it did not attach, a code span that is a path, and a bare path in the text, each a
 * real control a keyboard reaches. A file the message carries opens as that attachment. The person's own words keep
 * their links exactly as before.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachment, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { FileRef } from './fileRefs';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

const ROOT = '/work/app';
let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const PLAN: InboxAttachment = {
  id: 'att_plan',
  path: `${ROOT}/docs/plan.md`,
  named_path: null,
  name: 'plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: 10,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
};

function message(body: string, kind: 'agent' | 'person', attachments: InboxAttachment[] = []): InboxMessageWire {
  return {
    id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    thread_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author: kind === 'agent' ? { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' } : { kind: 'person' },
    body,
    attachments,
    questions: [],
  } as unknown as InboxMessageWire;
}

async function draw(body: string, kind: 'agent' | 'person', attachments: InboxAttachment[] = []) {
  const refs: FileRef[] = [];
  const opened: string[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message(body, kind, attachments)}
        projectRoot={ROOT}
        onOpenAttachment={(a) => opened.push(a.id)}
        onOpenFileRef={(ref) => refs.push(ref)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />,
    );
  });
  return { refs, opened };
}

const refEl = (path: string) => host!.querySelector<HTMLElement>(`[data-file-ref="${path}"]`);

test.skipIf(!hasDom)("in an agent's message every kind of reference opens the file, and a bare path is a control a keyboard reaches", async () => {
  const { refs } = await draw(
    'Read [the notes](docs/notes.md), the code at `src/retry/worker.ts:42`, the shot `shots/after.png`, the log /tmp/run/out.log and packages/inbox/file_refs.ts:6-13.',
    'agent',
  );
  host!.querySelector<HTMLAnchorElement>('a[data-local-link="open"]')!.click();
  for (const path of ['src/retry/worker.ts', 'shots/after.png']) await act(async () => refEl(path)!.click());
  // A bare path, whole even with an underscore, is a focusable button opened with Enter.
  const bare = refEl('packages/inbox/file_refs.ts')!;
  expect(bare.textContent).toBe('packages/inbox/file_refs.ts:6-13');
  expect([bare.getAttribute('role'), bare.tabIndex]).toEqual(['button', 0]);
  await act(async () => bare.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await act(async () => refEl('/tmp/run/out.log')!.click());
  expect(refs).toEqual([
    { path: 'docs/notes.md' },
    { path: 'src/retry/worker.ts', line: 42 },
    { path: 'shots/after.png' },
    { path: 'packages/inbox/file_refs.ts', line: 6, lineEnd: 13 },
    { path: '/tmp/run/out.log' },
  ]);
});

test.skipIf(!hasDom)('a file the message attached opens as that attachment, from a code span or a bare path', async () => {
  const { refs, opened } = await draw('The plan is `docs/plan.md`, also at docs/plan.md here.', 'agent', [PLAN]);
  for (const el of host!.querySelectorAll<HTMLElement>('[data-file-ref="docs/plan.md"]')) await act(async () => el.click());
  expect(opened).toEqual(['att_plan', 'att_plan']);
  expect(refs).toEqual([]);
});

test.skipIf(!hasDom)("the person's own words keep their links: nothing in them opens a file it names", async () => {
  const { refs } = await draw('Mine: [notes](docs/notes.md), `src/a.ts:3` and docs/plan.md.', 'person');
  expect(host!.querySelectorAll('[data-file-ref]').length).toBe(0);
  expect(host!.querySelector('[data-local-link="open"]')).toBeNull();
  expect(host!.textContent).toContain('docs/plan.md');
  expect(refs).toEqual([]);
});
