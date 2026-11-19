/**
 * Share this space on the plan page: every state of the panel as approved (`.product/approved/share-this-space/`,
 * FLOW.md), and the button. What regresses if these fail:
 * - a state shows other words than the approved ones, more than 20 of them, or a button it should not have (Details
 *   on the Update panel, Keep on a kept space, Stop sharing on a space nobody kept);
 * - the version switch shows for a plan with one version, or cannot be changed from the keyboard;
 * - a press sends the wrong thing (Share without its mode, Share as new onto the old space, Sign in that shares);
 * - the button reads the wrong word, or stops following an upload that is still going;
 * - a link that is not http(s) becomes something to press.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SpaceShareDetails, SpaceShareStatus } from '@plannotator/core/space-share';

const hasDom = typeof document !== 'undefined';
const { PlanShare, SharePanel } = (hasDom ? await import('./PlanShare') : {}) as typeof import('./PlanShare');
type Actions = import('./PlanShare').ShareActions;
type View = import('./PlanShare').ShareView;

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

const LINK = 'https://spaces.example/s/rate-limiting-7f3k9q';
const details: SpaceShareDetails = { pages: 4, files: 3, comments: 1, approval: 4, not: { sent_comments: 3, pictures: 2, original_dates: true, files_over: 0, pages_over: 0, long_comments: 0, older_approvals: 0 } };
const status = (more: Partial<SpaceShareStatus> = {}): SpaceShareStatus => ({ phase: 'none', progress: null, waiting: null, link: null, shared_once: false, kept: false, signed_in: false, who: null, keep: null, mode: 'all', versions: 4, changes: 0, stopped_pages: [], details: { all: details, newest: details }, ...more });
const shared = (more: Partial<SpaceShareStatus> = {}) => status({ phase: 'shared', link: LINK, shared_once: true, ...more });

function panel(s: SpaceShareStatus, view: View = 'main') {
  const sent: unknown[][] = [];
  const views: View[] = [];
  let mode: 'all' | 'newest' = 'all';
  const actions: Actions = {
    share: (input) => void sent.push(['share', input]),
    stop: () => void sent.push(['stop']),
    keep: () => void sent.push(['keep']),
    keepCancel: () => void sent.push(['keepCancel']),
    remove: async () => {
      sent.push(['remove']);
      return true;
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const draw = () => act(() => root!.render(<SharePanel status={s} view={view} onView={(v) => views.push(v)} mode={mode} onMode={(m) => ((mode = m), draw())} actions={actions} />));
  draw();
  /** The words on screen, without the link, the buttons and a closed tip. */
  const words = () => {
    const copy = host.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('.ib-shr-b, input, [role="tooltip"]:not([data-open])')) node.remove();
    for (const node of copy.querySelectorAll('h2, h3, p, dt, dd, button, span.ib-shr-atext, span.ib-shr-count, span.ib-shr-who')) node.append(' ');
    return copy.textContent!.replace(/\s+/g, ' ').trim();
  };
  const buttons = () => [...host.querySelectorAll<HTMLElement>('.ib-shr-b')].map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim());
  const press = (name: string) => act(() => host.querySelector<HTMLElement>(`[data-share-act="${name}"]`)!.click());
  return { host, sent, views, words, buttons, press, mode: () => mode };
}

