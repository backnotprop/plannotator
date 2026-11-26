/**
 * A review on a linked machine follows that machine's Code review switch, not this computer's: the Inbox that holds
 * the review takes or refuses its Viewed ticks, and it says its switch with the snapshot (`code_review`). What
 * regresses:
 *
 *  - Viewed ticks offered on a linked machine's review while Code review is off there (each tick is refused there);
 *  - no Viewed ticks on a linked machine's review because Code review is off on this computer;
 *  - this computer's own review no longer following this computer's switch.
 *
 * The diff reader is stubbed (it records the Viewed ticks it was handed). DOM-gated: runs under DOM_TESTS=1
 * (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
type Viewed = { files: ReadonlySet<string>; onToggle: (path: string) => void };
/** The Viewed ticks the stubbed reader was last handed (undefined: none offered). */
let viewed: Viewed | undefined;
if (hasDom) {
  const seam: string = './guide/PullChangesTree.tsx';
  const { PullChangesTree } = (await import(seam)) as Record<string, unknown>;
  mock.module('#guide-reader', () => ({
    PullChangesTree,
    default: (props: { viewed?: Viewed }) => {
      viewed = props.viewed;
      return null;
    },
  }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { rememberMachine, resetMachineRoutes, setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const SELF = 'ibx_01K7SSSSSSSSSSSSSSSSSSSSSS';
const OTHER = 'ibx_01K7MMMMMMMMMMMMMMMMMMMMMM';
const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const FAR = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const HERE = 'msg_01M4H6G73M9H3Z32T859E72DPZ';

const PATCH = 'diff --git a/src/guard.ts b/src/guard.ts\n--- a/src/guard.ts\n+++ b/src/guard.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n';
const snapshot = buildGuideSnapshot({
  guide: { title: 'Token refresh', intent: 'Refresh tokens before they expire.', sections: [{ title: 'The guard', overview: 'Where the refresh happens.', diffs: [{ file: 'src/guard.ts', summary: 'Adds the guard.' }] }] },
  reviewed: [false],
  review: { rawPatch: PATCH, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-10-11T10:40:00.000Z',
});

const messageOf = (id: string): InboxMessageWire =>
  ({
    id,
    project_id: PROJECT.id,
    thread_id: id,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
    subject: 'Token refresh',
    body: 'I wrote a review.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Token refresh', sections: 1, files: 1, additions: 2, deletions: 1, review: true, chapters: ['The guard'] },
  }) as InboxMessageWire;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The Code review switch each Inbox answers with the snapshot. */
let switchThere = { far: false, here: false };
let posts: string[] = [];
let bodies: { path: string; viewed: boolean }[] = [];
/** The review's machine is away: a Viewed write is held. */
let away = false;

beforeEach(() => {
  if (!hasDom) return;
  viewed = undefined;
  posts = [];
  bodies = [];
  away = false;
  window.localStorage.clear();
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: OTHER, name: 'MacBook', marks: ['linked-reads'], list_cursor: 1, state: 'online' },
  ]);
  rememberMachine([FAR], OTHER);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push(path);
      if (path.endsWith('/guide/viewed')) {
        const sent = JSON.parse(String(init.body)) as { path: string; viewed: boolean };
        const tick = { path: sent.path, viewed: sent.viewed };
        bodies.push(tick);
        // MacBook away: the tick is held in this computer's outbox.
        if (away) return Response.json({ outbox: { key: `k${bodies.length}`, machine: OTHER, route: `messages/${FAR}/guide/viewed`, state: 'queued', queued_at: '2026-11-25T10:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, viewed: tick }, machine: null }, { status: 202 });
        return Response.json({ message_id: FAR, viewed: tick.viewed ? [tick.path] : [] });
      }
      return Response.json({});
    }
    if (path.endsWith('/guide')) {
      const far = path.startsWith(`/api/inbox/m/${OTHER}/`);
      return Response.json({ message_id: far ? FAR : HERE, guide: messageOf(FAR).guide, code_review: far ? switchThere.far : switchThere.here, snapshot });
    }
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
  resetMachineRoutes();
});

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The review `id`, with this computer's Code review switch `codeReview`. */
async function render(id: string, codeReview: boolean, outbox?: ReadonlyMap<string, import('@plannotator/core/inbox-wire-models').OutboxView>) {
  const message = messageOf(id);
  const thread: InboxThread = { thread_id: id, project: PROJECT, subject: 'Token refresh', thread_name: null, resolved_at: null, messages: [message] };
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={thread} message={message} codeReview={codeReview} outbox={outbox} onBack={() => {}} onClose={() => {}} onSent={() => {}} onWriteReply={() => {}} />
      </div>,
    );
  });
  await settle();
}

