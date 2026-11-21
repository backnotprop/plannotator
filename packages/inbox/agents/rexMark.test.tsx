/**
 * The Rex status marks on agents' icons (agents/rexMark.tsx). What this catches: a state drawn as another, or its
 * words wrong or shown as visible text; a mark on an agent that has none (not started in Rex, a stale record): its
 * icon must be exactly today's; a mark that stays once its record is gone; motion under reduced motion (a change must
 * simply swap the mark); a mark that pops at page load; the sidebar's mark missing; a pile whose waiting marks do not
 * gather on its outer corner side by side, gather the done ones too, or cover its "+N" chip.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: the agents list is set.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxRexMark } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
let reduce = false;
if (hasDom) {
  const query = (media: string) => ({ media, matches: media.includes('reduced-motion') ? reduce : false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
  Element.prototype.animate = function () {
    const finished = Promise.resolve();
    return { currentTime: 0, playbackRate: 1, finished, playState: 'running', play() {}, pause() {}, cancel() {}, finish() {} } as unknown as Animation;
  } as typeof Element.prototype.animate;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { HostMark } = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { layoutRexPile, REX_MARK_WORDS } = (hasDom ? await import('./rexMark') : {}) as typeof import('./rexMark');

let root: Root | null = null;
let realFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  reduce = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ faces: {}, rev: 0 })) as unknown as typeof fetch;
  window.localStorage.clear();
  (motion as unknown as { agentMotionOptions: { simulatedDom: boolean } }).agentMotionOptions.simulatedDom = true;
  setInboxAgents(null);
  faces.resetAgentFaces();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  setInboxAgents(null);
  faces.resetAgentFaces();
});

const agent = (id: string, mark?: InboxRexMark): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_bill', name: 'billing-svc' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...(mark ? { rex_mark: mark } : {}) });
const list = (agents: InboxAgent[]): InboxAgentsGroup[] => [{ agents, total: agents.length, ended_today: 0 }];

function draw(node: React.ReactNode) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

test.skipIf(!hasDom)('each status draws its own mark, named by the state words as its text alternative only (no words shown)', () => {
  const cases: [InboxRexMark, string, string][] = [
    [{ state: 'working' }, 'working', 'Working'],
    [{ state: 'blocked', kind: 'question' }, 'question', 'Asking a question'],
    [{ state: 'blocked', kind: 'permission' }, 'permission', 'Asking for permission'],
    [{ state: 'blocked', kind: 'auth' }, 'signin', 'Needs sign-in'],
    [{ state: 'done' }, 'done', 'Done'],
    [{ state: 'idle' }, 'idle', 'Idle'],
    [{ state: 'error' }, 'error', 'Stopped on an error'],
  ];
  setInboxAgents(list(cases.map(([mark], i) => agent(`ses_${i}`, mark))));
  const el = draw(
    <>
      {cases.map((_, i) => (
        <HostMark key={i} host="claude-code" agent={`ses_${i}`} />
      ))}
    </>,
  );
  const marks = [...el.querySelectorAll<HTMLElement>('.ib-rxm')];
  expect(marks.map((m) => [m.dataset.rxState, m.getAttribute('aria-label'), m.getAttribute('title'), m.getAttribute('role')])).toEqual(cases.map(([, state, words]) => [state, words, words, 'img']));
  // The mark sits inside the icon's own box (so every place that lays an icon out keeps its layout).
  expect(marks.every((m) => m.parentElement!.classList.contains('ib-mk'))).toBe(true);
  // Waiting kinds are the ones that wait (and gather in a pile).
  expect(marks.filter((m) => m.hasAttribute('data-rx-wait')).map((m) => m.dataset.rxState)).toEqual(['question', 'permission', 'signin']);
  expect(el.textContent).toBe('');
  expect(REX_MARK_WORDS.working).toBe('Working');
});

test.skipIf(!hasDom)("an agent with no mark (not started in Rex, or its record stale) has exactly today's icon; a mark goes when its record does", () => {
  const plain = draw(<HostMark host="claude-code" agent="ses_a" />).innerHTML;
  act(() => root!.unmount());
  document.body.innerHTML = '';
  setInboxAgents(list([agent('ses_a'), agent('ses_b', { state: 'working' })]));
  const el = draw(
    <>
      <HostMark host="claude-code" agent="ses_a" />
      <HostMark host="claude-code" />
      <HostMark host="claude-code" agent="ses_b" />
    </>,
  );
  const [a, kind, b] = [...el.children] as HTMLElement[];
  expect(a!.outerHTML).toBe(plain);
  expect(kind!.querySelector('.ib-rxm')).toBeNull();
  expect(b!.querySelector('.ib-rxm')).not.toBeNull();
  // The next list has no record for it (stale, or not in Rex any more): today's icon again.
  act(() => setInboxAgents(list([agent('ses_a'), agent('ses_b')])));
  expect(el.querySelector('.ib-rxm')).toBeNull();
  expect((el.children[2] as HTMLElement).outerHTML).toBe(plain);
});

test.skipIf(!hasDom)('at rest when a page loads; a change arrives, and an answered wait pops with a check as the next one comes in', async () => {
  setInboxAgents(list([agent('ses_a', { state: 'blocked', kind: 'permission' })]));
  const el = draw(<HostMark host="claude-code" agent="ses_a" />);
  expect(el.querySelector('[data-rx-arrive]')).toBeNull();
  act(() => setInboxAgents(list([agent('ses_a', { state: 'working' })])));
  const out = el.querySelector<HTMLElement>('.ib-rxm-l[data-rx-out]')!;
  expect(out.dataset.rxOut).toBe('answered');
  // The going mark keeps its shape, with the check for a glyph.
  expect(out.dataset.rx).toBe('permission');
  expect(el.querySelector<HTMLElement>('.ib-rxm-l:not([data-rx-out])')!.dataset.rxArrive).toBe('late');
  act(() => setInboxAgents(list([agent('ses_a', { state: 'blocked', kind: 'question' })])));
  expect(el.querySelector<HTMLElement>('.ib-rxm-l:not([data-rx-out])')!.dataset.rxArrive).toBe('now');
});

test.skipIf(!hasDom)('reduced motion: a change simply swaps the mark (nothing arrives, nothing goes), and a pile never spreads', () => {
  reduce = true;
  setInboxAgents(list([agent('ses_a', { state: 'blocked', kind: 'question' })]));
  const el = draw(<HostMark host="claude-code" agent="ses_a" />);
  act(() => setInboxAgents(list([agent('ses_a', { state: 'done' })])));
  expect(el.querySelectorAll('.ib-rxm-l')).toHaveLength(1);
  expect(el.querySelector('[data-rx-arrive], [data-rx-out]')).toBeNull();
  expect(el.querySelector<HTMLElement>('.ib-rxm')!.dataset.rxState).toBe('done');
});

test.skipIf(!hasDom)("the sidebar's mark: on its animated icon's corner, in the sidebar's place; none for an agent not in Rex", async () => {
  setInboxAgents(list([agent('ses_a', { state: 'blocked', kind: 'auth' }), agent('ses_b')]));
  const el = draw(
    <div className="ib-sbagent">
      <AgentMark id="ses_a" host="claude-code" name="a" agent={{ id: 'ses_a', session: 'ses_a' }} />
      <AgentMark id="ses_b" host="claude-code" name="b" agent={{ id: 'ses_b', session: 'ses_b' }} />
    </div>,
  );
  await settle();
  const [a, b] = [...el.querySelectorAll<HTMLElement>('.am-btn')];
  const mark = a!.querySelector<HTMLElement>(':scope > .ib-rxm')!;
  expect(mark.dataset.rxState).toBe('signin');
  expect(mark.hasAttribute('data-rx-side')).toBe(true);
  expect(mark.dataset.rxSize).toBe('24');
  expect(b!.querySelector('.ib-rxm')).toBeNull();
});

/** Lay a pile's tiles out as a browser would: each tile `width` wide, overlapping by `overlap`. */
function layOut(pile: HTMLElement, width: number, overlap: number) {
  const tiles = [...pile.children] as HTMLElement[];
  tiles.forEach((tile, i) => {
    Object.defineProperty(tile, 'offsetLeft', { configurable: true, get: () => i * (width - overlap) });
    Object.defineProperty(tile, 'offsetWidth', { configurable: true, get: () => width });
  });
}

