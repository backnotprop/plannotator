/**
 * Routines across linked computers in the window, against a stand-in Inbox and its forward: the page lists a linked
 * computer's routines beside this computer's, each naming its computer; Run and Turn off on one go to that computer
 * through the forward (`/api/inbox/m/<machine>/scheduled/…`, keyed); a write held for a computer that is away shows the
 * waiting toast; with Routines off here and on there, the page still lists and makes theirs; a new routine's computer
 * is picked in the editor, and its create goes there. Settings → Capabilities is one set for every linked computer: no
 * group per computer.
 *
 * What regresses: a far routine missing or unnamed, a far press going to this computer's routes (or without a key), a
 * far run's 202 answer read as a failure, a held write silent, the page hidden while only a linked computer has
 * Routines, the create made here when the person picked another computer; a group per linked computer back in
 * Settings → Capabilities, or a switch there read or turned through the forward; an away computer's rows claiming a
 * run going or a next run, or not said away; a Run while it is away held (or said as waiting) instead of refused in
 * plain words; a Stop without the run it was pressed for; Starting agents off there unsaid; a first read of a far
 * computer's routines that failed never tried again until a reconnect.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { InboxToastModel } from '../components/Toast';
import { lastRun, scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { ScheduledPage } = (hasDom ? await import('./ScheduledPage') : {}) as typeof import('./ScheduledPage');
const { resetScheduledForTests, useScheduled, useScheduledOn } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { resetMachineRoutes, setLinkedMachines } = await import('../inboxUrl');

const STUDIO = 'ibx_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const FAR = `/api/inbox/m/${STUDIO}`;
const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  resetMachineRoutes();
});

type Call = { method: string; path: string; body: Record<string, any> | null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const HELD = (key: string) => json({ outbox: { key, machine: STUDIO, state: 'queued', route: '', created_at: '', n: 1 }, machine: { id: STUDIO, name: 'Studio', state: 'offline' } }, 202);

/** This Inbox and, through its forward, Studio's: `away` makes every write to Studio wait in the outbox. */
function inbox(here: InboxScheduledRow[], there: InboxScheduledRow[], options: { hereOn?: boolean; away?: boolean; launchOff?: boolean } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : null;
    calls.push({ method, path, body });
    if (path === '/api/inbox/scheduled?machines=1') {
      return json({ scheduled: [...(options.hereOn === false ? [] : here), ...there.map((row) => ({ ...row, machine: STUDIO }))], launch_on: true, computers: [{ id: STUDIO, on: true, launch_on: options.launchOff !== true, away: options.away === true, read_at: '2026-11-24T14:10:00.000Z' }] });
    }
    if (path.endsWith('/scheduled/preview')) return json({ ok: true, schedule_words: 'Every day at 9:00 AM', tz_short: 'EST', next_run: '2026-11-16T14:00:00.000Z' });
    if (path.startsWith('/api/inbox/sessions') || path.startsWith(`${FAR}/sessions`)) return json({ home: '/home/ada', launch: { agents: [{ agent: 'claude-code', name: 'Claude Code', models: [] }], projects: [], scratch: null } });
    // Run once now is sent at the press or not at all (the forward's `now`): away, it is refused, never held.
    if (path.startsWith(FAR) && method === 'POST' && options.away && path.endsWith('/run')) return json({ error: 'Studio cannot be reached now.', code: 'machine_offline' }, 503);
    if (path.startsWith(FAR) && method === 'POST' && options.away) return HELD(String(body?.idempotency_key));
    const far = path.startsWith(FAR);
    const rows = far ? there : here;
    const [, id, action] = /\/scheduled\/(sch_[^/?]+)(?:\/(\w+))?$/.exec(path) ?? [];
    if (method === 'POST' && /\/scheduled$/.test(path)) return json({ scheduled: scheduledRow('sch_made', { name: String(body?.name ?? '') }) }, 201);
    const row = rows.find((r) => r.id === id);
    if (!row) return json({ code: 'not_found', error: 'No route.' }, 404);
    if (method === 'GET') return json({ scheduled: row, runs: [] });
    // A run's answer is a 202 as the far door gives it (the forward passes it on as delivered).
    if (action === 'run') return json({ scheduled: { ...row, state: 'running', running_since: new Date().toISOString(), updated_at: new Date().toISOString() }, message_id: 'msg_run' }, 202);
    if (action === 'off') return json({ scheduled: { ...row, state: 'off', updated_at: new Date().toISOString() } });
    return json({ scheduled: row });
  }) as typeof fetch;
  return { calls };
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