test.skipIf(!hasDom)("a linked machine's review: Code review off there offers no Viewed tick, even with it on here", async () => {
  switchThere = { far: false, here: true };
  await render(FAR, true);
  expect(viewed).toBeUndefined();
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)("a linked machine's review: Code review on there offers Viewed ticks, kept there, even with it off here", async () => {
  switchThere = { far: true, here: false };
  await render(FAR, false);
  expect(viewed).toBeDefined();
  await act(async () => viewed!.onToggle('src/guard.ts'));
  await settle();
  expect(posts).toEqual([`/api/inbox/m/${OTHER}/messages/${FAR}/guide/viewed`]);
});

test.skipIf(!hasDom)("its machine away: a tick is held, not an error; reopened, it still shows, and the next tick sends that file alone", async () => {
  switchThere = { far: true, here: true };
  away = true;
  await render(FAR, true);
  await act(async () => viewed!.onToggle('src/guard.ts'));
  await settle();
  expect([...viewed!.files]).toEqual(['src/guard.ts']);
  expect(host!.querySelector('[role="alert"]')).toBeNull();
  // Reopened from what MacBook keeps (none yet), with the tick still in this computer's outbox.
  const held = new Map([[`k1`, { key: 'k1', machine: OTHER, route: `messages/${FAR}/guide/viewed`, state: 'queued' as const, queued_at: '2026-11-25T10:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, viewed: bodies[0]! }]]);
  await render(FAR, true, held);
  expect([...viewed!.files]).toEqual(['src/guard.ts']);
  // Unticked again: one file's change, never a list that would drop another tick on its way.
  await act(async () => viewed!.onToggle('src/guard.ts'));
  await settle();
  expect(bodies).toEqual([
    { path: 'src/guard.ts', viewed: true },
    { path: 'src/guard.ts', viewed: false },
  ]);
});

test.skipIf(!hasDom)("a tick held for its machine says it waits, in the thread's held words, never as an error; landed, the line goes", async () => {
  switchThere = { far: true, here: true };
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: OTHER, name: 'MacBook', marks: ['linked-reads'], list_cursor: 1, state: 'offline' },
  ]);
  const entry = { key: 'k1', machine: OTHER, route: `messages/${FAR}/guide/viewed`, state: 'queued' as const, queued_at: '2026-11-25T10:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, viewed: { path: 'src/guard.ts', viewed: true } };
  await render(FAR, true, new Map([['k1', entry]]));
  expect([...viewed!.files]).toEqual(['src/guard.ts']);
  expect(host!.querySelector('[data-review-held] [data-outbox-line]')?.textContent).toBe('Will send when MacBook is back');
  expect(host!.querySelector('[role="alert"], .ib-error')).toBeNull();
  // Delivered: nothing waits, so nothing says it does.
  await render(FAR, true, new Map([['k1', { ...entry, state: 'delivered' as const }]]));
  expect(host!.querySelector('[data-review-held]')).toBeNull();
});

test.skipIf(!hasDom)("a linked machine's marks read after the review opened: its Viewed ticks show then, with no reopening", async () => {
  switchThere = { far: true, here: true };
  setSelfMachine(SELF, [
    { id: SELF, self: true, name: 'Studio' },
    { id: OTHER, name: 'MacBook', marks: [], list_cursor: null, state: 'connecting' },
  ]);
  await render(FAR, true);
  expect(viewed).toBeUndefined();
  await act(async () => {
    setSelfMachine(SELF, [
      { id: SELF, self: true, name: 'Studio' },
      { id: OTHER, name: 'MacBook', marks: ['linked-reads'], list_cursor: 1, state: 'online' },
    ]);
  });
  await settle();
  expect(viewed).toBeDefined();
});

test.skipIf(!hasDom)("this computer's review follows this computer's switch", async () => {
  switchThere = { far: true, here: true };
  await render(HERE, true);
  expect(viewed).toBeDefined();
  await render(HERE, false);
  expect(viewed).toBeUndefined();
});
