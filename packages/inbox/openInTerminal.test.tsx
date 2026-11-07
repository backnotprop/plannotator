/**
 * Open in Terminal on a launched thread's run line, as the window draws it: it shows only when a session
 * waits on Terminal or can't start, on the Inbox's own computer, for any host. The failures this catches: a
 * button a tailnet window can only be refused on, a host whose stuck session has no way to its terminal (a
 * host may offer no attach command while something still has the session), and a line left stale after the
 * host handed the session over. The ⋯ menu and Terminal itself are in tests/e2e/inbox-launch-claude.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLaunchRecord, InboxMessageWire, InboxProject, InboxRun, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-11T10:00:00.000Z' };
const ROOT = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const LAUNCH = 'lch_1';
const ATTACH = "cd '/work/ledger' && claude attach 4f1c9a2e";

function launchRecord(sessionRef: string | null): InboxLaunchRecord {
  return { id: LAUNCH, agent: 'claude-code', session_ref: sessionRef, folder: '/work/ledger', scratch: false, started_at: '2026-10-11T10:41:00.000Z' };
}

function threadOf(sessionRef: string | null): InboxThread {
  const root: InboxMessageWire = {
    id: ROOT,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: null,
    author: { kind: 'person' },
    subject: 'Look at the nightly sync',
    body: 'Find out why it retries forever.',
    created_at: '2026-10-11T10:41:00.000Z',
    resolved_at: null,
    idempotency_key: 'k',
    launch: launchRecord(sessionRef),
  };
  return { thread_id: ROOT, project: PROJECT, subject: root.subject, thread_name: null, resolved_at: null, messages: [root] };
}

function runOf(state: InboxRun['state'], extra: Partial<InboxRun> = {}): InboxRun {
  return { state, launch_id: LAUNCH, agent: 'claude-code', project: 'ledger', folder: '/work/ledger', since: null, again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: ATTACH, ...extra };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: string[] = [];
let runReads = 0;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  runReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push(path);
      return Response.json({ ok: true, command: ATTACH });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(thread: InboxThread, run: InboxRun, where: { phone?: boolean; remote?: boolean | null } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={thread}
          sent={null}
          onQuestions={() => {}}
          onChanged={async () => {}}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
          run={run}
          attachCommand={run.attach_command}
          onRunChanged={() => runReads++}
          {...where}
        />
      </div>,
    );
  });
  await settle();
  await settle();
}

const line = () => host!.querySelector<HTMLElement>('[data-run]');
const open = () => host!.querySelector<HTMLButtonElement>('[data-run-open]');

if (hasDom) {
  test('a session waiting on Terminal has the button on the Inbox\'s computer, and its press re-reads the line', async () => {
    await render(threadOf('4f1c9a2e'), runOf('waiting_terminal'), { remote: false });
    expect(open()).not.toBeNull();
    await act(async () => open()!.click());
    await settle();
    expect(posted).toEqual([`/api/inbox/launch/${LAUNCH}/open`]);
    expect(runReads).toBe(1);
  });

  test.each([
    ['over the tailnet', { remote: true }],
    ['on a phone', { phone: true }],
  ])('%s a session waiting on Terminal has no button: the line says where to answer and keeps the command', async (_, where) => {
    await render(threadOf('4f1c9a2e'), runOf('waiting_terminal'), where);
    expect(open()).toBeNull();
    expect(line()!.textContent).toContain('Answer it in Terminal on your Mac:');
    expect(line()!.querySelector('[data-run-attach]')).not.toBeNull();
  });

  test('over the tailnet a folder the agent refused has no button, and Try again stays', async () => {
    await render(threadOf(null), runOf('failed', { untrusted: true, attach_command: null, cause: 'Claude Code does not trust this folder.' }), { remote: true });
    expect(open()).toBeNull();
    expect(host!.querySelector('[data-run-retry]')).not.toBeNull();
  });

  test('a session that cannot start has the button, also from a host with no attach command for it now', async () => {
    await render(threadOf('4f1c9a2e'), runOf('failed', { attach_command: null, cause: 'A process from before still runs this session.' }));
    expect(open()).not.toBeNull();
    await act(async () => open()!.click());
    await settle();
    expect(posted).toEqual([`/api/inbox/launch/${LAUNCH}/open`]);
  });

  test('a start that failed with no session and no folder to trust has no button: nothing to open', async () => {
    await render(threadOf(null), runOf('failed', { attach_command: null, cause: 'It exited.' }));
    expect(open()).toBeNull();
  });

  test('a folder the agent refused has the button before any session exists', async () => {
    await render(threadOf(null), runOf('failed', { untrusted: true, attach_command: null, cause: 'Claude Code does not trust this folder.' }));
    expect(open()).not.toBeNull();
  });

  test.each([
    ['working', runOf('working')],
    ['stopped', runOf('stopped')],
  ])('a %s session has no button: nothing is stuck', async (_, run) => {
    await render(threadOf('4f1c9a2e'), run);
    expect(line()).not.toBeNull();
    expect(open()).toBeNull();
  });
}