function page(openId: string | null, here: 'on' | 'off' = 'on') {
  setLinkedMachines([{ id: STUDIO, name: 'Studio', marks: ['routines', 'capabilities'], list_cursor: 1, state: 'online' }]);
  resetScheduledForTests(null, here === 'on');
  const toasts: Omit<InboxToastModel, 'id'>[] = [];
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const draw = (id: string | null) =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <ScheduledPage openId={id} switch={here} rows={[]} phone={false} stacked={false} onOpen={(next) => draw(next)} onOpenThread={() => {}} onSettings={() => {}} onToast={(toast) => toasts.push(toast)} />
        </SidebarProvider>,
      ),
    );
  draw(openId);
  return { host, toasts };
}

const click = (el: Element | null) => act(async () => (el as HTMLElement).click());

test.skipIf(!hasDom)("Routines turned on and off in a window with no linked computer: the window keeps working and asks the server nothing, even one without the machines read", async () => {
  const calls: string[] = [];
  // An older Inbox: none of the new routes (every one answers 404).
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return json({ code: 'not_found', error: 'No route.' }, 404);
  }) as typeof fetch;
  resetScheduledForTests(null, null);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // As the window does: a hook of its own right after (App.tsx's next is usePlansOn's effect).
  function Window({ on }: { on: boolean }) {
    const offered = useScheduledOn({ scheduled_threads: { on } });
    useEffect(() => {}, [offered]);
    return <span data-offered={String(offered)} />;
  }
  const draw = (on: boolean) => act(() => root!.render(<Window on={on} />));
  draw(false);
  await settle();
  draw(true);
  await settle();
  expect(host.querySelector('[data-offered]')!.getAttribute('data-offered')).toBe('true');
  draw(false);
  await settle();
  expect(host.querySelector('[data-offered]')!.getAttribute('data-offered')).toBe('false');
  expect(calls).toEqual([]);
});

test.skipIf(!hasDom)("a first read of a linked computer's routines that failed is read again on the next list, though that list names the same computers", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== '/api/inbox/scheduled?machines=1') return json({ code: 'not_found', error: 'No route.' }, 404);
    reads += 1;
    if (reads === 1) return json({ code: 'machine_offline', error: 'Studio cannot be reached now.' }, 503);
    return json({ scheduled: [{ ...scheduledRow('sch_far', { name: 'Nightly build', state: 'on' }), machine: STUDIO }], launch_on: true, computers: [{ id: STUDIO, on: true, launch_on: true, away: false }] });
  }) as typeof fetch;
  const studio = [{ id: STUDIO, name: 'Studio', marks: ['routines'], list_cursor: 1, state: 'online' }];
  setLinkedMachines(studio);
  // Routines off here: only Studio's are read.
  resetScheduledForTests(null, false);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  function Rows() {
    const s = useScheduled();
    return <span data-rows={s.rows === null ? 'none' : s.rows.map((row) => row.id).join(',')} />;
  }
  act(() => root!.render(<Rows />));
  await settle();
  expect([reads, host.querySelector('[data-rows]')!.getAttribute('data-rows')]).toEqual([1, 'none']);
  // The next merged list: the same facts, so nothing changed for `onLinkedMachines`.
  setLinkedMachines(studio);
  await settle();
  expect([reads, host.querySelector('[data-rows]')!.getAttribute('data-rows')]).toEqual([2, 'sch_far']);
  // Read once: a list after that reads nothing more.
  setLinkedMachines(studio);
  await settle();
  expect(reads).toBe(2);
});

