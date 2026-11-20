/**
 * The Run and Secret cards live, in a DOM, against a fake computer whose answers change from one read to the next.
 * What regresses: a card that reads its state once after Run and then freezes ("Running · 0 s", the first line,
 * Stop after the end) until the window is focused again; a run pressed on another device never showing on an open
 * card; keyboard focus dropping to the page when Run becomes Stop, when the run ends and after Save; a double click
 * starting a second run or saying it is already running; and a run that needs an unsaved secret running anyway.
 *
 * No focus or visibility event is sent anywhere here: each card must move on by itself. What a card costs is
 * counted too: a thread of fifty idle run cards reads nothing after each card's first read (the Inbox's `runs`
 * event says when one changed), a card off screen reads nothing, a hidden window reads nothing, and a thread
 * closed and opened again reads fresh state. Poll times are shortened here (resetRunStateForTests), so nothing
 * waits on a real 500 ms or 5 s timer.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxRunBlocks } from '@plannotator/core/inbox-run-blocks';
import type { RunBlockView, RunStateWire, RunView } from './data/runApi';
import { runEvents } from './data/runEvents';

const hasDom = typeof document !== 'undefined';
const { runApi } = (hasDom ? await import('./data/runApi') : {}) as typeof import('./data/runApi');
const store = (hasDom ? await import('./data/runStore') : {}) as typeof import('./data/runStore');
const { runBlockFor } = (hasDom ? await import('./parts/RunBlocks/RunBlock') : {}) as typeof import('./parts/RunBlocks/RunBlock');

const BODY = [':::run', 'Print progress', 'Five steps.', '', '```sh', 'for i in 1 2 3; do echo step $i; sleep 1; done', '```', ':::'].join('\n');
const KEY = parseInboxRunBlocks(BODY)[0]!.key;
const MESSAGE = { id: 'msg_live_1', body: BODY };

const blockView = (extra: Partial<RunBlockView> = {}): RunBlockView => ({ folder: '~/p', folder_missing: false, hidden: null, uses: [], needs: [], fields: [], lookalike: null, shell_note: null, ...extra });
const runView = (run: Partial<RunView>): RunView => ({ key: KEY, run_id: 'run_1', state: 'running', exit_code: null, signal: null, started_at: '', ended_at: null, duration_ms: 0, lines: [], total_lines: 0, partial: '', waiting_for_input: false, needs_terminal: false, error: null, interrupted: null, left_running: null, ...run });
const wire = (run: RunView | null, block: Partial<RunBlockView> = {}, secrets: RunStateWire['secrets'] = []): RunStateWire => ({ computer: 'your Mac', store: 'in your Keychain', kept: "Saved to your Mac's Keychain.", shell: 'zsh', blocks: { [KEY]: blockView(block) }, runs: run ? { [KEY]: run } : {}, secrets });

const real = hasDom ? { ...runApi } : null;
let root: Root | null = null;
let host: HTMLElement | null = null;

/** A stand-in IntersectionObserver the test drives: every card is on screen when observed, unless `offScreen`. */
const observed = new Map<Element, (entries: { target: Element; isIntersecting: boolean }[]) => void>();
let offScreen = false;
class FakeIntersectionObserver {
  constructor(private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
  observe(target: Element) {
    observed.set(target, this.callback);
    const callback = this.callback;
    const intersecting = !offScreen;
    queueMicrotask(() => callback([{ target, isIntersecting: intersecting }]));
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {}
}
const scrollTo = (target: Element, on: boolean) => act(() => observed.get(target)?.([{ target, isIntersecting: on }]));
const realObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
if (hasDom) (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
afterAll(() => {
  if (realObserver) Object.defineProperty(globalThis, 'IntersectionObserver', realObserver);
  else delete (globalThis as Record<string, unknown>).IntersectionObserver;
});

beforeEach(() => {
  if (!hasDom) return;
  offScreen = false;
  store.resetRunStateForTests({ poll: 40, idle: 120 });
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

test.if(hasDom)('a run pressed on another device shows on a card that is open here: the Inbox says so, no focus event, no idle poll', async () => {
  let pressedElsewhere = false;
  let reads = 0;
  runApi.state = async () => {
    reads += 1;
    if (!pressedElsewhere) return wire(null);
    return reads < 6 ? wire(runView({ duration_ms: 500, lines: ['from the phone'], total_lines: 1 })) : wire(runView({ state: 'done', exit_code: 0, duration_ms: 1_000, lines: ['from the phone'], total_lines: 1 }));
  };
  mount();
  await until(() => main().textContent === 'Run');
  // Idle, it reads nothing more however long it waits.
  const idle = reads;
  await settle(400);
  expect(reads).toBe(idle);
  // A phone pressed Run: the Inbox's `runs` event names this message, and the card reads and follows the run.
  pressedElsewhere = true;
  act(() => runEvents.emit({ message_ids: [MESSAGE.id] }));
  await until(() => card().dataset.runState === 'running', 2_000);
  await until(() => card().dataset.runState === 'done', 2_000);
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
  const kept = host!.querySelector('[data-secret-kept]')!.textContent!;
  expect(kept).toContain("your Mac's Keychain");
  expect(kept).toContain('Claude');
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
  await until(() => host!.querySelector('[data-run-card-stop]') !== null);
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
  // After Save the card names the same store it named before.
  expect(host!.querySelector('[data-secret-detail]')!.textContent).toMatch(/ · in your Keychain$/);
});

/** A thread of `count` agent messages, each with one run card. */
function mountThread(count: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const messages = Array.from({ length: count }, (_, i) => ({ id: `msg_t_${i}`, body: BODY }));
  const startLine = parseInboxRunBlocks(BODY)[0]!.startLine;
  act(() => root!.render(<div className="pn-inbox">{messages.map((m) => <div key={m.id}>{runBlockFor(m, { startLine, directiveKind: 'run' }, 'Claude')}</div>)}</div>));
  return messages;
}

test.if(hasDom)('fifty idle run cards in one thread: one read each when they come on screen, then none (the measurement)', async () => {
  const reads: string[] = [];
  runApi.state = async (id) => (reads.push(id), wire(null));
  mountThread(50);
  await until(() => reads.length === 50, 2_000);
  // Idle: a long wait (many times the shortened poll) reads nothing. Before: one read per message every 3 s (about
  // 17 a second for this thread, forever). Now: none.
  reads.length = 0;
  await settle(600);
  expect(reads).toEqual([]);
  // One changes (a run started from a phone): only that one reads.
  act(() => runEvents.emit({ message_ids: ['msg_t_7'] }));
  await settle(60);
  expect(reads).toEqual(['msg_t_7']);
  // A secret saved anywhere (`all`): each card on screen reads once.
  reads.length = 0;
  act(() => runEvents.emit({ all: true }));
  await settle(60);
  expect(reads.length).toBe(50);
}, 20_000);

test.if(hasDom)('a card off screen reads nothing, even while its command runs, until it is scrolled to; a hidden window reads nothing', async () => {
  const reads: string[] = [];
  runApi.state = async (id) => (reads.push(id), wire(runView({ duration_ms: 100 })));
  offScreen = true;
  mount();
  await settle(300);
  expect(reads).toEqual([]);
  // Scrolled to: it reads at once, and polls while its command runs.
  scrollTo(card(), true);
  await until(() => reads.length >= 3, 2_000);
  // Scrolled away again: the poll stops.
  scrollTo(card(), false);
  await settle(80);
  const away = reads.length;
  await settle(300);
  expect(reads.length).toBe(away);
  // On screen, but the window hidden: no reads.
  scrollTo(card(), true);
  await settle(80);
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState') ?? Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  try {
    // A poll already on its way may land once; after that, nothing.
    await settle(200);
    const hidden = reads.length;
    await settle(300);
    expect(reads.length).toBe(hidden);
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  }
}, 20_000);

test.if(hasDom)('a thread closed and opened again reads fresh state: the old one is never shown, and nothing is kept', async () => {
  let answer: RunStateWire = wire(runView({ state: 'done', exit_code: 0, duration_ms: 1_000, lines: ['old'], total_lines: 1 }));
  runApi.state = async () => answer;
  mount();
  await until(() => card().dataset.runState === 'done');
  act(() => root!.unmount());
  host!.remove();
  await settle(20);
  expect(store.runStateEntriesForTests()).toBe(0);
  answer = wire(null);
  let release: () => void = () => {};
  runApi.state = () => new Promise((resolve) => (release = () => resolve(answer)));
  mount();
  // Before the fresh read lands, it is not the old "Done".
  expect(card().dataset.runState).toBe('idle');
  release();
  await settle(20);
  expect(card().dataset.runState).toBe('idle');
});

test.if(hasDom)('"Save it above" or "below": where the one field truly is', async () => {
  const secretBody = [':::secret', 'PAY_KEY', 'For the payment tests.', ':::'].join('\n');
  const runBody = [':::run', 'Pay', 'Uses: PAY_KEY', '', '```sh', 'bun test pay', '```', ':::'].join('\n');
  const runKey = parseInboxRunBlocks(runBody)[0]!.key;
  runApi.state = async (id) => ({ ...wire(null), blocks: id === 'msg_run' ? { [runKey]: blockView({ uses: ['PAY_KEY'], needs: ['PAY_KEY'], fields: [] }) } : {} });
  const draw = (order: 'secret-first' | 'run-first') => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const secret = <div key="s">{runBlockFor({ id: 'msg_secret', body: secretBody }, { startLine: 1, directiveKind: 'secret' }, 'Claude')}</div>;
    const runCard = <div key="r">{runBlockFor({ id: 'msg_run', body: runBody }, { startLine: 1, directiveKind: 'run' }, 'Claude')}</div>;
    act(() => root!.render(<div className="pn-inbox">{order === 'secret-first' ? [secret, runCard] : [runCard, secret]}</div>));
  };
  const go = () => host!.querySelector('[data-run-needs-go]')?.textContent;
  draw('secret-first');
  await until(() => go() === 'Save it above', 2_000);
  act(() => root!.unmount());
  host!.remove();
  draw('run-first');
  await until(() => go() === 'Save it below', 2_000);
});

test.if(hasDom)('a command taller than its box fades at its foot until it is scrolled to the end (it says it scrolls)', async () => {
  runApi.state = async () => wire(null);
  const size = { scroll: 1_000, client: 200, top: 0 };
  const real = ['scrollHeight', 'clientHeight', 'scrollTop'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name)] as const);
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => size.scroll });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => size.client });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get: () => size.top, set: () => {} });
  try {
    mount();
    const box = () => host!.querySelector<HTMLElement>('[data-run-command]')!;
    expect(box().hasAttribute('data-more')).toBe(true);
    size.top = 800;
    act(() => void box().dispatchEvent(new Event('scroll')));
    expect(box().hasAttribute('data-more')).toBe(false);
  } finally {
    for (const [name, descriptor] of real) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
});