/** Each state: its words (without the link and the buttons), and its buttons, as approved. */
const STATES: [string, SpaceShareStatus, View, string, string[]][] = [
  ['first share, not signed in', status(), 'main', 'Share All versions Newest Anyone with the link can edit Details', ['Share']],
  ['first share, signed in', status({ signed_in: true, who: 'Maya Chen' }), 'main', 'Share Maya Chen All versions Newest Only you Details', ['Share']],
  ['first share, one version', status({ versions: 1 }), 'main', 'Share Anyone with the link can edit Details', ['Share']],
  ['first share, one version, signed in', status({ versions: 1, signed_in: true, who: 'Maya Chen' }), 'main', 'Share Maya Chen Only you Details', ['Share']],
  ['uploading', status({ phase: 'sharing', progress: { done: 12, total: 40 }, link: LINK }), 'main', 'Sharing 12 of 40', ['Copy link', 'Open in Spaces', 'Stop']],
  ['uploading, before the link', status({ phase: 'sharing', progress: { done: 0, total: 40 } }), 'main', 'Sharing 0 of 40', ['Stop']],
  ['uploading, waiting', status({ phase: 'sharing', progress: { done: 120, total: 200 }, waiting: 8, link: LINK }), 'main', 'Waiting… 120 of 200', ['Copy link', 'Open in Spaces', 'Stop']],
  ['too many new spaces in a minute', status({ phase: 'sharing', progress: { done: 0, total: 9 }, waiting: 40 }), 'main', 'Spaces is busy. Trying again in 40 s.', ['Sign in']],
  ['shared, not signed in', shared(), 'main', 'Anyone with the link can edit Make it yours Details', ['Copy link', 'Open in Spaces', 'Keep this space']],
  ['shared, signed in', shared({ kept: true, signed_in: true, who: 'Maya Chen' }), 'main', 'Only you Details', ['Copy link', 'Open in Spaces', 'Invite']],
  ['keep this space', shared({ keep: 'waiting' }), 'main', 'Keep this space Waiting for your browser… First to keep it owns it.', ['Cancel', 'Open again']],
  ['keep, from a remote window', shared({ keep: 'remote' }), 'main', 'Keep this space Sign in from your own computer.', ['Close']],
  ['update, not signed in', shared({ changes: 2 }), 'main', 'Anyone with the link can edit 2 changes here', ['Copy link', 'Open in Spaces', 'Update']],
  ['update, signed in', shared({ changes: 1, kept: true, signed_in: true }), 'main', 'Only you 1 change here', ['Copy link', 'Open in Spaces', 'Invite', 'Update']],
  ['update stopped for a page', shared({ stopped_pages: [{ title: 'Rollout checklist' }] }), 'main', 'Rollout checklist changed', ['Copy link', 'Open in Spaces', 'Open in Spaces']],
  ['someone else kept it', status({ phase: 'refused', link: LINK, shared_once: true }), 'main', 'Someone else kept this space You can still comment there.', ['Open in Spaces', 'Share as new']],
  ['over the limit', status({ phase: 'over_limit', progress: { done: 3, total: 9 } }), 'main', 'Over 100 MB without sign-in.', ['Sign in']],
  ['did not finish', status({ phase: 'failed', progress: { done: 3, total: 9 }, link: LINK }), 'main', 'Couldn’t reach Spaces.', ['Copy link', 'Open in Spaces', 'Try again']],
  ['nothing went up', status({ phase: 'failed', progress: { done: 0, total: 9 } }), 'main', 'Couldn’t reach Spaces.', ['Try again']],
  ['stopped', status({ phase: 'stopped', progress: { done: 3, total: 9 }, link: LINK }), 'main', 'Sharing stopped', ['Copy link', 'Open in Spaces', 'Try again']],
  ['stop sharing', shared({ kept: true, signed_in: true }), 'stop', 'Stop sharing Deletes the copy in Spaces for good.', ['Cancel', 'Delete']],
  ['details', shared(), 'details', 'Details Pages 4 Files 3 Comments 1 Approval v4 Not shared Sent comments 3 Pictures 2 Original dates', []],
  ['details, signed in', shared({ kept: true, signed_in: true }), 'details', 'Details Pages 4 Files 3 Comments 1 Approval v4 Not shared Sent comments 3 Pictures 2 Original dates', ['Stop sharing']],
];

describe.if(hasDom)('the panel, state by state', () => {
  for (const [name, s, view, words, buttons] of STATES) {
    test(`${name}: its approved words and buttons, at most 20 words`, () => {
      const p = panel(s, view);
      expect(p.words()).toBe(words);
      expect(p.buttons()).toEqual(buttons);
      expect(words.split(' ').length).toBeLessThanOrEqual(20);
    });
  }

  test('the info mark holds its one fact, shown on a press', () => {
    const p = panel(shared());
    const mark = p.host.querySelector<HTMLElement>('[data-share-info]')!;
    const tip = p.host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(tip.textContent).toBe('Removed after 30 idle days unless kept.');
    expect(mark.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.hasAttribute('data-open')).toBe(false);
    act(() => mark.click());
    expect(tip.hasAttribute('data-open')).toBe(true);
    expect(p.words().split(' ').length).toBeLessThanOrEqual(20);
    // Only on the result: not on the first share, not on Update.
    expect(panel(status()).host.querySelector('[data-share-info]')).toBeNull();
    expect(panel(shared({ changes: 2 })).host.querySelector('[data-share-info]')).toBeNull();
  });

  test('Details rows with nothing in them are not shown; the other rows appear when they apply', () => {
    const p = panel(shared({ details: { all: { pages: 1, files: 0, comments: 0, approval: null, not: { sent_comments: 0, pictures: 0, original_dates: true, files_over: 1, pages_over: 2, long_comments: 1, older_approvals: 3 } }, newest: details } }), 'details');
    expect(p.words()).toBe('Details Pages 1 Not shared Original dates File over 100 MB 1 Page over 1.5 MB 2 Long comment 1 Older approvals 3');
  });
});

