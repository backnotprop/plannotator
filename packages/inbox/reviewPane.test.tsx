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
if (hasDom) {
  mock.module('#guide-reader', () => ({ default: () => null }));
  // The real review-app dialog and submit (tsconfig `paths` points the window's typecheck at its .d.ts).
  // By a path in a variable: the window's strict typecheck must not follow it into review-editor.
  const seam: string = './guide/PlatformPost.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#platform-post', () => real);
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { ReviewCard } = (hasDom ? await import('./components/ReviewCard') : {}) as typeof import('./components/ReviewCard');
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
/** Post to GitHub/GitLab: what went to `POST /api/inbox/pulls/review`, and the list the review reads its PR from. */
let reviewPosts: Record<string, unknown>[] = [];
/** The answer to the next `POST /pulls/review`, and the head the pull list reads (a refresh included). */
let reviewReply: () => Response = () => Response.json({ ok: true, prUrl: 'https://github.com/acme/ledger/pull/880', submission: { status: 'complete' } });
let listHead = 'a'.repeat(40);
let listReads: string[] = [];
/** The thread's annotation records (`/attachments`): a guided-review comment when a test writes one. */
let annotations: Record<string, unknown>[] = [];
const PR_KEY = 'github.com/acme/ledger#880';
const PR = {
  key: PR_KEY, platform: 'github', host: 'github.com', repo: 'acme/ledger', number: 880, url: 'https://github.com/acme/ledger/pull/880', title: 'RTL layout',
  author: 'tomas', mine: false, requested: true, state: 'open', base: 'main', head: 'rtl', head_repo: 'acme/ledger', head_sha: 'a'.repeat(40),
  additions: 4, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: 'success', updated_at: '2026-10-11T10:00:00.000Z', merged_at: null,
};

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  reviewPosts = [];
  reviewReply = () => Response.json({ ok: true, prUrl: PR.url, submission: { status: 'complete' } });
  listHead = 'a'.repeat(40);
  listReads = [];
  annotations = [];
  window.localStorage.clear();
  others = [OTHER];
  backs = 0;
  replyAnswer = () => Response.json({ reply: {}, questions: [], replayed: false });
  clearReviewNotes(REVIEW);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      if (path.endsWith('/pulls/review')) {
        reviewPosts.push(JSON.parse(String(init.body)));
        return reviewReply();
      }
      if (path.endsWith('/reply')) {
        posted.push(JSON.parse(String(init.body)));
        return replyAnswer();
      }
      return Response.json({});
    }
    if (/\/api\/inbox\/pulls(\?|$)/.test(path)) {
      listReads.push(path);
      return Response.json({ fetched_at: null, hosts: [], pulls: [{ ...PR, head_sha: listHead }], links: {}, projects: {}, cards: {} });
    }
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations });
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

async function render(on: InboxThread = thread) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={on} message={message} onBack={() => (backs += 1)} onClose={() => {}} onSent={() => {}} />
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

