import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxAnnotationRecord, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';

const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };

const hasDom = typeof document !== 'undefined';
let readerProps: Record<string, unknown> | null = null;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: Record<string, unknown>) => {
      readerProps = props;
      return null;
    },
  }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { routeSendAnnotations, sendTargetsOf } = (hasDom ? await import('./sendTargets') : {}) as typeof import('./sendTargets');
const { attachmentFeedback } = (hasDom ? await import('./attachments') : {}) as typeof import('./attachments');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const GUIDE = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const PATCH = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Token refresh', intent: 'Refresh tokens before they expire.', sections: [{ title: 'The guard', overview: 'Where.', diffs: [{ file: 'src/auth.ts', summary: 'Adds the guard.' }] }] },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});
const GUIDE_META = { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 1, deletions: 1 };
const messageOf = (review: boolean): InboxMessageWire =>
  ({
    id: GUIDE,
    project_id: PROJECT.id,
    thread_id: GUIDE,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Token refresh',
    body: 'A guided review.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    guide: review ? { ...GUIDE_META, review: true, chapters: ['The guard'] } : GUIDE_META,
  }) as InboxMessageWire;
const threadOf = (message: InboxMessageWire): InboxThread => ({ thread_id: GUIDE, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] });

const commentRecord = (id: string, text: string): InboxAnnotationRecord =>
  ({
    id, project_id: PROJECT.id, thread_id: GUIDE, message_id: GUIDE, attachment_id: '', path: 'src/auth.ts', version: 'a',
    guide: { title: 'Token refresh', file: 'src/auth.ts', side: 'new', line_start: 1, line_end: 1 },
    annotation: { id, type: 'comment', scope: 'line', filePath: 'src/auth.ts', lineStart: 1, lineEnd: 1, side: 'new', text, createdAt: 1 },
    created_at: '2026-10-11T10:45:00.000Z', updated_at: '2026-10-11T10:45:00.000Z', removed_at: null, sent_reply_id: null,
  }) as unknown as InboxAnnotationRecord;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let asked: string[] = [];
let annotations: InboxAnnotationRecord[] = [];
let writeReplies = 0;
let pullsGate: Promise<void> = Promise.resolve();
const PR_KEY = 'github.com/acme/ledger#880';
let pullsListed: Record<string, unknown>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  asked = [];
  annotations = [];
  writeReplies = 0;
  readerProps = null;
  pullsGate = Promise.resolve();
  pullsListed = [];
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    asked.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST') return Response.json({ reply: {}, questions: [], replayed: false });
    if (/\/api\/inbox\/pulls(\?|$)/.test(path)) {
      await pullsGate;
      return Response.json({ fetched_at: null, hosts: [], pulls: pullsListed, links: {}, projects: {}, cards: {} });
    }
    if (path.includes('/guide')) return Response.json({ message_id: GUIDE, guide: GUIDE_META, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_a', live: true } });
    if (path.includes('/ask')) return Response.json({ subject: 'Token refresh', project: PROJECT.name, conversation: null, running: null, can_ask: true, agent: 'Claude Code' });
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
});

async function render(review: boolean, codeReview: boolean, threadPatch: Partial<InboxThread> = {}, walkthrough = false) {
  const plain = messageOf(review);
  const message = walkthrough ? ({ ...plain, guide: { ...plain.guide!, additions: 0, deletions: 0, walkthrough: true } } as InboxMessageWire) : plain;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane
          thread={{ ...threadOf(message), ...threadPatch }}
          message={message}
          codeReview={codeReview}
          onBack={() => {}}
          onClose={() => {}}
          onSent={() => {}}
          onAsk={() => {}}
          onWriteReply={() => (writeReplies += 1)}
          shapeHost={{} as ShapeHost}
          shapes={NO_BOARDS}
          board={null}
          onBoard={() => {}}
        />
      </div>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const pane = () => document.querySelector<HTMLElement>('section[aria-label="Review"][data-review-message]');
/** Booleans, not elements: a failed check on an element prints the whole DOM tree. */
const has = (selector: string) => document.querySelector(selector) !== null;

test.skipIf(!hasDom)('a guide (no review flag) opens the full review: Walkthrough | All files, the chapter menu, and no Approve', async () => {
  await render(false, true);
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-mode-choice="walkthrough"]')).toBe(true);
  expect(has('[data-review-mode-choice="files"]')).toBe(true);
  expect(has('[data-review-jump]')).toBe(true);
  expect(readerProps !== null).toBe(true);
  expect(has('[data-review-decision]')).toBe(false);
  expect(has('[data-decision-primary]')).toBe(false);
  expect(pane()!.textContent).not.toContain('Approve');
  expect(document.querySelector('[data-review-write-reply]')?.textContent).toContain('Write the reply');
  expect(readerProps!.viewed).toBeUndefined();
  expect(readerProps!.selectionActions).toBeUndefined();
  expect(typeof readerProps!.fileOpenIn).toBe('function');
});