describe.if(hasDom)('what a press sends', () => {
  test('Share goes with the side of the switch that is picked; arrow keys move it', () => {
    const p = panel(status());
    const radios = [...p.host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked'), r.tabIndex])).toEqual([['All versions', 'true', 0], ['Newest', 'false', -1]]);
    act(() => void radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(p.mode()).toBe('newest');
    expect(p.host.querySelector('[data-share-mode="newest"]')!.getAttribute('aria-checked')).toBe('true');
    p.press('share');
    expect(p.sent).toEqual([['share', { mode: 'newest' }]]);
  });

  test('each button does its one thing', () => {
    const up = panel(status({ phase: 'sharing', progress: { done: 1, total: 4 }, link: LINK }));
    up.press('stop');
    expect(up.sent).toEqual([['stop']]);
    const done = panel(shared());
    done.press('keep');
    done.press('details');
    expect([done.sent, done.views]).toEqual([[['keep']], ['details']]);
    const update = panel(shared({ changes: 2 }));
    update.press('update');
    expect(update.sent).toEqual([['share', {}]]);
    const other = panel(status({ phase: 'refused', link: LINK, mode: 'newest' }));
    other.press('share-new');
    expect(other.sent).toEqual([['share', { mode: 'newest', fresh: true }]]);
    const over = panel(status({ phase: 'over_limit' }));
    over.press('sign-in');
    expect(over.sent).toEqual([['keep']]);
    const failed = panel(status({ phase: 'failed', link: LINK }));
    failed.press('try-again');
    expect(failed.sent).toEqual([['share', {}]]);
    const keep = panel(shared({ keep: 'waiting' }));
    keep.press('keep-again');
    keep.press('keep-cancel');
    expect(keep.sent).toEqual([['keep'], ['keepCancel']]);
    const signed = panel(shared({ kept: true, signed_in: true }), 'details');
    signed.press('stop-sharing');
    expect(signed.views).toEqual(['stop']);
  });

  test('Delete stops sharing and goes back; Cancel only goes back', async () => {
    const p = panel(shared({ kept: true, signed_in: true }), 'stop');
    p.press('cancel');
    expect([p.sent, p.views]).toEqual([[], ['main']]);
    await act(async () => p.host.querySelector<HTMLElement>('[data-share-act="delete"]')!.click());
    expect([p.sent, p.views]).toEqual([[['remove']], ['main', 'main']]);
  });

  test('the link opens in a new tab and is only ever http(s)', () => {
    const p = panel(shared());
    const open = p.host.querySelector<HTMLAnchorElement>('[data-share-act="open"]')!;
    expect([open.getAttribute('href'), open.target, open.rel]).toEqual([LINK, '_blank', 'noopener noreferrer']);
    expect(p.host.querySelector<HTMLInputElement>('input')!.value).toBe(LINK);
    const odd = panel(shared({ link: 'javascript:alert(1)' }));
    expect(odd.host.querySelector('a')).toBeNull();
    expect(odd.host.querySelector('input')).toBeNull();
  });
});

describe.if(hasDom)('the button', () => {
  function mount(answers: SpaceShareStatus[]) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<PlanShare id="pln_01HZZZZZZZZZZZZZZZZZZZZZZ0" phone={false} />));
    const button = () => host.querySelector<HTMLElement>('[data-plan-share]')!;
    return { host, calls, button };
  }
  const tick = (ms = 0) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

  test('reads Share, then Shared, Update, and a mark when it needs a look', async () => {
    for (const [s, label, state, name] of [
      [status(), 'Share', 'idle', null],
      [shared(), 'Shared', 'shared', null],
      [shared({ changes: 3 }), 'Update', 'update', null],
      [shared({ stopped_pages: [{ title: 'Rollout' }] }), 'Shared', 'look', 'Shared: needs a look'],
      [status({ phase: 'failed' }), 'Share', 'failed', 'Share: did not finish'],
    ] as const) {
      const m = mount([s]);
      await tick();
      expect([m.button().textContent, m.button().dataset.state, m.button().getAttribute('aria-label')]).toEqual([label, state, name]);
      act(() => root!.unmount());
      document.body.innerHTML = '';
    }
  });

  test('follows an upload to its end with the panel closed, then stops asking', async () => {
    const m = mount([status({ phase: 'sharing', progress: { done: 1, total: 3 } }), status({ phase: 'sharing', progress: { done: 2, total: 3 } }), shared()]);
    await tick();
    expect(m.button().textContent).toBe('Sharing');
    await tick(1500);
    expect(m.button().textContent).toBe('Shared');
    const asked = m.calls.length;
    await tick(900);
    expect(m.calls.length).toBe(asked);
    expect(m.calls.every((c) => c === 'GET /api/plans/pln_01HZZZZZZZZZZZZZZZZZZZZZZ0/share')).toBe(true);
  });

  test('a press opens the panel under it; Share posts the mode', async () => {
    const m = mount([status()]);
    await tick();
    await act(async () => m.button().click());
    await tick();
    const panelEl = document.querySelector<HTMLElement>('[data-plan-share-panel]')!;
    expect(panelEl).not.toBeNull();
    expect(m.button().getAttribute('aria-expanded')).toBe('true');
    await act(async () => panelEl.querySelector<HTMLElement>('[data-share-act="share"]')!.click());
    expect(m.calls[m.calls.length - 1]).toBe('POST /api/plans/pln_01HZZZZZZZZZZZZZZZZZZZZZZ0/share');
  });
});