test.if(hasDom)('a Save reads each card once: the Inbox\'s own event for it, heard meanwhile, is not read again', async () => {
  const secretBody = [':::secret', 'PAY_KEY', 'For the payment tests.', ':::'].join('\n');
  const reads: string[] = [];
  runApi.state = async (id) => (reads.push(id), { ...wire(null), blocks: {} });
  runApi.saveSecret = async () => {
    // The server says every card changed before its answer reaches this window.
    runEvents.emit({ all: true });
    await Bun.sleep(5);
    return { ok: true };
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox">{runBlockFor({ id: 'msg_s', body: secretBody }, { startLine: 1, directiveKind: 'secret' }, 'Claude')}{runBlockFor({ id: 'msg_r', body: BODY }, { startLine: parseInboxRunBlocks(BODY)[0]!.startLine, directiveKind: 'run' }, 'Claude')}</div>));
  await until(() => reads.length === 2 && !!host!.querySelector('[data-secret-input]'));
  reads.length = 0;
  const input = host!.querySelector<HTMLInputElement>('[data-secret-input]')!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'TEST_ONLY_NOT_A_KEY_123');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle(200);
  expect(reads.sort()).toEqual(['msg_r', 'msg_s']);
  // Another window's save later is still heard.
  act(() => runEvents.emit({ all: true }));
  await settle(60);
  expect(reads.length).toBe(4);
});

