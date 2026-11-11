/**
 * Update on a linked machine in the window (approval "inbox-machine-update"): the word beside a machine that is behind,
 * the Settings button, and what the little dialog offers in each state. What each state may DO is what is guarded here:
 * which ones can start an update, what a start sends, and which offer a command to run by hand.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineUpdateDetails, MachineUpdateView, MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { ASK_AGENT_TO_UPDATE, ASK_AGENT_TO_UPDATE_THREAD, MachineSidebarWord, MachineUpdateButton, MachineUpdateDialog, UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL } = (hasDom ? await import('./components/MachineUpdate') : {}) as typeof import('./components/MachineUpdate');
const { MachinesSection } = (hasDom ? await import('./components/Machines') : {}) as typeof import('./components/Machines');
const { ThreadSnooze } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');
const { machineNotice } = await import('./machines');

const MAC = `ibx_01K${'0'.repeat(22)}M`;
const SELF = `ibx_01K${'0'.repeat(22)}S`;

const view = (phase: MachineUpdateView['phase'], extra: Partial<MachineUpdateView> = {}): MachineUpdateView => ({ phase, target: '0.28.49', from: '0.28.46', can_update: true, self_update: true, ...extra });
const machine = (update: MachineUpdateView | null, extra: Partial<MachineView> = {}): MachineView => ({
  id: MAC,
  name: 'Studio',
  self: false,
  state: 'online',
  since: '2026-11-03T10:42:00.000Z',
  reason: null,
  version: '0.28.46',
  address: null,
  both_ways: true,
  waiting: 0,
  update,
  ...extra,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let sent: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let answer: MachineUpdateDetails = { current: '0.28.46' };
let startAnswer: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, outcome: 'launched' } };
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answer = { current: '0.28.46' };
  startAnswer = { status: 200, body: { ok: true, outcome: 'launched' } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    sent.push({ url: String(input), method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    return method === 'GET' ? new Response(JSON.stringify(answer)) : new Response(JSON.stringify(startAnswer.body), { status: startAnswer.status });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

async function draw(node: React.ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}
/** The dialog goes through a portal-free `<dialog>`, so it stays in `host`. */
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) ?? null;
const commands = () => [...document.querySelectorAll('.ib-cmd code')].map((c) => c.textContent);
const starts = () => sent.filter((call) => call.method === 'POST');
const dialog = (update: MachineUpdateView | null, extra: Partial<MachineView> = {}, snooze = false) =>
  draw(<MachineUpdateDialog machine={machine(update, extra)} snooze={snooze} onClose={() => {}} />);

test.skipIf(!hasDom)('Update now asks that machine with nothing but the tab, so the window cannot name a version', async () => {
  await dialog(view('behind'));
  await act(async () => button('Update now')!.click());
  expect(starts()).toHaveLength(1);
  expect(starts()[0]!.url).toBe(`/api/inbox/machines/${MAC}/update`);
  expect(Object.keys(starts()[0]!.body ?? {}).filter((key) => key !== 'serverSession')).toEqual([]);
});

test.skipIf(!hasDom)('a refused start says why in the dialog and can be pressed again', async () => {
  startAnswer = { status: 409, body: { error: 'Studio is busy with something else.', code: 'update_x' } };
  await dialog(view('behind'));
  await act(async () => button('Update now')!.click());
  expect(document.querySelector('.ib-error')?.textContent).toContain('busy with something else');
  expect(button('Update now')!.disabled).toBe(false);
});