test.skipIf(!hasDom)('the top bar holds what the rail held: Walkthrough | All files, the chapter menu, the title, then the diff controls; no rail', async () => {
  await render();
  const bar = document.querySelector<HTMLElement>('[data-review-message] .ib-vhead')!;
  expect(document.querySelector('[data-review-message] .ib-rrail')).toBeNull();
  expect(bar.querySelector('[data-review-mode-choice="walkthrough"]')).not.toBeNull();
  expect(bar.querySelector('[data-review-mode-choice="files"]')).not.toBeNull();
  expect(bar.querySelector('[data-review-jump]')?.textContent).toContain('Overview');
  expect(bar.querySelector('[data-review-title]')?.textContent).toBe('Token refresh');
  // Less to read: the way back is its arrow, still named for a screen reader and a tooltip.
  const back = bar.querySelector<HTMLElement>('.ib-back')!;
  expect(back.textContent).toBe('');
  expect(back.getAttribute('aria-label')).toBe('Thread');
  // Nothing of the old header's: the review's name is said once.
  expect(bar.textContent).not.toContain('· from');
  // The diff controls are the bar's (approval "diff-controls-headers"): one Split / Unified button, not the old radios.
  const controls = bar.querySelector<HTMLElement>('[data-diff-controls]')!;
  expect(controls).not.toBeNull();
  expect(bar.querySelector('[data-review-title]')!.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(controls.querySelector('[data-diff-layout-toggle]')).not.toBeNull();
  expect(controls.querySelector('[data-diff-display-options]')).not.toBeNull();
  expect(document.querySelector('[data-review-message] [data-diff-style-switch]')).toBeNull();
});

test.skipIf(!hasDom)("a teammate's pull request (the thread holds only theirs): the review reads with no Approve or Request changes, and its card waits on no verdict", async () => {
  await render({ ...thread, pull_theirs: true });
  expect(document.querySelector('[data-review-jump="walkthrough"]')).not.toBeNull();
  expect(document.querySelector('[data-review-decision]')).toBeNull();
  expect(document.querySelector('[data-decision-primary]')).toBeNull();
  expect(document.querySelector('[data-asker-ended]')).toBeNull();
  expect(posted).toEqual([]);
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  const card = (verdict: boolean) => {
    act(() => {
      root = createRoot(host!);
      root.render(<ReviewCard guide={message.guide!} outcome={null} verdict={verdict} onOpen={() => {}} />);
    });
    const words = host!.textContent ?? '';
    act(() => root?.unmount());
    return words;
  };
  expect(card(true)).toContain('Waiting on you');
  expect(card(false)).not.toContain('Waiting on you');
});

test.skipIf(!hasDom)("a teammate's PR posts its full verdict on GitHub, while its agent path stays verdict-free (no reply, no choice)", async () => {
  await render({ ...thread, pull_theirs: true, pull_keys: [PR_KEY] });
  // Posting is the only ending here: no agent verdict control, no choice of where it goes.
  expect(document.querySelector('[data-review-destination]')).toBeNull();
  expect(document.querySelector('[data-review-decision]:not([data-review-posts])')).toBeNull();
  const primary = document.querySelector<HTMLElement>('[data-review-posts="github"] [data-decision-primary]');
  expect(primary?.textContent).toContain('Approve');
  await act(async () => primary!.click());
  await settle();
  const approve = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Approve')!;
  await act(async () => approve.click());
  await settle();
  expect(reviewPosts).toHaveLength(1);
  expect(reviewPosts[0]).toMatchObject({ key: PR_KEY, head_sha: PR.head_sha, action: 'approve' });
  expect(posted).toEqual([]);
  expect(document.querySelector('[data-pull-review-posted]')?.textContent).toContain('Approved on GitHub');
});

/** Types into the open dialog's main comment, as a person does (React reads the input event). */
function typeMainComment(words: string) {
  const box = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}
const dialogButton = (words: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === words)!;

test.skipIf(!hasDom)('after a post: a follow-up main comment still posts; a push since (pull_moved) reads the PR again and posts at its new head', async () => {
  await render({ ...thread, pull_theirs: true, pull_keys: [PR_KEY] });
  await click('[data-review-posts] [data-decision-primary]');
  await act(async () => dialogButton('Approve').click());
  await settle();
  expect(document.querySelector('[data-review-posted-done]')?.textContent).toContain('Approved on GitHub');
  // Only the main comment changed: a follow-up, with no line comments posted again.
  await click('[data-review-post-followup]');
  act(() => typeMainComment('Also: the sidebar icons.'));
  await act(async () => dialogButton('Post Comments').click());
  await settle();
  expect(reviewPosts.at(-1)).toMatchObject({ action: 'comment', fileComments: [] });
  expect(String(reviewPosts.at(-1)!.body)).toContain('Also: the sidebar icons.');
  expect(document.querySelector('[data-review-posted-done]')?.textContent).toContain('Approved on GitHub');

  // Pushed since: the post is refused, the PR is read again from the forge, and the next post goes at the new head.
  reviewReply = () => Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 });
  listHead = 'b'.repeat(40);
  await click('[data-review-post-followup]');
  act(() => typeMainComment('One more.'));
  await act(async () => dialogButton('Post Comments').click());
  await settle();
  expect(listReads.at(-1)).toContain('refresh=1');
  expect(document.querySelector('[data-review-pull-moved]')?.getAttribute('data-review-pull-moved')).toBe('read');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  reviewReply = () => Response.json({ ok: true, prUrl: PR.url, submission: { status: 'complete' } });
  await click('[data-review-posts] [data-decision-primary]');
  await act(async () => dialogButton('Approve').click());
  await settle();
  expect(reviewPosts.at(-1)).toMatchObject({ action: 'approve', head_sha: 'b'.repeat(40) });
});

