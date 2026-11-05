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
const { MachineSidebarWord, MachineUpdateButton, MachineUpdateDialog, UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL } = (hasDom ? await import('./components/MachineUpdate') : {}) as typeof import('./components/MachineUpdate');
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

test('Update now asks that machine with nothing but the tab, so the window cannot name a version', async () => {
  await dialog(view('behind'));
  await act(async () => button('Update now')!.click());
  expect(starts()).toHaveLength(1);
  expect(starts()[0]!.url).toBe(`/api/inbox/machines/${MAC}/update`);
  expect(Object.keys(starts()[0]!.body ?? {}).filter((key) => key !== 'serverSession')).toEqual([]);
});

test('a refused start says why in the dialog and can be pressed again', async () => {
  startAnswer = { status: 409, body: { error: 'Studio is busy with something else.', code: 'update_x' } };
  await dialog(view('behind'));
  await act(async () => button('Update now')!.click());
  expect(document.querySelector('.ib-error')?.textContent).toContain('busy with something else');
  expect(button('Update now')!.disabled).toBe(false);
});

test('states that cannot start an update offer no way to press one', async () => {
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

test('asleep sends nothing, not even a read: a machine that is not there gets no request', async () => {
  await dialog(view('behind'), { state: 'offline' });
  expect(sent).toEqual([]);
});

test('an install that finished with the binary unchanged tells the person and offers Try Again, never Update again', async () => {
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

test('a failed install keeps its reason from that machine, with the log as it came, and Try Again presses again', async () => {
  answer = { current: '0.28.46', log: '~/.plannotator/update.log', command: 'curl x', failure: { exit_code: 75, prepare: 'the temp folder ~/tmp is full' } };
  await dialog(view('failed'));
  expect(commands()).toContain('~/.plannotator/update.log');
  expect(document.body.textContent).toContain('the temp folder ~/tmp is full');
  expect(document.body.textContent).toContain('on Studio');
  await act(async () => button('Try Again')!.click());
  expect(starts()).toHaveLength(1);
});

test('a machine too old for this: the by-hand command, and the full path for a shell that skips PATH (ssh host cmd)', async () => {
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

test('the PowerShell line takes no `&&` (a parse error in 5.1) and no path that only exists on macOS and Linux', () => {
  expect(UPDATE_BY_HAND_POWERSHELL).not.toContain('&&');
  expect(UPDATE_BY_HAND_POWERSHELL).not.toContain('~');
  expect(UPDATE_BY_HAND_POWERSHELL.split(';').map((part) => part.trim())).toEqual(['plannotator update', 'plannotator inbox restart']);
});

test('an older door, in any state its own install left: never a press that gets machine_too_old, and never an empty Copy box', async () => {
  answer = { too_old: true, current: '0.28.46' };
  for (const phase of ['failed', 'ready', 'behind'] as const) {
    await dialog(view(phase, { can_update: false }));
    expect([phase, !!button('Try Again'), !!button('Restart'), !!button('Update now')]).toEqual([phase, false, false, false]);
    expect(commands()).toEqual([UPDATE_BY_HAND, UPDATE_BY_HAND_FULL_PATH, UPDATE_BY_HAND_POWERSHELL]);
    act(() => root?.unmount());
    host?.remove();
    root = null;
  }
  expect(starts()).toEqual([]);
});

test('updating says its Inbox restarts by itself only where it does: an older door waits for a person there', async () => {
  await dialog(view('updating'));
  expect(document.body.textContent).toContain('then its Inbox restarts');
  act(() => root?.unmount());
  host?.remove();
  await dialog(view('updating', { can_update: false }));
  expect(document.querySelector('[data-dialog="machine-update-progress"]')?.textContent).toContain('It runs 0.28.46 until the install is in.');
  expect(document.body.textContent).not.toContain('restarts');
});

test('a log that did not read as a path shows no empty Copy box: only the install command stays', async () => {
  answer = { current: '0.28.46', log: '', command: 'curl x', failure: { exit_code: 1 } };
  await dialog(view('failed'));
  expect(commands()).toEqual(['curl x']);
  expect(document.body.textContent).not.toContain('the log says');
});

test('a press that machine answers up to date: the word has gone, the dialog says so, and nothing is left to press', async () => {
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

test('a copy the script does not own: the install command, from what that machine read', async () => {
  answer = { current: '0.28.46', command: 'irm https://plannotator.ai/install.ps1 | iex' };
  await dialog(view('behind', { self_update: false }));
  expect(commands()).toEqual(['irm https://plannotator.ai/install.ps1 | iex']);
});

test('a copy the script does not own, asleep: no terminal line with nothing under it, and no request', async () => {
  await dialog(view('behind', { self_update: false }), { state: 'offline' });
  expect(document.querySelector('[data-dialog="machine-update-by-hand"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('in a terminal');
  expect(commands()).toEqual([]);
  expect(sent).toEqual([]);
});

test("Snooze's words show only when Snooze opened the dialog", async () => {
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

test('the word in the sidebar opens the dialog; the press never reaches the row beneath, which filters', async () => {
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

test('Settings: the row has its button for each state that needs one, and none on a page that offers no updates', async () => {
  const machines = [machine(null, { id: SELF, name: 'Mac', self: true }), machine(view('behind'))];
  let pressed = '';
  await draw(<MachinesSection machines={machines} via="local" onChanged={() => {}} onMachineUpdate={(id) => (pressed = id)} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-machine-update="update"]')!.click());
  expect(pressed).toBe(MAC);
  act(() => root?.unmount());
  host?.remove();
  await draw(<MachinesSection machines={machines} via="tailnet" onChanged={() => {}} />);
  expect(document.querySelector('[data-machine-update]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  await draw(<MachineUpdateButton machine={machine(view('updated'))} onPress={() => {}} />);
  expect(document.querySelector('[data-machine-update]')).toBeNull();
  expect(document.querySelector('[data-machine-update-done]')).not.toBeNull();
});

test('Snooze on an older machine stays, and its press opens the dialog instead of a list of times', async () => {
  let pressed = 0;
  await draw(<ThreadSnooze snooze={{ snoozed: false, onPick: () => {}, onUnsnooze: () => {}, blocked: { name: 'Studio', onPress: () => pressed++ } }} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-snooze-blocked]')!.click());
  expect(pressed).toBe(1);
  expect(document.querySelector('[data-snooze-choice]')).toBeNull();
});
