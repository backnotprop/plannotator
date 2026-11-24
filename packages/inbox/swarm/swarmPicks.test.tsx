/**
 * New message's other picks and the Swarm badge (swarm/useSwarmPicks.tsx). What this catches: a second agent that
 * replaces the first instead of joining it; a badge that is not there, quiet, once To has one agent; a second agent
 * (or a new agent being started) that does not play the Gather once, or a badge that rests on after it (the owner: "it
 * appears, then rests off until I turn it on"); a badge whose state is not the words' `/swarm` (a press that does not
 * put it in or take it out, typed `/swarm` that does not light it); a Send that drops the other agents; a pick that cannot be undone from the same picker; Add an agent offering computers
 * whose agents cannot work in the thread, or not offering them once they can (`swarmCanJoin`); and the first-time card
 * shown when the Inbox says it was shown already, or not going at the badge's press.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComposeTarget } from '../compose/model';
import { HERE, type ToMachine } from '../compose/toMachines';
import { SWARM_ACROSS_COMPUTERS, swarmCanJoin } from './model';
import { SWARM_SETTLE_AT_MS, SWARM_SETTLE_MS } from './swarmBadgeMotion';

const hasDom = typeof document !== 'undefined';
const { useSwarmPicks } = (hasDom ? await import('./useSwarmPicks') : {}) as typeof import('./useSwarmPicks');
const { resetSwarmTipForTests } = (hasDom ? await import('./useSwarmTip') : {}) as typeof import('./useSwarmTip');

const project = { id: 'prj_1', name: 'ledger', root: '/work/ledger' };
const session = (id: string, host: string): ComposeTarget => ({ session: id, host, started_at: '2026-11-24T10:00:00.000Z', last_seen_at: '2026-11-24T10:05:00.000Z', busy: false, idle_since: null, last_thread: null, root: project.root, project });
const CLAUDE = session('ses_claude', 'claude-code');
const CODEX = session('ses_codex', 'codex');
const PI = session('ses_pi', 'pi');
const FAR = session('ses_far', 'codex');
const HERE_MACHINE: ToMachine = { key: HERE, machine: null, name: 'This computer', self: true, asleep: false, since: null, home: '/home/charlie', groups: [{ project, current: true, sessions: [CLAUDE, CODEX, PI] }], launch: null, notice: null };
const FAR_MACHINE: ToMachine = { key: 'ibx_far', machine: 'ibx_far', name: 'Studio Mac', self: false, asleep: false, since: null, home: '/home/charlie', groups: [{ project, current: true, sessions: [FAR] }], launch: null, notice: null };

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: ReturnType<typeof useSwarmPicks> | null = null;
let claims: unknown[] = [];
let shown = true;
const realFetch = globalThis.fetch;

const TARGETS: Record<string, ComposeTarget> = { [CLAUDE.session]: CLAUDE, [CODEX.session]: CODEX, [PI.session]: PI };
let words = '';
let setWordsFrom: ((text: string) => void) | null = null;

function Harness({ first, starting, across, machines }: { first: string | null; starting: boolean; across?: boolean; machines: ToMachine[] }) {
  const [text, setText] = useState('Split the refunds work.');
  words = text;
  setWordsFrom = setText;
  const swarm = useSwarmPicks({
    first: first ? { session: first, machineKey: HERE, target: TARGETS[first]! } : null,
    starting: starting ? { name: 'Codex', where: 'ledger', machineKey: HERE } : null,
    machines,
    home: '/home/charlie',
    phone: false,
    host: null,
    after: () => {},
    words: text,
    setWords: (change) => setText(change),
    across,
  });
  latest = swarm;
  return (
    <div className="pn-inbox">
      <div className="ib-cp-to">{swarm.row}</div>
      {swarm.picker}
    </div>
  );
}

function render(first: string | null, options: { across?: boolean; machines?: ToMachine[]; starting?: boolean } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness first={first} starting={options.starting ?? false} across={options.across} machines={options.machines ?? [HERE_MACHINE]} />);
  });
  return host;
}

function rerender(first: string | null, options: { starting?: boolean } = {}) {
  act(() => root!.render(<Harness first={first} starting={options.starting ?? false} machines={[HERE_MACHINE]} />));
}

/** The person types into the words (the composer's own field). */
const type = (text: string) => act(() => setWordsFrom!(text));

beforeEach(() => {
  if (!hasDom) return;
  resetSwarmTipForTests();
  claims = [];
  shown = true;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/reveal')) {
      claims.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ show: shown, reveal: { next: null }, board: { on: false }, steps: { on: false } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  globalThis.fetch = realFetch;
});

const add = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-compose-add-agent]');
const badge = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-swarm-badge]');
const pickRow = (el: HTMLElement, id: string) => {
  const row = el.querySelector<HTMLElement>(`[data-compose-session="${id}"]`);
  if (!row) throw new Error(`no picker row for ${id}`);
  act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};
const press = (button: HTMLElement | null) => act(() => button!.click());
const settleTip = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, SWARM_SETTLE_AT_MS + SWARM_SETTLE_MS + 100));
  });
};

const look = (el: HTMLElement) => badge(el)?.closest('.ib-sw-slot')?.getAttribute('data-state') ?? null;

test.skipIf(!hasDom)('no first pick: no Add an agent and no badge', () => {
  const el = render(null);
  expect(add(el)).toBeNull();
  expect(badge(el)).toBeNull();
  expect(latest!.send).toEqual({});
});

