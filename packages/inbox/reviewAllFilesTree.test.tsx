import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';

const hasDom = typeof document !== 'undefined';
let reader: { mode?: string; reveal?: { path: string } | null } = {};
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { mode?: string; reveal?: { path: string } | null }) => {
      reader = { mode: props.mode, reveal: props.reveal };
      return null;
    },
  }));
}
const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E72DPY';

const file = (path: string, added: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n+new\n+${added}\n`;
const PATCH = [file('src/auth/guard.ts', 'a'), file('src/auth/token.ts', 'b'), file('docs/notes.md', 'c')].join('');

const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Token refresh',
    intent: 'Refresh tokens before they expire.',
    sections: [{ title: 'The guard', overview: 'Where the refresh happens.', diffs: [{ file: 'src/auth/guard.ts', summary: 'Adds the refresh guard.' }] }],
  },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const messageOf = (review: boolean): InboxMessageWire =>
  ({
    id: REVIEW,
    project_id: PROJECT.id,
    thread_id: REVIEW,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
    subject: 'Token refresh',
    body: 'I wrote a review.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 3, additions: 6, deletions: 3, review, chapters: ['The guard'] },
  }) as InboxMessageWire;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedMatchMedia: typeof window.matchMedia;
let viewedPosts: string[][] = [];

beforeEach(() => {
  if (!hasDom) return;
  reader = {};
  viewedPosts = [];
  window.localStorage.clear();
  savedFetch = globalThis.fetch;
  savedMatchMedia = window.matchMedia;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      if (path.endsWith('/guide/viewed')) {
        const { viewed } = JSON.parse(String(init.body)) as { viewed: string[] };
        viewedPosts.push(viewed);
        return Response.json({ message_id: REVIEW, viewed });
      }
      return Response.json({});
    }
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: messageOf(true).guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatchMedia;
});

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render({ review = true }: { review?: boolean } = {}) {
  const message = messageOf(review);
  const thread: InboxThread = { thread_id: REVIEW, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={thread} message={message} codeReview onBack={() => {}} onClose={() => {}} onSent={() => {}} onWriteReply={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />
      </div>,
    );
  });
  await settle();
}

async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const allFiles = () => click(document.querySelector('[data-review-mode-choice="files"] input'));
const tree = () => document.querySelector<HTMLElement>('[data-review-message] [data-review-tree]');
const treeFile = (path: string) => tree()?.querySelector<HTMLElement>(`[data-review-file="${path}"]`) ?? null;

function asPhone() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

test.skipIf(!hasDom)('Walkthrough has no file list; All files has the tree on the left with every changed file, its folders and counts', async () => {
  await render();
  expect(reader.mode).toBe('walkthrough');
  expect(tree() !== null).toBe(false);
  expect(document.querySelector('[data-review-message] [data-review-files]') !== null).toBe(false);

  await allFiles();
  expect(reader.mode).toBe('files');
  const rail = tree();
  expect(rail !== null).toBe(true);
  expect(rail!.parentElement?.classList.contains('ib-rsplit')).toBe(true);
  expect([...rail!.querySelectorAll<HTMLElement>('[data-review-file]')].map((row) => row.dataset.reviewFile).sort()).toEqual(['docs/notes.md', 'src/auth/guard.ts', 'src/auth/token.ts']);
  expect(rail!.querySelector('[data-review-folder="src/auth"]') !== null).toBe(true);
  expect(rail!.textContent).toContain('3 files');
  expect(treeFile('src/auth/token.ts')!.textContent).toContain('+2');
  expect(document.querySelector('[data-review-jump]')?.textContent).toContain('of 3');

  await click(document.querySelector('[data-review-mode-choice="walkthrough"] input'));
  expect(tree() !== null).toBe(false);
});

test.skipIf(!hasDom)('a click on a file in the tree goes to it: the reader brings it into view and the bar names it', async () => {
  await render();
  await allFiles();
  await click(treeFile('src/auth/token.ts'));
  expect(reader.reveal?.path).toBe('src/auth/token.ts');
  expect(document.querySelector('[data-review-jump]')?.textContent).toContain('token.ts');
  await click(treeFile('docs/notes.md'));
  expect(reader.reveal?.path).toBe('docs/notes.md');
  expect(document.querySelector('[data-review-jump]')?.textContent).toContain('notes.md');
});

test.skipIf(!hasDom)("a review's tree has Viewed circles that save the tick; a guide's has none", async () => {
  await render();
  await allFiles();
  const circle = treeFile('src/auth/guard.ts')!.querySelector('[role="checkbox"]');
  expect(circle?.getAttribute('aria-checked')).toBe('false');
  await click(circle);
  expect(viewedPosts).toEqual([['src/auth/guard.ts']]);
  expect(treeFile('src/auth/guard.ts')!.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  expect(reader.reveal ?? null).toBeNull();

  act(() => root?.unmount());
  host?.remove();
  await render({ review: false });
  await allFiles();
  expect(treeFile('src/auth/guard.ts') !== null).toBe(true);
  expect(tree()!.querySelector('[role="checkbox"]') !== null).toBe(false);
});

test.skipIf(!hasDom)("a phone: no rail beside the diff; the bar's Files button opens the tree as a sheet, and a pick closes it on the file", async () => {
  asPhone();
  await render();
  const pane = () => document.querySelector<HTMLElement>('[data-review-message]')!;
  expect(document.querySelector('[data-review-files-button]') !== null).toBe(false);
  await click(document.querySelector('[data-review-jump]'));
  await click(document.querySelector('[data-review-mode-choice="files"]'));
  expect(reader.mode).toBe('files');
  const button = document.querySelector<HTMLElement>('[data-review-files-button]')!;
  expect(button.getAttribute('aria-label')).toBe('Files, 3');
  expect(pane().classList.contains('ib-files-open')).toBe(false);
  await click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(pane().classList.contains('ib-files-open')).toBe(true);
  await click(treeFile('src/auth/token.ts'));
  expect(reader.reveal?.path).toBe('src/auth/token.ts');
  expect(pane().classList.contains('ib-files-open')).toBe(false);
  expect(document.activeElement === document.querySelector('[data-review-files-button]')).toBe(true);
});
