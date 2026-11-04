/**
 * The verdict from the full-window review (code review in the Inbox), with
 * the Inbox's doors stubbed at `fetch`. What regresses:
 *
 *  - the verdict going to the session that wrote the review after it ended,
 *    with no word to the person, while another session of the project is
 *    live (a reply asks where it goes; so does the verdict);
 *  - the note on a decision lost when its send fails, or a retry of the same
 *    verdict going with a new idempotency key (two replies for one verdict);
 *  - a verdict whose answer comes after the person left the review pulling
 *    them back to its thread.
 *
 * The diff reader is stubbed: this file is about the header's decision.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
if (hasDom) mock.module('#guide-reader', () => ({ default: () => null }));
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { readReviewNotes, clearReviewNotes } = (hasDom ? await import('./reviewVerdict') : {}) as typeof import('./reviewVerdict');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const OTHER = { session: 'ses_other', host: 'codex', started_at: '2026-10-11T10:31:00.000Z', last_seen_at: '2026-10-11T10:50:00.000Z', busy: false, idle_since: null, wrote_thread: false };

const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Token refresh',
    intent: 'Refresh tokens before they expire.',
    sections: [{ title: 'The guard', overview: 'Where the refresh happens.', diffs: [{ file: 'src/auth.ts', summary: 'Adds the refresh guard.' }] }],
  },
  reviewed: [false],
  review: { rawPatch: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n', gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const message: InboxMessageWire = {
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
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 1, deletions: 0, review: true, chapters: ['The guard'] },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: REVIEW, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: Record<string, unknown>[] = [];
let others: (typeof OTHER)[] = [];
let replyAnswer: () => Response = () => Response.json({ reply: {}, questions: [], replayed: false });
let backs = 0;
let pendingAnnotations: unknown[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  others = [OTHER];
  backs = 0;
  pendingAnnotations = [];
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  clearReviewNotes(REVIEW);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      if (path.endsWith('/reply')) {
        posted.push(JSON.parse(String(init.body)));
        return replyAnswer();
      }
      return Response.json({});
    }
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: pendingAnnotations });
    if (path.includes('/sessions')) {
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: others, asker: { session: 'ses_review', live: false } });
    }
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
  clearReviewNotes(REVIEW);
});

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={thread} message={message} onBack={() => (backs += 1)} onClose={() => {}} onSent={() => {}} />
      </div>,
    );
  });
  await settle();
}

const click = async (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`${selector} did not render`);
  await act(async () => el.click());
  await settle();
};

test.skipIf(!hasDom)('the review built for the test', () => {
  expect(snapshot).not.toBeNull();
});

test.skipIf(!hasDom)('the session that wrote the review ended: the verdict asks where it goes, and goes to the live session picked', async () => {
  await render();
  expect(document.querySelector('[data-asker-ended="live"]')).not.toBeNull();
  await click('[data-review-decision] [data-decision-primary]');
  expect(posted).toEqual([]);
  expect(document.querySelector('[data-route-choice]')).not.toBeNull();
  await click('[data-route-send]');
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ review_verdict: 'approved', to: { host: 'codex', session: 'ses_other' } });
  expect(backs).toBe(1);
});

test.skipIf(!hasDom)('ended with nothing live: the note says so, and the verdict waits for the next agent', async () => {
  others = [];
  await render();
  expect(document.querySelector('[data-asker-ended="none-live"]')).not.toBeNull();
  await click('[data-review-decision] [data-decision-primary]');
  expect(document.querySelector('[data-route-choice]')).toBeNull();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.to).toBeUndefined();
});

test.skipIf(!hasDom)('a failed send keeps the note, and the retry goes with the same key', async () => {
  others = [];
  replyAnswer = () => Response.json({ code: 'internal', error: 'The Inbox could not save it.' }, { status: 500 });
  await render();
  await click('[data-review-decision] [data-decision-caret]');
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((el) => el.textContent?.includes('note'));
  await act(async () => item!.click());
  const field = document.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  setter?.call(field, 'Ship it after the test.');
  await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
  await settle();
  expect(posted).toHaveLength(1);
  expect(backs).toBe(0);
  expect(Object.values(readReviewNotes(REVIEW))).toEqual(['Ship it after the test.']);

  // Retried: the same verdict, the same key; once it went, the note is gone.
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  await click('[data-review-decision] [data-decision-caret]');
  const again = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((el) => el.textContent?.includes('note'));
  await act(async () => again!.click());
  const kept = document.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')!;
  expect(kept.value).toBe('Ship it after the test.');
  await act(async () => kept.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
  await settle();
  expect(posted).toHaveLength(2);
  expect(posted[1]!.idempotency_key).toBe(posted[0]!.idempotency_key);
  expect(readReviewNotes(REVIEW)).toEqual({});
  expect(backs).toBe(1);
});

test.skipIf(!hasDom)('a verdict answered after the review closed leaves the person where they are', async () => {
  others = [];
  let answer: (response: Response) => void = () => {};
  replyAnswer = () => new Promise<Response>((resolve) => (answer = resolve)) as unknown as Response;
  await render();
  await click('[data-review-decision] [data-decision-primary]');
  expect(posted).toHaveLength(1);
  act(() => root?.unmount());
  root = null;
  answer(Response.json({ reply: {}, questions: [], replayed: false }));
  await settle();
  expect(backs).toBe(0);
});

// A global comment (on the whole review) is a comment like a line comment: it flips Approve to Send feedback and
// rides the verdict, under "Global comments" ahead of the files.
test.skipIf(!hasDom)('a global comment flips the decision to Send feedback and rides the verdict under Global comments', async () => {
  others = [];
  const text = 'Split the guard and the retry into two PRs.';
  pendingAnnotations = [
    {
      id: 'ann-guide-global', project_id: PROJECT.id, thread_id: REVIEW, message_id: REVIEW, attachment_id: '', path: '', version: 'a',
      guide: { title: 'Token refresh', file: '', side: 'new', line_start: 0, line_end: 0, scope: 'general' },
      annotation: { id: 'ann-guide-global', type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text, createdAt: 1 },
      created_at: '2026-10-11T10:45:00.000Z', updated_at: '2026-10-11T10:45:00.000Z', removed_at: null, sent_reply_id: null,
    },
  ];
  await render();
  expect(document.querySelector('[data-review-decision] [data-decision-primary]')!.textContent).toContain('Send Feedback');
  await click('[data-review-decision] [data-decision-primary]');
  expect(posted).toHaveLength(1);
  expect(posted[0]!.annotation_ids).toEqual(['ann-guide-global']);
  expect(String(posted[0]!.feedback)).toContain(`## Global comments\n\n${text}`);
});
