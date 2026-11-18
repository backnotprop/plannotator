/**
 * The Run and Secret cards live, in a DOM, against a fake computer whose answers change from one read to the next.
 * What regresses: a card that reads its state once after Run and then freezes ("Running · 0 s", the first line,
 * Stop after the end) until the window is focused again; a run pressed on another device never showing on an open
 * card; keyboard focus dropping to the page when Run becomes Stop, when the run ends and after Save; a double click
 * starting a second run or saying it is already running; and a run that needs an unsaved secret running anyway.
 *
 * No focus or visibility event is sent anywhere here: each card must move on by itself.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxRunBlocks } from '@plannotator/core/inbox-run-blocks';
import type { RunBlockView, RunStateWire, RunView } from './data/runApi';

const hasDom = typeof document !== 'undefined';
const { runApi } = (hasDom ? await import('./data/runApi') : {}) as typeof import('./data/runApi');
const store = (hasDom ? await import('./data/runStore') : {}) as typeof import('./data/runStore');
const { runBlockFor } = (hasDom ? await import('./parts/RunBlocks/RunBlock') : {}) as typeof import('./parts/RunBlocks/RunBlock');

const BODY = [':::run', 'Print progress', 'Five steps.', '', '```sh', 'for i in 1 2 3; do echo step $i; sleep 1; done', '```', ':::'].join('\n');
const KEY = parseInboxRunBlocks(BODY)[0]!.key;
const MESSAGE = { id: 'msg_live_1', body: BODY };

const blockView = (extra: Partial<RunBlockView> = {}): RunBlockView => ({ folder: '~/p', folder_missing: false, hidden: null, uses: [], needs: [], fields: [], lookalike: null, shell_note: null, ...extra });
const runView = (run: Partial<RunView>): RunView => ({ key: KEY, run_id: 'run_1', state: 'running', exit_code: null, signal: null, started_at: '', ended_at: null, duration_ms: 0, lines: [], total_lines: 0, partial: '', waiting_for_input: false, needs_terminal: false, error: null, interrupted: null, left_running: null, ...run });
const wire = (run: RunView | null, block: Partial<RunBlockView> = {}, secrets: RunStateWire['secrets'] = []): RunStateWire => ({ computer: 'your Mac', store: 'saved in your Keychain', shell: 'zsh', blocks: { [KEY]: blockView(block) }, runs: run ? { [KEY]: run } : {}, secrets });

const real = hasDom ? { ...runApi } : null;
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  if (!hasDom) return;
  store.resetRunStateForTests();
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Object.assign(runApi, real);
  store.resetRunStateForTests();
});

function mount(body = BODY, id = MESSAGE.id) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const block = parseInboxRunBlocks(body)[0]!;
  act(() => root!.render(<div className="pn-inbox">{runBlockFor({ id, body }, { startLine: block.startLine, directiveKind: 'run' }, 'Claude')}</div>));
}

const card = () => host!.querySelector<HTMLElement>(`[data-run-card="${KEY}"]`)!;
const main = () => host!.querySelector<HTMLButtonElement>('.ib-rb-acts button')!;
const settle = (ms: number) => act(async () => void (await Bun.sleep(ms)));
async function until(check: () => boolean, ms = 8_000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) throw new Error(`timed out; card: ${card()?.textContent}`);
    await settle(50);
  }
}

test.if(hasDom)('after Run the card moves on by itself: the time ticks, the output grows, then Done and Run again, no focus event', async () => {
  expect(document.visibilityState).not.toBe('hidden');
  let pressed = false;
  let reads = 0;
  // The computer's answers: idle, then once pressed a run that prints a line a read and ends on the fourth.
  runApi.state = async () => {
    if (!pressed) return wire(null);
    reads += 1;
    if (reads >= 4) return wire(runView({ state: 'done', exit_code: 0, duration_ms: 3_200, lines: ['step 1', 'step 2', 'step 3'], total_lines: 3 }));
    return wire(runView({ duration_ms: reads * 1_000, lines: Array.from({ length: reads }, (_, i) => `step ${i + 1}`), total_lines: reads }));
  };
  runApi.start = async () => {
    pressed = true;
    return { ok: true };
  };
  mount();
  await until(() => main().textContent === 'Run' && !main().disabled);
  const button = main();
  act(() => button.focus());
  act(() => button.click());
  await until(() => card().dataset.runState === 'running');
  const seen = new Set<string>();
  await until(() => {
    seen.add(card().querySelector('[data-run-status] > span[aria-hidden="true"]:not(.ib-rb-dot)')?.textContent ?? '');
    return card().dataset.runState === 'done';
  });
  // It ticked through the seconds and the lines as they came, without anyone focusing the window.
  expect([...seen].filter((text) => text.startsWith('Running ·')).length).toBeGreaterThanOrEqual(2);
  expect(card().querySelector('.ib-rb-lines')!.textContent).toBe('step 1\nstep 2\nstep 3');
  expect(main().textContent).toBe('Run again');
  // The live region says Done, and keyboard focus stayed on the one button through Run, Stop and Run again.
  expect(card().querySelector('[aria-live="polite"]')!.textContent).toBe('Done · exit code 0 · 3.2 s');
  expect(main()).toBe(button);
  expect(document.activeElement).toBe(button);
}, 20_000);

test.if(hasDom)('a run pressed on another device shows on a card that is open here, with no focus event', async () => {
  let reads = 0;
  runApi.state = async () => {
    reads += 1;
    if (reads === 1) return wire(null);
    if (reads === 2) return wire(runView({ duration_ms: 500, lines: ['from the phone'], total_lines: 1 }));
    return wire(runView({ state: 'done', exit_code: 0, duration_ms: 1_000, lines: ['from the phone'], total_lines: 1 }));
  };
  mount();
  await until(() => main().textContent === 'Run');
  await until(() => card().dataset.runState === 'running', store.RUN_IDLE_POLL_MS + 2_000);
  await until(() => card().dataset.runState === 'done', 3_000);
  expect(card().textContent).toContain('from the phone');
}, 20_000);

test.if(hasDom)('a double click starts one run and says nothing about it already running', async () => {
  let starts = 0;
  let pressed = false;
  runApi.state = async () => (pressed ? wire(runView({ duration_ms: 100 })) : wire(null));
  runApi.start = async () => {
    starts += 1;
    pressed = true;
    await Bun.sleep(30);
    return { ok: true };
  };
  mount();
  await until(() => main().textContent === 'Run' && !main().disabled);
  act(() => {
    main().click();
    main().click();
  });
  await until(() => card().dataset.runState === 'running');
  expect(starts).toBe(1);
  expect(card().querySelector('[data-run-note]')!.textContent).toBe('');
});

test.if(hasDom)('a needed secret not saved: Run waits for it, and "Save and run" saves it and runs in one press', async () => {
  const body = [':::run', 'Pay', 'Uses: PAY_KEY', '', '```sh', 'bun test pay', '```', ':::'].join('\n');
  const key = parseInboxRunBlocks(body)[0]!.key;
  const calls: string[] = [];
  let saved = false;
  runApi.state = async () => ({ ...wire(null), blocks: { [key]: blockView({ uses: ['PAY_KEY'], needs: saved ? [] : ['PAY_KEY'], fields: saved ? [] : ['PAY_KEY'] }) }, runs: calls.includes('start') ? { [key]: { ...runView({ duration_ms: 100 }), key } } : {} });
  runApi.start = async () => (calls.push('start'), { ok: true });
  runApi.saveSecret = async (_id, name, value) => {
    calls.push(`save ${name}=${value.length}`);
    saved = true;
    return { ok: true };
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox">{runBlockFor({ id: 'msg_live_2', body }, { startLine: 1, directiveKind: 'run' }, 'Claude')}</div>));
  const run = () => host!.querySelector<HTMLButtonElement>('.ib-rb-acts button')!;
  await until(() => !!host!.querySelector('[data-secret-save]'));
  expect(run().getAttribute('aria-disabled')).toBe('true');
  act(() => run().click());
  await settle(30);
  expect(calls).toEqual([]);
  const save = host!.querySelector<HTMLButtonElement>('[data-secret-save]')!;
  expect(save.textContent).toBe('Save and run');
  const input = host!.querySelector<HTMLInputElement>('[data-secret-input]')!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'TEST_ONLY_NOT_A_KEY_123');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => save.click());
  await until(() => calls.includes('start'));
  expect(calls).toEqual(['save PAY_KEY=23', 'start']);
  // Focus is on the run's button (now Stop), not dropped to the page.
  await until(() => host!.querySelector('[data-run-stop]') !== null);
  expect(document.activeElement).toBe(run());
}, 20_000);

test.if(hasDom)('after Save, focus moves to Replace (the control that takes the field’s place)', async () => {
  const body = [':::secret', 'API_TOKEN', 'The check needs it.', ':::'].join('\n');
  let saved = false;
  runApi.state = async () => ({ ...wire(null), blocks: {}, secrets: saved ? [{ name: 'API_TOKEN', saved_at: '2026-11-18T10:00:00.000Z', store: 'keychain' }] : [] });
  runApi.saveSecret = async () => {
    saved = true;
    return { ok: true };
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox">{runBlockFor({ id: 'msg_live_3', body }, { startLine: 1, directiveKind: 'secret' }, 'Claude')}</div>));
  await until(() => !!host!.querySelector('[data-secret-input]') && host!.textContent!.includes('Keychain'));
  const input = host!.querySelector<HTMLInputElement>('[data-secret-input]')!;
  act(() => input.focus());
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'TEST_ONLY_NOT_A_KEY_123');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await until(() => !!host!.querySelector('[data-secret-replace]'));
  expect(document.activeElement).toBe(host!.querySelector('[data-secret-replace]'));
});