test.skipIf(!hasDom)('one agent in To: the badge is there, quiet and off, with no Gather; a press swarms with one agent', () => {
  const el = render(CLAUDE.session);
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  expect(look(el)).toBe('off');
  press(badge(el));
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
  expect(words).toBe('Split the refunds work. /swarm ');
});

test.skipIf(!hasDom)('a second agent joins the first and plays the Gather once, then the badge rests off; Send carries every agent', async () => {
  const el = render(CLAUDE.session);
  press(add(el));
  // The first pick's row is checked in the same picker; picking it again changes nothing.
  pickRow(el, CLAUDE.session);
  expect(latest!.picks).toHaveLength(0);
  expect(look(el)).toBe('off');
  press(add(el));
  pickRow(el, CODEX.session);
  expect(el.querySelector('[data-compose-also="ses_codex"]')).not.toBeNull();
  // The Gather: on to look at for a moment, never pressed.
  expect(look(el)).toBe('on');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  await settleTip();
  expect(look(el)).toBe('off');
  expect(latest!.send).toEqual({ tags: [{ host: 'codex', session: 'ses_codex' }] });
  // A third agent plays nothing more.
  press(add(el));
  pickRow(el, PI.session);
  expect(look(el)).toBe('off');
  expect(latest!.send).toEqual({ tags: [{ host: 'codex', session: 'ses_codex' }, { host: 'pi', session: 'ses_pi' }] });});

test.skipIf(!hasDom)('a new agent being started plays the Gather once too', async () => {
  const el = render(null);
  expect(badge(el)).toBeNull();
  rerender(null, { starting: true });
  expect(look(el)).toBe('on');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  await settleTip();
  expect(look(el)).toBe('off');});

test.skipIf(!hasDom)('the badge IS the words\' /swarm: a press puts it in, another takes it out, and typing it lights the badge', () => {
  const el = render(CLAUDE.session);
  press(add(el));
  pickRow(el, CODEX.session);
  press(badge(el));
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
  expect(words).toBe('Split the refunds work. /swarm ');
  press(badge(el));
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  expect(words.trim()).toBe('Split the refunds work.');
  type('Please $swarm on the refunds');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
  press(badge(el));
  expect(words).toBe('Please on the refunds');
  type('Read /work/swarm/notes first');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
});

test.skipIf(!hasDom)('a checked row picked again takes that agent out; the badge stays, and the words keep /swarm', () => {
  const el = render(CLAUDE.session);
  press(add(el));
  pickRow(el, CODEX.session);
  press(badge(el));
  press(add(el));
  expect(el.querySelector('[data-compose-session="ses_codex"] .ib-cp-check svg')).not.toBeNull();
  pickRow(el, CODEX.session);
  expect(latest!.picks).toHaveLength(0);
  expect(latest!.send).toEqual({});
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');});

test('swarmCanJoin: the first pick\'s computer only until agents can work across computers; then every one', () => {
  expect(SWARM_ACROSS_COMPUTERS).toBe(false);
  expect(swarmCanJoin(HERE, HERE)).toBe(true);
  expect(swarmCanJoin(HERE, 'ibx_far')).toBe(false);
  expect(swarmCanJoin('ibx_far', 'ibx_far', false)).toBe(true);
  expect(swarmCanJoin(HERE, 'ibx_far', true)).toBe(true);
  expect(swarmCanJoin('ibx_far', HERE, true)).toBe(true);
});

test.skipIf(!hasDom)('Add an agent offers the computers swarmCanJoin allows: this one today, both once across is on', () => {
  render(CLAUDE.session, { machines: [HERE_MACHINE, FAR_MACHINE] });
  expect(latest!.machines.map((m) => m.key)).toEqual([HERE]);
  act(() => root?.unmount());
  host?.remove();
  render(CLAUDE.session, { machines: [HERE_MACHINE, FAR_MACHINE], across: true });
  expect(latest!.machines.map((m) => m.key)).toEqual([HERE, 'ibx_far']);
});

test.skipIf(!hasDom)('the first-time card: claimed once the Gather has settled, gone at the badge\'s press, never claimed twice on a page', async () => {
  const el = render(CLAUDE.session);
  // The quiet badge with one agent claims nothing.
  await settleTip();
  expect(claims).toEqual([]);
  press(add(el));
  pickRow(el, CODEX.session);
  expect(el.querySelector('[data-swarm-tip]')).toBeNull();
  await settleTip();
  expect(claims).toEqual([expect.objectContaining({ id: 'swarm_tip' })]);
  expect(el.querySelector('[data-swarm-tip]')).not.toBeNull();
  press(badge(el));
  expect(el.querySelector('[data-swarm-tip]')).toBeNull();
  // A second agent taken out and another added (a second Gather): no second claim.
  press(add(el));
  pickRow(el, CODEX.session);
  press(add(el));
  pickRow(el, PI.session);
  await settleTip();
  expect(claims).toHaveLength(1);
}, 15_000);

test.skipIf(!hasDom)('the Inbox says it was shown already (another window, the phone): no card', async () => {
  shown = false;
  const el = render(CLAUDE.session);
  press(add(el));
  pickRow(el, CODEX.session);
  await settleTip();
  expect(claims).toHaveLength(1);
  expect(el.querySelector('[data-swarm-tip]')).toBeNull();
});