test.skipIf(!hasDom)('states that cannot start an update offer no way to press one', async () => {
  const cases: [string, MachineUpdateView, Partial<MachineView>][] = [
    ['updating', view('updating'), {}],
    ['restarting', view('restarting'), { state: 'offline' }],
    ['not back', view('not_back'), { state: 'offline' }],
    ['updated', view('updated'), {}],
    ['too old', view('behind', { can_update: false }), {}],
    ['by hand', view('behind', { self_update: false }), {}],
    ['asleep', view('behind'), { state: 'offline' }],
  ];
  for (const [what, update, extra] of cases) {
    await dialog(update, extra);
    expect([what, !!button('Update now'), !!button('Restart'), !!button('Try Again')]).toEqual([what, false, false, false]);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
  expect(starts()).toEqual([]);
});

test.skipIf(!hasDom)('asleep sends nothing, not even a read: a machine that is not there gets no request', async () => {
  await dialog(view('behind'), { state: 'offline' });
  expect(sent).toEqual([]);
});

test.skipIf(!hasDom)('an install that finished with the binary unchanged tells the person and offers Try Again, never Update again', async () => {
  answer = { current: '0.28.46', log: '~/.plannotator/update.log', command: 'curl -fsSL https://plannotator.ai/install.sh | bash', failure: { exit_code: 0, unchanged: true } };
  await dialog(view('failed'));
  const unchanged = document.querySelector('[data-dialog="machine-update-unchanged"]')?.textContent;
  expect(unchanged).toContain('still on 0.28.46');
  // The row says Failed and "didn't install": the dialog says the same, never that the install finished.
  expect(unchanged).toContain("The update didn't install on Studio");
  expect(unchanged).not.toContain('finished');
  expect(button('Update now')).toBeNull();
  expect(commands()).toEqual(['~/.plannotator/update.log', 'curl -fsSL https://plannotator.ai/install.sh | bash']);
  await act(async () => button('Try Again')!.click());
  expect(starts()).toHaveLength(1);
});

test.skipIf(!hasDom)('a failed install keeps its reason from that machine, with the log as it came, and Try Again presses again', async () => {
  answer = { current: '0.28.46', log: '~/.plannotator/update.log', command: 'curl x', failure: { exit_code: 75, prepare: 'the temp folder ~/tmp is full' } };
  await dialog(view('failed'));
  expect(commands()).toContain('~/.plannotator/update.log');
  expect(document.body.textContent).toContain('the temp folder ~/tmp is full');
  expect(document.body.textContent).toContain('on Studio');
  await act(async () => button('Try Again')!.click());
  expect(starts()).toHaveLength(1);
});

test.skipIf(!hasDom)('a machine too old for this: the by-hand command, and the full path for a shell that skips PATH (ssh host cmd)', async () => {
  await dialog(view('behind', { can_update: false }));
  expect(commands()).toEqual([UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL]);
  // Both parts of the second line must not depend on PATH, or it fails the same way.
  expect(UPDATE_BY_HAND_FULL_PATH.match(/(^|&& )(\S+)/g)!.map((part) => part.replace('&& ', ''))).toEqual(['~/.local/bin/plannotator', '~/.local/bin/plannotator']);
  // Nothing on the row said so yet, but the door did: the same dialog.
  act(() => root?.unmount());
  host?.remove();
  answer = { too_old: true, current: '0.28.40' };
  await dialog(view('behind'));
  expect(commands()).toEqual([UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL]);
});

test.skipIf(!hasDom)('the PowerShell line takes no `&&` (a parse error in 5.1) and no path that only exists on macOS and Linux', () => {
  expect(UPDATE_BY_HAND_POWERSHELL).not.toContain('&&');
  expect(UPDATE_BY_HAND_POWERSHELL).not.toContain('~');
  expect(UPDATE_BY_HAND_POWERSHELL.split(';').map((part) => part.trim())).toEqual(['plannotator update', 'plannotator inbox restart']);
});

test.skipIf(!hasDom)('an older door, in any state its own install left: never a press that gets machine_too_old, and never an empty Copy box', async () => {
  // Before and after its door answered: the row alone already knows.
  for (const read of [{ too_old: true, current: '0.28.46' }, { current: '0.28.46' }]) {
    answer = read;
    for (const phase of ['failed', 'ready', 'behind'] as const) {
      await dialog(view(phase, { can_update: false }));
      expect([phase, !!button('Try Again'), !!button('Restart'), !!button('Update now')]).toEqual([phase, false, false, false]);
      expect(commands()).toEqual([UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL]);
      act(() => root?.unmount());
      host?.remove();
      root = null;
    }
  }
  expect(starts()).toEqual([]);
});

test.skipIf(!hasDom)('updating says its Inbox restarts by itself only where it does: an older door waits for a person there', async () => {
  await dialog(view('updating'));
  expect(document.body.textContent).toContain('then its Inbox restarts');
  act(() => root?.unmount());
  host?.remove();
  await dialog(view('updating', { can_update: false }));
  expect(document.querySelector('[data-dialog="machine-update-progress"]')?.textContent).toContain('It runs 0.28.46 until the install is in.');
  expect(document.body.textContent).not.toContain('restarts');
});

test.skipIf(!hasDom)('a log that did not read as a path shows no empty Copy box: only the install command stays', async () => {
  answer = { current: '0.28.46', log: '', command: 'curl x', failure: { exit_code: 1 } };
  await dialog(view('failed'));
  expect(commands()).toEqual(['curl x']);
  expect(document.body.textContent).not.toContain('the log says');
});

test.skipIf(!hasDom)('a press that machine answers up to date: the word has gone, the dialog says so, and nothing is left to press', async () => {
  startAnswer = { status: 409, body: { error: 'Studio is up to date.', code: 'update_up_to_date' } };
  await dialog(view('behind'));
  await act(async () => button('Update now')!.click());
  expect(document.querySelector('.ib-error')?.textContent).toBe('Studio is up to date.');
  // The row's next frame: nothing to say about this machine.
  await act(async () => root!.render(<MachineUpdateDialog machine={machine(null)} snooze={false} onClose={() => {}} />));
  expect(document.querySelector('[data-dialog="machine-update-level"]')?.textContent).toContain('Studio is up to date');
  expect(button('Update now')).toBeNull();
  expect(button('Close')).not.toBeNull();
});

test.skipIf(!hasDom)('a copy the script does not own: the install command, from what that machine read', async () => {
  answer = { current: '0.28.46', command: 'irm https://plannotator.ai/install.ps1 | iex' };
  await dialog(view('behind', { self_update: false }));
  expect(commands()).toEqual(['irm https://plannotator.ai/install.ps1 | iex']);
});

test.skipIf(!hasDom)('a copy the script does not own, asleep: no terminal line with nothing under it, and no request', async () => {
  await dialog(view('behind', { self_update: false }), { state: 'offline' });
  expect(document.querySelector('[data-dialog="machine-update-by-hand"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('in a terminal');
  expect(commands()).toEqual([]);
  expect(sent).toEqual([]);
});

test.skipIf(!hasDom)("Snooze's words show only when Snooze opened the dialog", async () => {
  for (const [update, extra] of [
    [view('behind'), {}],
    [view('behind', { can_update: false }), {}],
    [view('behind', { self_update: false }), {}],
    [view('behind'), { state: 'offline' as const }],
    [view('ready'), {}],
  ] as [MachineUpdateView, Partial<MachineView>][]) {
    await dialog(update, extra, true);
    expect(document.body.textContent).toContain('Snooze needs');
    act(() => root?.unmount());
    host?.remove();
    await dialog(update, extra, false);
    expect(document.body.textContent).not.toContain('Snooze needs');
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
});

test.skipIf(!hasDom)('the word in the sidebar opens the dialog; the press never reaches the row beneath, which filters', async () => {
  let opened = 0;
  let filtered = 0;
  await draw(
    <div onClick={() => filtered++}>
      <MachineSidebarWord notice={machineNotice(machine(view('behind')))!} name="Studio" onPress={() => opened++} />
    </div>,
  );
  await act(async () => document.querySelector<HTMLButtonElement>('.ib-mthing')!.click());
  expect([opened, filtered]).toEqual([1, 0]);
  expect(document.querySelector('.ib-mthing')?.textContent).toBe('Update');
});

test.skipIf(!hasDom)('Settings: the row has its button for each state that needs one, and none on a page that offers no updates', async () => {
  const machines = [machine(null, { id: SELF, name: 'Mac', self: true }), machine(view('behind'))];
  let pressed = '';
  await draw(<MachinesSection machines={machines} guest={false} onChanged={() => {}} onMachineUpdate={(id) => (pressed = id)} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-machine-update="update"]')!.click());
  expect(pressed).toBe(MAC);
  act(() => root?.unmount());
  host?.remove();
  await draw(<MachinesSection machines={machines} guest onChanged={() => {}} />);
  expect(document.querySelector('[data-machine-update]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  await draw(<MachineUpdateButton machine={machine(view('updated'))} onPress={() => {}} />);
  expect(document.querySelector('[data-machine-update]')).toBeNull();
  expect(document.querySelector('[data-machine-update-done]')).not.toBeNull();
});

test.skipIf(!hasDom)('Snooze on an older machine stays, and its press opens the dialog instead of a list of times', async () => {
  let pressed = 0;
  await draw(<ThreadSnooze snooze={{ snoozed: false, onPick: () => {}, onUnsnooze: () => {}, blocked: { name: 'Studio', onPress: () => pressed++ } }} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-snooze-blocked]')!.click());
  expect(pressed).toBe(1);
  expect(document.querySelector('[data-snooze-choice]')).toBeNull();
});

test.skipIf(!hasDom)('Not back offers to put back the version it ran, with each install script, and only for a release they can install', async () => {
  await dialog(view('not_back'), { state: 'offline' });
  const back = commands().filter((c) => c?.includes('0.28.46'));
  expect(back).toHaveLength(2);
  expect(back.some((c) => c!.includes('install.sh') && c!.includes('--version v0.28.46'))).toBe(true);
  expect(back.some((c) => c!.includes('install.ps1') && c!.includes('-Version v0.28.46') && !c!.includes('&&'))).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  // A development build or an unknown version: nothing the scripts could put back, so no line for it.
  for (const from of ['0.28.46-dev.3', null]) {
    await dialog(view('not_back', { from }), { state: 'offline', version: from });
    expect([from, commands()]).toEqual([from, ['plannotator inbox --background']]);
    act(() => root?.unmount());
    host?.remove();
  }
});

// "Ask an agent on <machine> to update it" (the owner's call, 2026-11-08): an older machine's dialog sends an agent
// there the ask, the same New message compose sends to a live session on a linked machine.

/** A live session as that machine's `GET sessions` lists it. */
const session = (id: string, host: string, busy: boolean | null, seen: string) => ({ session: id, host, started_at: seen, last_seen_at: seen, busy, idle_since: null, last_thread: null });
/** That machine's live sessions, through the forward. */
let thereSessions: { projects: { project: { id: string | null; name: string; root: string }; sessions: ReturnType<typeof session>[] }[] } = { projects: [] };
let sendAnswer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

function routeFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ url, method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (method === 'GET' && url.startsWith(`/api/inbox/m/${MAC}/sessions`)) return new Response(JSON.stringify({ serverSession: 's', home: '~', ...thereSessions }));
    if (method === 'GET') return new Response(JSON.stringify({ too_old: true, current: '0.28.46' }));
    if (url === `/api/inbox/m/${MAC}/messages`) return new Response(JSON.stringify(sendAnswer.body), { status: sendAnswer.status });
    return new Response(JSON.stringify({ ok: true, update: null }));
  }) as typeof fetch;
}
/** Lets the sessions read (and a Send) land. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
const askButton = () => document.querySelector<HTMLButtonElement>('[data-machine-ask-go]');
const tooOldView = (extra: Partial<MachineUpdateView> = {}) => view('behind', { can_update: false, ...extra });

test.skipIf(!hasDom)('an older machine with an agent running: one press sends that agent the ask in a new thread there, never an update press', async () => {
  routeFetch();
  thereSessions = {
    projects: [
      { project: { id: 'prj_a', name: 'billing', root: '~/billing' }, sessions: [session('ses-busy', 'claude-code', true, '2026-11-08T10:05:00Z')] },
      { project: { id: 'prj_b', name: 'site', root: '~/site' }, sessions: [session('ses-idle', 'codex', false, '2026-11-08T09:00:00Z')] },
    ],
  };
  sendAnswer = { status: 200, body: { thread_id: 'thr_01Kask', message: {}, replayed: false } };
  await dialog(tooOldView());
  await settle();
  expect(askButton()!.disabled).toBe(false);
  await act(async () => askButton()!.click());
  await settle();
  const sends = starts().filter((call) => call.url === `/api/inbox/m/${MAC}/messages`);
  expect(sends).toHaveLength(1);
  // The idle agent reads it sooner than the busy one.
  expect(sends[0]!.body).toMatchObject({ to: { host: 'codex', session: 'ses-idle' }, body: ASK_AGENT_TO_UPDATE, thread_name: ASK_AGENT_TO_UPDATE_THREAD });
  expect(starts().find((call) => call.url === `/api/inbox/machines/${MAC}/update/asked`)?.body).toMatchObject({ thread_id: 'thr_01Kask', agent: 'Codex' });
  expect(starts().some((call) => call.url === `/api/inbox/machines/${MAC}/update`)).toBe(false);
  // Sent: who was asked, the thread, no second ask; the commands stay as the fallback.
  expect(document.querySelector('[data-machine-ask="sent"]')?.textContent).toContain('Asked Codex on Studio');
  expect(document.querySelector('[data-machine-ask-thread]')?.getAttribute('href')).toBe('#thread=thr_01Kask');
  expect(askButton()).toBeNull();
  expect(commands()).toEqual([UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL]);
});

test.skipIf(!hasDom)('a Send that machine has not confirmed yet says it is on its way, and the row hears of it with no thread', async () => {
  routeFetch();
  thereSessions = { projects: [{ project: { id: 'prj_a', name: 'billing', root: '~/billing' }, sessions: [session('ses-a', 'claude-code', false, '2026-11-08T10:00:00Z')] }] };
  sendAnswer = { status: 202, body: { outbox: { key: 'k1', machine: MAC, state: 'queued' }, machine: null } };
  await dialog(tooOldView());
  await settle();
  await act(async () => askButton()!.click());
  await settle();
  expect(document.querySelector('[data-machine-ask="sent"]')?.textContent).toContain('Sending to Studio');
  expect(document.querySelector('[data-machine-ask-thread]')).toBeNull();
  expect(starts().find((call) => call.url === `/api/inbox/machines/${MAC}/update/asked`)?.body).toMatchObject({ thread_id: null, agent: 'Claude Code' });
});

test.skipIf(!hasDom)('no agent running there: it says so, offers to start one only where an agent can start there, and otherwise opens the commands', async () => {
  routeFetch();
  thereSessions = { projects: [] };
  let started = '';
  await draw(<MachineUpdateDialog machine={machine(tooOldView(), { launch: true })} snooze={false} onClose={() => {}} onStartAgent={(id) => (started = id)} />);
  await settle();
  expect(document.querySelector('[data-machine-ask="none"]')).not.toBeNull();
  expect(askButton()).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-machine-ask-start]')!.click());
  expect(started).toBe(MAC);
  expect(document.querySelector<HTMLDetailsElement>('details.ib-mhand')!.open).toBe(false);
  act(() => root?.unmount());
  host?.remove();
  // Launch off there (or too old to say): nothing to start, so the commands are the way, open.
  await draw(<MachineUpdateDialog machine={machine(tooOldView(), { launch: null })} snooze={false} onClose={() => {}} onStartAgent={() => {}} />);
  await settle();
  expect(document.querySelector('[data-machine-ask-start]')).toBeNull();
  expect(document.querySelector<HTMLDetailsElement>('details.ib-mhand')!.open).toBe(true);
  expect(starts()).toEqual([]);
});

test.skipIf(!hasDom)('an ask the row already carries (another tab, a reopened dialog): said with its thread, and nothing to press twice', async () => {
  routeFetch();
  thereSessions = { projects: [{ project: { id: 'prj_a', name: 'billing', root: '~/billing' }, sessions: [session('ses-a', 'claude-code', false, '2026-11-08T10:00:00Z')] }] };
  const asked = { thread: 'thr_9', agent: 'Claude Code', at: '2026-11-08T10:00:00Z' };
  await dialog(tooOldView({ asked }));
  await settle();
  expect(document.querySelector('[data-machine-ask="sent"]')?.textContent).toContain('Asked Claude Code on Studio');
  expect(askButton()).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  await draw(<MachineUpdateButton machine={machine(tooOldView({ asked }))} onPress={() => {}} />);
  expect(document.querySelector('[data-machine-update]')?.textContent).toBe('Asked');
  expect(starts()).toEqual([]);
});

test.skipIf(!hasDom)('an older machine that is asleep: no read and no send, and it says to wake it', async () => {
  routeFetch();
  await dialog(tooOldView(), { state: 'offline' });
  await settle();
  expect(sent).toEqual([]);
  expect(document.querySelector('[data-machine-ask="asleep"]')).not.toBeNull();
});

test.skipIf(!hasDom)('the ask runs the update before the restart, and the restart only after it worked', () => {
  const update = ASK_AGENT_TO_UPDATE.indexOf('`plannotator update`');
  const restart = ASK_AGENT_TO_UPDATE.indexOf('`plannotator inbox restart`');
  expect(update).toBeGreaterThan(-1);
  expect(restart).toBeGreaterThan(update);
  expect(ASK_AGENT_TO_UPDATE).toContain('only if step 1 succeeds');
});