test.skipIf(!hasDom)("a pile: while one waits, its tiles spread 2 px each and the waiting marks gather on its outer corner side by side; the others stay on their tiles", () => {
  setInboxAgents(list([agent('s1', { state: 'blocked', kind: 'question' }), agent('s2', { state: 'done' }), agent('s3', { state: 'blocked', kind: 'permission' }), agent('s4')]));
  const el = draw(
    <span className="ib-ss-pile">
      {['s1', 's2', 's3', 's4'].map((s) => (
        <HostMark key={s} host="claude-code" agent={s} />
      ))}
    </span>,
  );
  const pile = el.querySelector<HTMLElement>('.ib-ss-pile')!;
  layOut(pile, 16, 4);
  layoutRexPile(pile);
  const tiles = [...pile.children] as HTMLElement[];
  expect(tiles.map((t) => t.style.left)).toEqual(['0px', '2px', '4px', '6px']);
  const dx = (s: number) => tiles[s]!.querySelector<HTMLElement>('.ib-rxm')?.style.getPropertyValue('--rx-dx') ?? null;
  // The last tile's corner is 3 tiles of 12 px and 3 spreads of 2 px past the first's: the first waiting mark there,
  // the next one 12 px (a 16 px pile's step) to its left.
  expect(dx(0)).toBe(`${3 * 12 + 3 * 2}px`);
  expect(dx(2)).toBe(`${12 + 2 - 12}px`);
  // Done stays on its own tile; the fourth agent has no mark at all.
  expect(dx(1)).toBe('');
  expect(dx(3)).toBeNull();

  // Nobody waits any more: no spread, every mark on its own tile.
  act(() => setInboxAgents(list([agent('s1', { state: 'working' }), agent('s2', { state: 'done' }), agent('s3', { state: 'idle' }), agent('s4')])));
  layoutRexPile(pile);
  expect(tiles.map((t) => t.style.left)).toEqual(['', '', '', '']);
  expect([dx(0), dx(2)]).toEqual(['', '']);

  // Reduced motion: the marks still gather, the tiles never spread.
  reduce = true;
  act(() => setInboxAgents(list([agent('s1', { state: 'blocked', kind: 'question' }), agent('s2'), agent('s3'), agent('s4', { state: 'blocked', kind: 'auth' })])));
  layoutRexPile(pile);
  expect(tiles.map((t) => t.style.left)).toEqual(['', '', '', '']);
  expect([dx(0), dx(3)]).toEqual([`${3 * 12}px`, '-12px']);
});

