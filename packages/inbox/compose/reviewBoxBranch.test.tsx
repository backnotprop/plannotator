/**
 * New review opened on one branch (Reviews' "On this computer": a branch diff's Review with an agent). What regresses:
 *  - a branch whose summary could not be read (its diff past the cap: 413) sending words that name no branch, so the
 *    agent reviews whatever is checked out instead;
 *  - a summary of no changes for that branch (an older Inbox summed a failed read so) moving To to another live
 *    agent's project, whose own changes would then be reviewed in the branch's place.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StartThreadInput } from '../api';
import { forgetUnsentReview } from './reviewBox';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./ComposeDialog') : {}) as typeof import('./ComposeDialog');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const live = (session: string) => ({ session, host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:59:00.000Z', busy: false, idle_since: null, last_thread: null });
/** web-app (prj_2) has an agent and changes of its own; spaces-site (prj_9) has the branch and an agent. */
const transport = (started: StartThreadInput[]) => ({
  sessions: async () => ({ serverSession: 's', home: '/home/dana', projects: [{ project: { id: 'prj_2', name: 'web-app', root: '/home/dana/web-app' }, sessions: [live('ses_web')] }, { project: { id: 'prj_9', name: 'spaces-site', root: '/home/dana/spaces-site' }, sessions: [live('ses_spaces')] }] }),
  startThread: async (input: StartThreadInput) => (started.push(input), { thread_id: 'thr_box' }),
  drafts: false,
  uploads: false,
});
/** What `/reviews/changes` answers for the branch's own project (prj_9, its branch named); every other read has 3 files. */
let branchAnswer: () => Response = () => Response.json({});

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') return Response.json({ ok: true });
    if (url.pathname.endsWith('/reviews/changes')) {
      if (url.searchParams.get('project') === 'prj_9' && url.searchParams.get('branch')) return branchAnswer();
      return Response.json({ git: true, files: 3, additions: 3, deletions: 0, branch: 'main', base: 'main' });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  forgetUnsentReview();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function open(started: StartThreadInput[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <ComposeDialog request={{ review: { branch: { name: 'bob/huge-codegen', projectId: 'prj_9' } } }} phone={false} current={null} lastSent={null} home={null} transport={transport(started) as never} onSent={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
}

const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

test.skipIf(!hasDom)("a branch too large to sum: To stays on the branch's project, and the words name that branch", async () => {
  branchAnswer = () => Response.json({ error: 'This diff is too large to read here.', code: 'diff_too_large' }, { status: 413 });
  const started: StartThreadInput[] = [];
  open(started);
  await settle();
  expect(el('[data-compose-to]').getAttribute('data-compose-to')).toBe('ses_spaces');
  // Not "No changes": nothing is said of a size that could not be read, and Send stays on.
  expect(document.querySelector('[data-review-size]')).toBeNull();
  expect(el('[data-compose-send]').classList.contains('ib-dis')).toBe(false);
  await act(async () => el('[data-compose-send]').click());
  await settle();
  expect(started).toHaveLength(1);
  expect(started[0]!.body).toContain('the whole branch in spaces-site (on bob/huge-codegen)');
  expect(started[0]!.review).toMatchObject({ kind: 'local', changes: 'branch', branch: 'bob/huge-codegen' });
});

test.skipIf(!hasDom)("a branch summed as no changes: To never moves to another project's agent with changes of its own", async () => {
  branchAnswer = () => Response.json({ git: true, files: 0, additions: 0, deletions: 0, branch: 'bob/huge-codegen', base: 'main' });
  const started: StartThreadInput[] = [];
  open(started);
  await settle();
  expect(el('[data-review-size]').textContent).toBe('No changes');
  expect(el('[data-compose-to]').getAttribute('data-compose-to')).toBe('ses_spaces');
  expect(el('[data-compose-send]').classList.contains('ib-dis')).toBe(true);
  await act(async () => el('[data-compose-send]').click());
  await settle();
  expect(started).toEqual([]);
});