test.skipIf(!hasDom)('Code review off: a review opens the full review with none of Code review: no verdict, Viewed, Show me, Ask or Open in, and nothing asked of its routes', async () => {
  await render(true, false);
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-mode-choice="files"]')).toBe(true);
  expect(has('[data-review-decision]')).toBe(false);
  expect(has('[data-decision-primary]')).toBe(false);
  expect(has('[data-review-write-reply]')).toBe(true);
  expect(readerProps!.viewed).toBeUndefined();
  expect(readerProps!.selectionActions).toBeUndefined();
  expect(readerProps!.fileOpenIn).toBeUndefined();
  expect((readerProps!.renderHeadActions as () => unknown)()).toBeNull();
  expect(asked.filter((line) => !/\/guide$|\/guide\?|\/attachments/.test(line))).toEqual([]);
});

test.skipIf(!hasDom)('with Code review on, the same review keeps its verdict and Viewed ticks (the control for the two above)', async () => {
  await render(true, true);
  expect(document.querySelector('[data-review-decision] [data-decision-primary]')?.textContent).toContain('Approve');
  expect(has('[data-review-write-reply]')).toBe(false);
  expect(readerProps!.viewed).toBeDefined();
});

async function menuProgress(): Promise<string | null> {
  await act(async () => {
    document.querySelector<HTMLElement>('[data-review-jump]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return document.querySelector('[data-review-jump-menu] [data-review-progress]')?.textContent ?? null;
}

test.skipIf(!hasDom)('a walkthrough takes no ticks: no chapter Reviewed, no file Viewed, and no "N of M" line in the chapter menu', async () => {
  await render(true, true, {}, true);
  expect(has('section[aria-label="Walkthrough"][data-review-message]')).toBe(true);
  expect(readerProps!.chapterTicks).toBe(false);
  expect(readerProps!.viewed).toBeUndefined();
  expect(await menuProgress()).toBeNull();
  expect(has('[data-review-jump-menu] [data-done]')).toBe(false);
});

test.skipIf(!hasDom)('a review keeps its ticks: chapter Reviewed, file Viewed and the chapter menu\'s "N of M" line (the control for the one above)', async () => {
  await render(true, true);
  expect(readerProps!.chapterTicks).not.toBe(false);
  expect(readerProps!.viewed).toBeDefined();
  expect(await menuProgress()).toBe('0 of 1 chapter reviewed');
});

test.skipIf(!hasDom)("a guide's comments wait for the next Send: the panel says so, Write the reply goes back to the thread, and the review sends nothing", async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.'), commentRecord('ann-2', 'Log the expiry.')];
  await render(false, true);
  const rides = document.querySelector('[data-review-rides]');
  expect(rides?.textContent).toBe('2 comments go with your next reply to Claude Code.');
  expect(document.querySelector('[data-guide-comments]')?.getAttribute('data-guide-comments')).toBe('2');
  await act(async () => document.querySelector<HTMLElement>('[data-review-write-reply]')!.click());
  expect(writeReplies).toBe(1);
  expect(asked.filter((line) => line.startsWith('POST'))).toEqual([]);

  const thread = threadOf(messageOf(false));
  const { carried } = routeSendAnnotations(thread, sendTargetsOf(thread), annotations);
  expect(carried.get(GUIDE)?.map((r) => r.id)).toEqual(['ann-1', 'ann-2']);
  const feedback = attachmentFeedback(carried.get(GUIDE)!, [], new Map(), PROJECT.root, {});
  expect(feedback).toContain('# Feedback on the guided review');
  expect(feedback).toContain('Name the retry limit.');
  expect(feedback).toContain('Log the expiry.');
});

test.skipIf(!hasDom)('one comment rides (the singular), and a resolved thread reads with no way to reply from the review', async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.')];
  await render(false, false);
  expect(document.querySelector('[data-review-rides]')?.textContent).toBe('1 comment goes with your next reply to Claude Code.');
  act(() => root?.unmount());
  host?.remove();
  const message = { ...messageOf(false), resolved_at: '2026-10-11T11:00:00.000Z' };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={{ ...threadOf(message), resolved_at: '2026-10-11T11:00:00.000Z' }} message={message} codeReview={false} onBack={() => {}} onClose={() => {}} onSent={() => {}} onWriteReply={() => (writeReplies += 1)} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} />
      </div>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(pane() !== null).toBe(true);
  expect(has('[data-review-write-reply]')).toBe(false);
  expect(has('[data-review-rides]')).toBe(false);
});