test.skipIf(!hasDom)('a row\'s pile with a "+N" chip: the gathered marks move left until they clear it', () => {
  setInboxAgents(list([agent('s1', { state: 'blocked', kind: 'question' }), agent('s2', { state: 'blocked', kind: 'permission' })]));
  const el = draw(
    <span className="ib-atiles">
      {['s1', 's2'].map((s) => (
        <span className="ib-atile" key={s}>
          <HostMark host="claude-code" agent={s} />
        </span>
      ))}
      <span className="ib-atile ib-atmore">+3</span>
    </span>,
  );
  const pile = el.querySelector<HTMLElement>('.ib-atiles')!;
  layOut(pile, 20, 5);
  const chip = pile.querySelector<HTMLElement>('.ib-atmore')!;
  chip.getBoundingClientRect = () => ({ left: 40, right: 60, top: 0, bottom: 20, width: 20, height: 20, x: 40, y: 0, toJSON() {} }) as DOMRect;
  // As drawn before the move: the first gathered mark's right edge 4 px into the chip.
  const marks = [...pile.querySelectorAll<HTMLElement>('.ib-rxm')];
  marks[0]!.getBoundingClientRect = () => ({ left: 29, right: 44, top: 0, bottom: 20, width: 15, height: 15, x: 29, y: 0, toJSON() {} }) as DOMRect;
  marks[1]!.getBoundingClientRect = () => ({ left: 14, right: 29, top: 0, bottom: 20, width: 15, height: 15, x: 14, y: 0, toJSON() {} }) as DOMRect;
  layoutRexPile(pile);
  // Before the chip: 17 px (15 + one 2 px spread) for the first, -15 for the second; then both 5 px left (4 + 1 of air).
  expect(marks.map((m) => m.style.getPropertyValue('--rx-dx'))).toEqual(['12px', '-20px']);
  // The chip is in the pile: it spreads with the tiles (2 px for each of the two before it).
  expect(chip.style.left).toBe('4px');
});

test.skipIf(!hasDom)("a row's pile with a '+N' chip: a mark that stays on its tile moves left only if it reaches the chip", () => {
  setInboxAgents(list([agent('s1', { state: 'working' }), agent('s2', { state: 'done' })]));
  const el = draw(
    <span className="ib-atiles">
      {['s1', 's2'].map((s) => (
        <span className="ib-atile" key={s}>
          <HostMark host="claude-code" agent={s} />
        </span>
      ))}
      <span className="ib-atile ib-atmore">+3</span>
    </span>,
  );
  const pile = el.querySelector<HTMLElement>('.ib-atiles')!;
  layOut(pile, 20, 5);
  const chip = pile.querySelector<HTMLElement>('.ib-atmore')!;
  chip.getBoundingClientRect = () => ({ left: 30, right: 50, top: 0, bottom: 20, width: 20, height: 20, x: 30, y: 0, toJSON() {} }) as DOMRect;
  const marks = [...pile.querySelectorAll<HTMLElement>('.ib-rxm')];
  marks[0]!.getBoundingClientRect = () => ({ left: 11, right: 23, top: 0, bottom: 20, width: 12, height: 12, x: 11, y: 0, toJSON() {} }) as DOMRect;
  marks[1]!.getBoundingClientRect = () => ({ left: 26, right: 38, top: 0, bottom: 20, width: 12, height: 12, x: 26, y: 0, toJSON() {} }) as DOMRect;
  layoutRexPile(pile);
  // Nobody waits: no spread; the first stays put, the second clears the chip by 1 px.
  expect(chip.style.left).toBe('');
  expect(marks.map((m) => m.style.getPropertyValue('--rx-dx'))).toEqual(['', '-9px']);
});
