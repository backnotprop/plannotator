/**
 * A thread the person started (compose), as the thread draws it: "You
 * started this thread · to <agent>", the queued and delivered lines, and Not
 * delivered with "Send to another session" when the session it was
 * addressed to stopped before it took the message. The failure this
 * catches: a message stuck on a session that is gone with nothing saying
 * so, or moved somewhere the person did not pick.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-14T10:00:00.000Z' };
const ROOT_ID = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';

function started(extra: Partial<InboxMessageWire> = {}): InboxThread {
  const root: InboxMessageWire = {
    id: ROOT_ID,
    project_id: PROJECT.id,
    thread_id: ROOT_ID,
    reply_to: null,
    author: { kind: 'person' },
    subject: 'Idea: show which session wrote each thread.',
    subject_question: null,
    body: 'Idea: show which session wrote each thread.\n\nA small chip on each row would do.',
    created_at: '2026-10-14T15:04:00.000Z',
    resolved_at: null,
    idempotency_key: 'c1',
    to: { host: 'claude-code', session: 'ses_gone' },
    started_by_person: true,
    ...extra,
  };
  return { thread_id: ROOT_ID, project: PROJECT, subject: root.subject, thread_name: null, resolved_at: null, messages: [root] };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let askerLive = true;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  askerLive = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ message: {}, row: null });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({
        serverSession: 's',
        home: '/home/me',
        project: PROJECT,
        sessions: [{ session: 'ses_pi', host: 'pi', started_at: '2026-10-14T14:00:00.000Z', last_seen_at: '2026-10-14T15:00:00.000Z', busy: false, idle_since: null, wrote_thread: false }],
        ...(asked ? { asker: { session: asked, live: askerLive } } : {}),
      });
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
});

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(thread: InboxThread, onChanged: () => Promise<void> = async () => {}) {
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
          onChanged={onChanged}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
        />
      </div>,
    );
  });
  await settle();
  return host;
}

test.skipIf(!hasDom)('a thread the person started names whom it went to, and says it waits for that session while it is live', async () => {
  const el = await render(started());
  expect(el.querySelector('[data-started-by]')?.textContent).toBe('You started this threadto Claude Code in ledger');
  expect(el.querySelector('[data-delivery]')?.getAttribute('data-delivery')).toBe('queued');
  expect(el.querySelector('[data-delivery]')?.textContent).toBe('Queued for Claude Code; it gets this as its next turn.');
  expect(el.querySelector('[data-readdress]')).toBeNull();
});

test.skipIf(!hasDom)('the session stopped before it took it: Not delivered, and Send to another session moves the same message to the session picked', async () => {
  askerLive = false;
  let changed = 0;
  const el = await render(started(), async () => {
    changed += 1;
  });
  const line = el.querySelector('[data-delivery]')!;
  expect(line.getAttribute('data-delivery')).toBe('undelivered');
  expect(line.textContent).toBe('Not delivered. That Claude Code session stopped before it took this. If it is resumed, it still gets it.');
  const open = el.querySelector('[data-readdress-open]') as HTMLButtonElement;
  act(() => open.click());
  await settle();
  // The ended-session reply's radio rows: the first live session is selected, focus on it.
  const pick = el.querySelector('[data-readdress-session="ses_pi"]') as HTMLLabelElement;
  expect(pick.textContent).toContain('Pi · started');
  const radio = pick.querySelector('input[type=radio]') as HTMLInputElement;
  expect(radio.checked).toBe(true);
  expect(document.activeElement).toBe(radio);
  expect(el.querySelector('[role=menu]')).toBeNull();
  act(() => (el.querySelector('[data-readdress-send]') as HTMLButtonElement).click());
  await settle();
  expect(posted).toEqual([{ path: `/api/inbox/messages/${ROOT_ID}/to`, body: { to: { host: 'pi', session: 'ses_pi' } } }]);
  expect(changed).toBe(1);
  // The choice is gone with the move: focus lands on the message's delivery line, never the page.
  for (let i = 0; i < 20 && document.activeElement === document.body; i++) await settle();
  expect(el.querySelector('[data-readdress-choice]')).toBeNull();
  expect(document.activeElement).toBe(el.querySelector(`[data-message-article="${ROOT_ID}"] [data-delivery]`));
});

test.skipIf(!hasDom)('delivered: the line says so, and nothing offers to move it', async () => {
  askerLive = false;
  const el = await render(started({ delivery: { state: 'delivered', host: 'claude-code', session: 'ses_gone', at: '2026-10-14T15:05:00.000Z' } }));
  expect(el.querySelector('[data-delivery]')?.textContent).toMatch(/^Delivered to Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  expect(el.querySelector('[data-readdress]')).toBeNull();
  // Nothing waits, so the window does not ask about the session.
  expect(posted).toEqual([]);
});

test.skipIf(!hasDom)('the To picker keeps its highlight on the same session when the 5 s re-read moves the rows', async () => {
  const { ToPicker } = await import('./compose/ToPicker');
  const target = (session: string, host: string, project: { id: string; name: string; root: string }) => ({
    session,
    host,
    project,
    started_at: '2026-10-14T09:12:00.000Z',
    last_seen_at: '2026-10-14T15:00:00.000Z',
    busy: false,
    idle_since: null,
    last_thread: null,
  });
  const p = { id: 'prj_p', name: 'plannotator', root: '/src/plannotator' };
  const a = target('ses-a', 'claude-code', p);
  const b = target('ses-b', 'pi', p);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const picker = createRoot(el);
  const draw = (sessions: (typeof a)[]) =>
    act(() => picker.render(<ToPicker groups={[{ project: p, current: true, sessions }]} selected={null} home={null} phone={false} onPick={() => {}} onClose={() => {}} />));
  draw([a, b]);
  const highlighted = () => el.querySelector('.ib-cp-opt.ib-hl')?.textContent ?? '';
  const arrow = () =>
    act(() => {
      el.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
  // Nobody in To: no row highlighted until an arrow key (then the first row).
  expect(highlighted()).toBe('');
  arrow();
  expect(highlighted()).toContain('Claude Code');
  arrow();
  expect(highlighted()).toContain('Pi');
  // The re-read puts Pi first: the highlight stays on Pi, not on row 2.
  draw([b, a]);
  expect(highlighted()).toContain('Pi');
  act(() => picker.unmount());
  el.remove();
});