test.if(hasDom)('after Open in terminal, the note names only the secrets not set there: a name from the shell is', async () => {
  runApi.state = async () => wire(null, { uses: ['OPENAI_API_KEY', 'PAY_KEY'], from_shell: ['OPENAI_API_KEY'] });
  runApi.terminal = async () => ({ ok: true, terminal: 'Terminal', copied: true });
  mount();
  await until(() => !host!.querySelector<HTMLButtonElement>('[data-run-terminal]')!.disabled);
  act(() => host!.querySelector<HTMLButtonElement>('[data-run-terminal]')!.click());
  await until(() => card().textContent!.includes('Opened Terminal'), 3_000);
  expect(card().textContent).toContain("PAY_KEY isn't set in that terminal.");
  expect(card().textContent).not.toContain('OPENAI_API_KEY and');
});

/** A secret's message (its own React root, as another message is) that folds and opens, and a run card after it. */
async function foldingThread() {
  const secretBody = [':::secret', 'PAY_KEY', 'For the payment tests.', ':::'].join('\n');
  const runBody = [':::run', 'Pay', 'Uses: PAY_KEY', '', '```sh', 'bun test pay', '```', ':::'].join('\n');
  const runKey = parseInboxRunBlocks(runBody)[0]!.key;
  runApi.state = async (id) => ({ ...wire(null), blocks: id === 'msg_run' ? { [runKey]: blockView({ uses: ['PAY_KEY'], needs: ['PAY_KEY'], fields: [], field_at: { PAY_KEY: 'msg_secret' } }) } : {} });
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const above = document.createElement('div');
  const below = document.createElement('div');
  host.append(above, below);
  const secretRoot = createRoot(above);
  root = createRoot(below);
  const draw = (shown: 'open' | 'folded' | 'hidden') =>
    act(() =>
      secretRoot.render(
        shown === 'open' ? (
          <article data-message-article="msg_secret">{runBlockFor({ id: 'msg_secret', body: secretBody }, { startLine: 1, directiveKind: 'secret' }, 'Claude')}</article>
        ) : shown === 'folded' ? (
          <article data-message-article="msg_secret" data-folded="">
            <button type="button" data-fold-head="" onClick={() => draw('open')}>Claude: For the payment tests.</button>
          </article>
        ) : null,
      ),
    );
  draw('open');
  act(() => root!.render(<article data-message-article="msg_run">{runBlockFor({ id: 'msg_run', body: runBody }, { startLine: 1, directiveKind: 'run' }, 'Claude')}</article>));
  const go = () => host!.querySelector<HTMLButtonElement>('[data-run-needs-go]');
  await until(() => go()?.textContent === 'Save it above', 2_000);
  return { draw, go, secretRoot };
}

test.if(hasDom)('the field\'s message folding or leaving the page changes "Save it …" on the other card with no redraw of it', async () => {
  const { draw, go, secretRoot } = await foldingThread();
  try {
    // Folded to its line, it is still above.
    draw('folded');
    await settle(40);
    expect(go()!.textContent).toBe('Save it above');
    // Hidden behind "N earlier messages": not on the page, so "in its card".
    draw('hidden');
    await until(() => go()!.textContent === 'Save it in its card', 1_000);
    draw('open');
    await until(() => go()!.textContent === 'Save it above', 1_000);
  } finally {
    act(() => secretRoot.unmount());
  }
});

test.if(hasDom)('"Save it above" with the field\'s message folded: that message opens, and its field takes focus', async () => {
  const { draw, go, secretRoot } = await foldingThread();
  try {
    draw('folded');
    await settle(40);
    expect(host!.querySelector('[data-secret-input]')).toBeNull();
    act(() => go()!.click());
    await until(() => document.activeElement === host!.querySelector('[data-secret-input]'), 2_000);
    expect(host!.querySelector('[data-message-article="msg_secret"]')!.hasAttribute('data-folded')).toBe(false);
  } finally {
    act(() => secretRoot.unmount());
  }
});
