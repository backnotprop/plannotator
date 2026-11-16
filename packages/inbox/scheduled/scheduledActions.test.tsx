/**
 * The page's buttons against a stand-in Inbox (CONTRACT.md section 2): Run now twice is one run and no error; Stop;
 * an agent-made one arrives Off and the switch turns it on; Delete gives the window's toast whose Undo brings it
 * back, and a delete that fails says so; a new one is made once, with a pick made while it was being made saved to
 * it; a first run that didn't start says so in the list. What regresses: a second press shown as an error, an off
 * one drawn On, a delete with no Undo or a silent failure, a pick lost on create.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { InboxToastModel } from '../components/Toast';
import { lastRun, scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { ScheduledPage } = (hasDom ? await import('./ScheduledPage') : {}) as typeof import('./ScheduledPage');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

type Call = { method: string; path: string; body: Record<string, unknown> | null };

/** The Inbox's scheduled routes over rows kept here; `hold` keeps a POST to that path until its release is called. */
function inbox(start: InboxScheduledRow[], options: { failDelete?: boolean; hold?: string } = {}) {
  const rows = new Map(start.map((row) => [row.id, row]));
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const put = (id: string, change: Partial<InboxScheduledRow>) => {
    const row = { ...rows.get(id)!, ...change, updated_at: new Date(Date.now() + calls.length).toISOString() };
    rows.set(id, row);
    return json({ scheduled: row });
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (method === 'POST' && path === options.hold) await new Promise<void>((resolve) => (release = resolve));
    if (path === '/api/inbox/scheduled') {
      if (method === 'GET') return json({ scheduled: [...rows.values()], launch_on: true });
      const row = scheduledRow('sch_made', { ...(body as Partial<InboxScheduledRow>), state: 'off', enabled: false });
      rows.set(row.id, row);
      return json({ scheduled: row }, 201);
    }
    if (path === '/api/inbox/scheduled/preview') return json({ ok: true, schedule_words: 'Every day at 9:00 AM', tz_short: 'EST', next_run: '2026-11-16T14:00:00.000Z' });
    const [, id, action] = /^\/api\/inbox\/scheduled\/([^/]+)(?:\/(\w+))?$/.exec(path) ?? [];
    const row = id ? rows.get(id) : undefined;
    if (!id || (!row && action !== 'restore')) return json({ code: 'not_found', error: 'No route.' }, 404);
    if (method === 'GET') return json({ scheduled: row, runs: [] });
    if (action === undefined) return put(id, body as Partial<InboxScheduledRow>);
    if (action === 'on' || action === 'off') return put(id, { state: action, enabled: action === 'on' });
    if (action === 'run') {
      if (row!.state === 'running') return json({ code: 'routine_running', error: `${row!.name} is running now.` }, 409);
      return put(id, { state: 'running', running_since: new Date().toISOString() });
    }
    if (action === 'stop') return put(id, { state: 'on', running_since: null });
    if (action === 'delete') {
      if (options.failDelete) return json({ code: 'internal_error', error: 'The Inbox could not save that.' }, 500);
      rows.delete(id);
      return json({ deleted: true });
    }
    if (action === 'restore') {
      rows.set(id, start.find((r) => r.id === id)!);
      return json({ scheduled: rows.get(id) });
    }
    return json({ code: 'not_found', error: 'No route.' }, 404);
  }) as typeof fetch;
  return { calls, rows, release: () => release?.() };
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

function page(openId: string | null, rows: InboxScheduledRow[], over: { onOpen?: (id: string | null, replace?: boolean) => void } = {}) {
  resetScheduledForTests(rows, true);
  const toasts: Omit<InboxToastModel, 'id'>[] = [];
  const opened: (string | null)[] = [];
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const draw = (id: string | null) =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <ScheduledPage
          openId={id}
          switch="on"
          rows={[]}
          phone={false}
          stacked={false}
          onOpen={(next, replace) => {
            opened.push(next);
            over.onOpen?.(next, replace);
          }}
          onOpenThread={() => {}}
          onSettings={() => {}}
          onToast={(toast) => toasts.push(toast)}
          />
        </SidebarProvider>,
      ),
    );
  draw(openId);
  return { host, toasts, opened, draw };
}

const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