test.skipIf(!hasDom)('a force-push under a post (pull_commit_gone): the PR is read again, and the decision is back at its new head', async () => {
  await render({ ...thread, pull_theirs: true, pull_keys: [PR_KEY] });
  reviewReply = () => Response.json({ error: 'The commit you read is no longer on this pull request.', code: 'pull_commit_gone' }, { status: 409 });
  listHead = 'b'.repeat(40);
  await click('[data-review-posts] [data-decision-primary]');
  await act(async () => dialogButton('Approve').click());
  await settle();
  expect(listReads.at(-1)).toContain('refresh=1');
  expect(document.querySelector('[data-review-pull-moved]')?.getAttribute('data-review-pull-moved')).toBe('read');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  reviewReply = () => Response.json({ ok: true, prUrl: PR.url, submission: { status: 'complete' } });
  await click('[data-review-posts] [data-decision-primary]');
  await act(async () => dialogButton('Approve').click());
  await settle();
  expect(reviewPosts.at(-1)).toMatchObject({ action: 'approve', head_sha: 'b'.repeat(40) });
});

test.skipIf(!hasDom)('a comment posted once is never posted again, even after a push (pull_moved) and a read at the new head', async () => {
  const comment = { id: 'ann-1', type: 'comment', scope: 'line', filePath: 'src/settings/Layout.tsx', lineStart: 3, lineEnd: 3, side: 'new', text: 'Mirror the icons.', createdAt: 1 };
  annotations = [{ id: 'rec-1', message_id: REVIEW, created_at: '2026-10-11T10:40:00.000Z', annotation: comment, guide: { line_start: 3, line_end: 3, file: 'src/settings/Layout.tsx', side: 'new' } }];
  await render({ ...thread, pull_theirs: true, pull_keys: [PR_KEY] });
  await click('[data-review-posts] [data-decision-caret]');
  const approveWith = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => /Approve with comments/.test(item.textContent ?? ''))!;
  await act(async () => approveWith.click());
  await settle();
  await act(async () => dialogButton('Approve').click());
  await settle();
  expect(String(reviewPosts[0]!.body)).toContain('Mirror the icons.');
  // A follow-up refused for a push: read again at head B.
  reviewReply = () => Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 });
  listHead = 'b'.repeat(40);
  await click('[data-review-post-followup]');
  act(() => typeMainComment('Also the footer.'));
  await act(async () => dialogButton('Post Comments').click());
  await settle();
  expect(document.querySelector('[data-review-pull-moved]')?.getAttribute('data-review-pull-moved')).toBe('read');
  // At B: the decision is back, and its post carries no comment that already went.
  reviewReply = () => Response.json({ ok: true, prUrl: PR.url, submission: { status: 'complete' } });
  await click('[data-review-posts] [data-decision-primary]');
  await act(async () => dialogButton('Approve').click());
  await settle();
  const last = reviewPosts.at(-1)!;
  expect(last).toMatchObject({ action: 'approve', head_sha: 'b'.repeat(40) });
  expect(JSON.stringify(last)).not.toContain('Mirror the icons.');
});

test.skipIf(!hasDom)('a thread that owns the person\'s PR offers both endings: its agent by default, GitHub on a pick', async () => {
  const mine = { ...PR, mine: true, author: 'me' };
  globalThis.fetch = ((inner) => (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/api/inbox/pulls') ? Response.json({ fetched_at: null, hosts: [], pulls: [mine], links: {}, projects: {}, cards: {} }) : inner(input, init)) as typeof fetch)(globalThis.fetch);
  await render({ ...thread, pull_keys: [PR_KEY] });
  expect(document.querySelector('[data-review-destination]')?.getAttribute('data-review-destination')).toBe('agent');
  expect(document.querySelector('[data-review-posts]')).toBeNull();
  await click('[data-review-destination-choice="forge"] input');
  expect(document.querySelector('[data-review-posts="github"]')).not.toBeNull();
});

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
  annotations = [
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