/** The review pane measured this wide (happy-dom has no layout: unmeasured reads as folded). */
function wide(width: number) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  return spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-review-message') ? ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
  });
}
const panel = () => document.querySelector<HTMLElement>('[data-review-panel]')!;
const commentsButton = () => document.querySelector<HTMLButtonElement>('[data-guide-comments-sheet]')!;

test.skipIf(!hasDom)('wide (1,600 px), no comments: the panel starts closed and nothing of it shows; the Comments button opens and closes it', async () => {
  const measured = wide(1600);
  try {
    await render(false, true);
    expect(panel().dataset.reviewPanel).toBe('closed');
    expect(pane()!.classList.contains('ib-rv-shut')).toBe(true);
    expect(commentsButton().getAttribute('aria-expanded')).toBe('false');
    await act(async () => commentsButton().click());
    expect(panel().dataset.reviewPanel).toBe('open');
    expect(pane()!.classList.contains('ib-rv-shut')).toBe(false);
    expect(commentsButton().getAttribute('aria-expanded')).toBe('true');
    await act(async () => commentsButton().click());
    expect(panel().dataset.reviewPanel).toBe('closed');
  } finally {
    measured.mockRestore();
  }
});

test.skipIf(!hasDom)('wide, a Code review review with comments: the panel starts open, its close hides it and gives focus to the button, and the comments still count and ride the verdict', async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.'), commentRecord('ann-2', 'Log the expiry.')];
  const measured = wide(1600);
  try {
    await render(true, true);
    expect(panel().dataset.reviewPanel).toBe('open');
    expect(pane()!.classList.contains('ib-rv-shut')).toBe(false);
    const close = panel().querySelector<HTMLButtonElement>('[aria-label="Close the comments"]')!;
    await act(async () => close.click());
    expect(panel().dataset.reviewPanel).toBe('closed');
    expect(pane()!.classList.contains('ib-rv-shut')).toBe(true);
    expect(document.activeElement === commentsButton()).toBe(true);
    expect(commentsButton().getAttribute('aria-label')).toBe('Comments, 2');
    expect(document.querySelector('[data-review-decision] [data-decision-primary]')?.textContent).toContain('Send Feedback');
    await act(async () => commentsButton().click());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => panel().querySelector<HTMLElement>('[aria-label="Close the comments"]')!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(panel().dataset.reviewPanel).toBe('closed');
  } finally {
    measured.mockRestore();
  }
});

test.skipIf(!hasDom)('narrow (folded), with comments: the panel starts closed, so it never covers the review on arrival', async () => {
  annotations = [commentRecord('ann-1', 'Name the retry limit.')];
  await render(false, false);
  expect(pane()!.classList.contains('ib-fold')).toBe(true);
  expect(panel().dataset.reviewPanel).toBe('closed');
  await act(async () => commentsButton().click());
  expect(panel().dataset.reviewPanel).toBe('open');
  expect(pane()!.classList.contains('ib-panel-open')).toBe(true);
});

test.skipIf(!hasDom)('the header says who sent it, from which project, and when', async () => {
  await render(false, false);
  expect(document.querySelector('.ib-vhead [data-review-from]')?.textContent).toMatch(/^from Claude Code in ledger, sent (Oct 11, )?\d{1,2}:\d{2}\s?[AP]M$/);
});

test.skipIf(!hasDom)("a teammate's PR review: nothing in the decision's place until the pull list answers, then Post, or Write the reply when the PR is not listed", async () => {
  let open!: () => void;
  pullsGate = new Promise<void>((resolve) => (open = resolve));
  await render(true, true, { pull_theirs: true, pull_keys: [PR_KEY] });
  expect(has('[data-review-write-reply]')).toBe(false);
  expect(has('[data-review-decision]')).toBe(false);
  await act(async () => {
    open();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(has('[data-review-write-reply]')).toBe(true);
});