test.skipIf(!hasDom)('Run now pressed twice is one run, with no error; then Stop stops it', async () => {
  const server = inbox([scheduledRow('sch_digest', { name: 'Morning PR digest' })]);
  const { host } = page('sch_digest', [...server.rows.values()]);
  await settle();
  const runNow = host.querySelector<HTMLButtonElement>('[data-scheduled-run-now]')!;
  await act(async () => {
    runNow.click();
    runNow.click();
  });
  await settle();
  expect(posts(server.calls, '/api/inbox/scheduled/sch_digest/run').length).toBe(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await click(host.querySelector('[data-scheduled-stop]'));
  await settle();
  expect(posts(server.calls, '/api/inbox/scheduled/sch_digest/stop').length).toBe(1);
  expect(host.querySelector('[data-scheduled-run-now]')).not.toBeNull();
});

test.skipIf(!hasDom)('an agent-made one arrives Off; the switch turns it on', async () => {
  const made = scheduledRow('sch_agent', { name: 'Nightly dependency check', state: 'off', enabled: false, approved_at: null, next_run: null, made_by: { host: 'claude-code', session: 's-maya', thread_id: 'msg_maya' } });
  const server = inbox([made]);
  const { host } = page('sch_agent', [made]);
  await settle();
  const toggle = host.querySelector<HTMLButtonElement>('[data-scheduled-editor] [role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.getAttribute('aria-label')).toBe('Off');
  await click(toggle);
  await settle();
  expect(posts(server.calls, '/api/inbox/scheduled/sch_agent/on').length).toBe(1);
  expect(host.querySelector('[data-scheduled-editor] [role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

test.skipIf(!hasDom)("Delete: the window's toast, whose Undo brings it back; a delete that fails says so", async () => {
  const row = scheduledRow('sch_digest', { name: 'Morning PR digest' });
  let server = inbox([row]);
  const { host, toasts, opened } = page(null, [row]);
  await settle();
  await click(host.querySelector('[data-scheduled-row="sch_digest"] [data-scheduled-menu]'));
  await click(document.querySelector('[data-scheduled-delete]'));
  await settle();
  expect(posts(server.calls, '/api/inbox/scheduled/sch_digest/delete').length).toBe(1);
  expect(host.querySelector('[data-scheduled-row="sch_digest"]')).toBeNull();
  // The menu's click did not also open the row it was on.
  expect(opened).toEqual([]);
  expect(toasts.at(-1)).toMatchObject({ lead: 'Routine deleted', detail: 'Morning PR digest' });
  await act(async () => toasts.at(-1)!.onUndo!());
  await settle();
  expect(posts(server.calls, '/api/inbox/scheduled/sch_digest/restore').length).toBe(1);
  expect(host.querySelector('[data-scheduled-row="sch_digest"]')).not.toBeNull();

  server = inbox([row], { failDelete: true });
  await click(host.querySelector('[data-scheduled-row="sch_digest"] [data-scheduled-menu]'));
  await click(document.querySelector('[data-scheduled-delete]'));
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Morning PR digest was not deleted. The Inbox could not save that.');
  expect(host.querySelector('[data-scheduled-row="sch_digest"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a new one is made once; a pick made while it is being made is saved to it', async () => {
  const server = inbox([], { hold: '/api/inbox/scheduled' });
  const { host, opened } = page('new', []);
  await settle();
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;
  await act(async () => setValue(name, 'Docs link check'));
  await act(async () => setValue(prompt, 'Check every link in the docs.'));
  await act(async () => {
    prompt.focus();
    prompt.blur();
  });
  // The create is on its way (held): the person picks Skip it.
  await click(host.querySelector('input[type="radio"][value="skip"]'));
  server.release();
  await settle();
  const creates = posts(server.calls, '/api/inbox/scheduled');
  expect(creates.length).toBe(1);
  expect(creates[0]!.body).toMatchObject({ name: 'Docs link check', prompt: 'Check every link in the docs.', if_missed: 'run_once' });
  expect(posts(server.calls, '/api/inbox/scheduled/sch_made').map((c) => c.body?.if_missed)).toEqual(['skip']);
  expect(server.rows.get('sch_made')?.if_missed).toBe('skip');
  expect(opened).toEqual(['sch_made']);
});

test.skipIf(!hasDom)("a first run that didn't start says so as its Last run", async () => {
  const row = scheduledRow('sch_docs', { name: 'Docs link check', runs: 1, last_run: lastRun(1, new Date().toISOString(), 'didnt_start') });
  inbox([row]);
  const { host } = page(null, [row]);
  await settle();
  expect(host.querySelector('[data-scheduled-row="sch_docs"] [data-scheduled-last]')?.textContent).toBe("Didn't start");
});