test.skipIf(!hasDom)("a linked computer's routine is listed with its computer's name, and Run goes there, keyed; its 202 is the run", async () => {
  const server = inbox([scheduledRow('sch_here', { name: 'Morning digest', state: 'on' })], [scheduledRow('sch_far', { name: 'Nightly build', state: 'on' })]);
  const { host, toasts } = page(null);
  await settle();
  const far = host.querySelector('[data-scheduled-row="sch_far"]')!;
  expect(far.getAttribute('data-scheduled-computer')).toBe('Studio');
  expect(far.textContent).toContain('Nightly build · Studio');
  expect(host.querySelector('[data-scheduled-row="sch_here"]')!.getAttribute('data-scheduled-computer')).toBeNull();
  await click(far.querySelector('[data-scheduled-run="run"]'));
  await settle();
  const run = server.calls.find((c) => c.method === 'POST' && c.path.endsWith('/run'))!;
  expect(run.path).toBe(`${FAR}/scheduled/sch_far/run`);
  expect(typeof run.body?.idempotency_key).toBe('string');
  expect(host.querySelector('[data-scheduled-row="sch_far"]')!.getAttribute('data-state')).toBe('running');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(toasts).toEqual([]);
});

test.skipIf(!hasDom)('Studio away: Turn off waits in the outbox, and the waiting toast says so once', async () => {
  inbox([], [scheduledRow('sch_far', { name: 'Nightly build', state: 'on' })], { away: true });
  const { host, toasts } = page(null);
  await settle();
  await click(host.querySelector('[data-scheduled-row="sch_far"] [data-scheduled-menu]'));
  await click(document.querySelector('[data-scheduled-turn="off"]'));
  await settle();
  expect(toasts.map((t) => [t.icon, t.lead])).toEqual([['clock', 'Waiting for Studio: this applies when Studio is back.']]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test.skipIf(!hasDom)("Studio away: Run is refused at the press, said where the person pressed it, never held; its rows say away, with no Running or next run claimed", async () => {
  const running = scheduledRow('sch_far', { name: 'Nightly build', state: 'running', running_since: '2026-11-24T14:05:00.000Z', last_run: lastRun(4, '2026-11-24T14:05:00.000Z', 'running') });
  const server = inbox([], [running, scheduledRow('sch_far2', { name: 'Weekly cleanup', state: 'on' })], { away: true });
  const { host, toasts } = page(null);
  await settle();
  const row = host.querySelector('[data-scheduled-row="sch_far"]')!;
  expect(row.getAttribute('data-scheduled-computer')).toBe('Studio · away');
  expect(row.textContent).not.toContain('Running');
  expect(host.querySelector('[data-scheduled-row="sch_far2"] [data-scheduled-next]')!.textContent).toBe('');
  expect(host.querySelector(`[data-scheduled-away="${STUDIO}"]`)!.textContent).toMatch(/^Studio has been away since .+\. Its routines are as it last said\.$/);
  // Its last-known run keeps its Stop, which names that run.
  await click(row.querySelector('[data-scheduled-run="stop"]'));
  await settle();
  expect(server.calls.find((c) => c.path.endsWith('/stop'))!.body?.run).toBe('msg_run4');
  toasts.length = 0;
  await click(host.querySelector('[data-scheduled-row="sch_far2"] [data-scheduled-run="run"]'));
  await settle();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Studio is away. It didn't run.");
  expect(toasts).toEqual([]);
});

test.skipIf(!hasDom)("Starting agents off on Studio: the page says nothing runs there", async () => {
  inbox([], [scheduledRow('sch_far', { name: 'Nightly build', state: 'on' })], { launchOff: true });
  const { host } = page(null);
  await settle();
  expect(host.querySelector(`[data-scheduled-far-launch-off="${STUDIO}"]`)!.textContent).toBe('Starting agents is off on Studio, so nothing runs there.');
  expect(host.querySelector('[data-scheduled-launch-off]')).toBeNull();
});

test.skipIf(!hasDom)("Routines off here, on Studio: the page says this computer's are off and still lists and makes Studio's", async () => {
  inbox([], [scheduledRow('sch_far', { name: 'Nightly build', state: 'on' })], { hereOn: false });
  const { host } = page(null, 'off');
  await settle();
  expect(host.querySelector('[data-scheduled-off-note]')?.textContent).toContain('Routines are off on this computer.');
  expect(host.querySelector('[data-scheduled-row="sch_far"]')).not.toBeNull();
  expect(host.querySelector('[data-scheduled-new]')).not.toBeNull();
});

test.skipIf(!hasDom)("a new routine's computer is picked in the editor, and it is made there", async () => {
  const server = inbox([], [scheduledRow('sch_far', { name: 'Nightly build', state: 'on' })]);
  const { host } = page('new');
  await settle();
  const pick = host.querySelector<HTMLSelectElement>('[data-scheduled-runs-on] select')!;
  expect([...pick.options].map((o) => o.textContent)).toEqual(['this computer', 'Studio']);
  await act(async () => {
    pick.value = STUDIO;
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(host.querySelector('[data-scheduled-runs-on]')!.textContent).toContain('Runs on Studio');
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type(host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'Weekly cleanup');
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, 'Tidy the branches.');
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 700)));
  await settle();
  const creates = server.calls.filter((c) => c.method === 'POST' && /\/scheduled$/.test(c.path));
  expect(creates.map((c) => c.path)).toEqual([`${FAR}/scheduled`]);
  expect(creates[0]!.body?.name).toBe('Weekly cleanup');
});

test.skipIf(!hasDom)("Settings → Capabilities is one set for every linked computer: no group per computer, nothing read or turned on another one, and a switch turns here", async () => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : null });
    // What a linked computer's switches read through the forward answered before the one set.
    if (path.endsWith('/capabilities')) return json({ capabilities: { board: { on: true }, steps: { on: false } }, away: false, read_at: '2026-11-24T14:10:00.000Z', held: [] });
    return json({ scheduled: [], launch_on: true, computers: [] });
  }) as typeof fetch;
  const { SettingsPage } = await import('../components/Settings');
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const turned: [string, boolean][] = [];
  const settings = {
    serverSession: 's',
    version: '0.29.9',
    port: 1,
    url: 'http://localhost:1/',
    mcp_url: 'http://127.0.0.1:1/mcp',
    mcp_command: ['plannotator', 'inbox', 'mcp'],
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled: true, dismissed: false, allowed_origin: null },
    phones: false,
    store_dir: '/home/u/.plannotator/inbox',
    board: { on: false },
    steps: { on: true },
    bro: { on: false },
    experimental: { decision_mode: { on: false, env: null }, grid: { on: false, env: null } },
  };
  // Studio keeps the one set; an older Plannotator there still says `capabilities` (its own window's group of this one).
  const machines = [
    { id: 'ibx_01HSELFXXXXXXXXXXXXXXXXXXX', name: 'Laptop', self: true, state: 'online', marks: [] },
    { id: STUDIO, name: 'Studio', self: false, state: 'online', marks: ['capabilities', 'capability-note', 'capability-set'] },
    { id: 'ibx_01HOLDERXXXXXXXXXXXXXXXXX', name: 'Old laptop', self: false, state: 'offline', marks: ['capabilities'] },
  ];
  const noop = () => {};
  act(() =>
    root!.render(
      <SidebarProvider>
        <SettingsPage
          settings={settings as never}
          machines={machines as never}
          context={null}
          error={null}
          onToggleTool={noop}
          onToggleExperimental={noop}
          onToggleBoard={(on: boolean) => turned.push(['board', on])}
          onToggleSteps={(on: boolean) => turned.push(['steps', on])}
          onToggleBro={noop}
          onToggleTailscale={noop}
          tailscaleBusy={false}
          permission="granted"
          onToggleNotifications={noop}
          onDeleteThread={async () => {}}
          onDeleteProject={async () => {}}
          section="capabilities"
          phone={false}
        />
      </SidebarProvider>,
    ),
  );
  await settle();
  expect(host.querySelector('[data-settings-capabilities]')).not.toBeNull();
  // No group for Studio or for the older computer, and none of their names heads anything here.
  expect(host.querySelectorAll('[data-settings-linked-capabilities], [data-settings-linked-switch]').length).toBe(0);
  expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Studio');
  expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Old laptop');
  // This computer's switches turn here (the Inbox gives the flip to every linked computer); nothing goes through the forward.
  await click(host.querySelector('[data-settings-board] [role="switch"]'));
  expect(turned).toEqual([['board', true]]);
  expect(calls.filter((c) => c.path.startsWith('/api/inbox/m/'))).toEqual([]);
});
