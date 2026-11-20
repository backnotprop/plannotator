/**
 * Share this space on the plan page: every state of the panel as approved (`.product/approved/share-this-space/`,
 * FLOW.md), and the button. What regresses if these fail:
 * - a state shows more than 20 words, or a button it should not have (Details
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
const status = (more: Partial<SpaceShareStatus> = {}): SpaceShareStatus => ({ phase: 'none', progress: null, waiting: null, link: null, shared_once: false, kept: false, access: 'edit', signed_in: false, who: null, keep: null, mode: 'all', versions: 4, changes: 0, stopped_pages: [], details: { all: details, newest: details }, ...more });
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
  /** The panel's buttons, by what each does. */
  const buttons = () => [...host.querySelectorAll<HTMLElement>('.ib-shr-b')].map((b) => b.dataset.shareAct);
  const press = (name: string) => act(() => host.querySelector<HTMLElement>(`[data-share-act="${name}"]`)!.click());
  return { host, sent, views, words, buttons, press, mode: () => mode };
}

/**
 * Each state: the buttons it has (by what they do), whether it has the version switch, the info mark and Details.
 * Its words are the approved ones in `SHARE_WORDS`; here only their number is held to the approved limit.
 */
const STATES: [string, SpaceShareStatus, View, string[], { switch?: boolean; info?: boolean; details?: boolean; who?: boolean }][] = [
  ['first share, not signed in', status(), 'main', ['share'], { switch: true, details: true }],
  ['first share, signed in', status({ signed_in: true, who: 'Maya Chen', access: 'private' }), 'main', ['share'], { switch: true, details: true, who: true }],
  ['first share, one version', status({ versions: 1 }), 'main', ['share'], { details: true }],
  ['first share, one version, signed in', status({ versions: 1, signed_in: true, who: 'Maya Chen', access: 'private' }), 'main', ['share'], { details: true, who: true }],
  ['uploading', status({ phase: 'sharing', progress: { done: 12, total: 40 }, link: LINK }), 'main', ['copy', 'open', 'stop'], {}],
  ['uploading, before the link', status({ phase: 'sharing', progress: { done: 0, total: 40 } }), 'main', ['stop'], {}],
  ['uploading, waiting', status({ phase: 'sharing', progress: { done: 120, total: 200 }, waiting: 8, link: LINK }), 'main', ['copy', 'open', 'stop'], {}],
  ['too many new spaces in a minute', status({ phase: 'sharing', progress: { done: 0, total: 9 }, waiting: 40 }), 'main', ['sign-in'], {}],
  ['shared, not signed in', shared(), 'main', ['copy', 'open', 'keep'], { info: true, details: true }],
  ['shared, then kept', shared({ kept: true, access: 'comment', signed_in: true, who: 'Maya Chen' }), 'main', ['copy', 'open', 'invite'], { details: true }],
  ['shared, made signed in', shared({ kept: true, access: 'private', signed_in: true, who: 'Maya Chen' }), 'main', ['copy', 'open', 'invite'], { details: true }],
  ['keep this space', shared({ keep: 'waiting' }), 'main', ['keep-cancel', 'keep-again'], {}],
  ['keep, from a remote window', shared({ keep: 'remote' }), 'main', ['keep-close'], {}],
  ['update, not signed in', shared({ changes: 2 }), 'main', ['copy', 'open', 'update'], {}],
  ['update, signed in', shared({ changes: 1, kept: true, access: 'comment', signed_in: true }), 'main', ['copy', 'open', 'invite', 'update'], {}],
  ['update stopped for a page', shared({ stopped_pages: [{ title: 'Rollout checklist' }] }), 'main', ['copy', 'open', 'open-page'], {}],
  ['someone else kept it', status({ phase: 'refused', link: LINK, shared_once: true }), 'main', ['open-space', 'share-new'], {}],
  ['over the limit', status({ phase: 'over_limit', progress: { done: 3, total: 9 } }), 'main', ['sign-in'], {}],
  ['did not finish', status({ phase: 'failed', progress: { done: 3, total: 9 }, link: LINK }), 'main', ['copy', 'open', 'try-again'], {}],
  ['nothing went up', status({ phase: 'failed', progress: { done: 0, total: 9 } }), 'main', ['try-again'], {}],
  ['started signed in, the sign-in gone', status({ phase: 'failed', needs_keep: true, access: 'private', progress: { done: 0, total: 9 } }), 'main', ['keep'], {}],
  ['the space is gone', status({ phase: 'gone', shared_once: true }), 'main', ['share-new'], {}],
  ['waiting for Keep, with changes', shared({ needs_keep: true, access: 'comment', changes: 2 }), 'main', ['copy', 'open', 'keep', 'update'], {}],
  ['waiting for Keep, nothing new', shared({ needs_keep: true, access: 'comment' }), 'main', ['copy', 'open', 'keep'], { details: true }],
  ['the person\'s own space, signed out here', shared({ needs_keep: true, own: true, access: 'private', changes: 1 }), 'main', ['copy', 'open', 'keep', 'update'], {}],
  ['over the limit, the person\'s own space', status({ phase: 'over_limit', limit_own: true, link: LINK, access: 'private', progress: { done: 3, total: 9 } }), 'main', ['copy', 'open', 'try-again'], {}],
  ['stopped', status({ phase: 'stopped', progress: { done: 3, total: 9 }, link: LINK }), 'main', ['copy', 'open', 'try-again'], {}],
  ['stop sharing', shared({ kept: true, signed_in: true }), 'stop', ['cancel', 'delete'], {}],
  ['details', shared(), 'details', [], {}],
  ['details, signed in', shared({ kept: true, signed_in: true }), 'details', ['stop-sharing'], {}],
];

describe.if(hasDom)('the panel, state by state', () => {
  for (const [name, s, view, buttons, has] of STATES) {
    test(`${name}: its buttons and parts, and at most 20 words`, () => {
      const p = panel(s, view);
      expect(p.buttons()).toEqual(buttons);
      expect({ switch: !!p.host.querySelector('[role="radiogroup"]'), info: !!p.host.querySelector('[data-share-info]'), details: !!p.host.querySelector('[data-share-act="details"]'), who: !!p.host.querySelector('[data-share-who]') }).toEqual({ switch: !!has.switch, info: !!has.info, details: !!has.details, who: !!has.who });
      const words = p.words().split(' ').filter(Boolean);
      expect(words.length).toBeGreaterThan(0);
      expect(words.length).toBeLessThanOrEqual(20);
    });
  }

  test('the info mark holds one fact, tied to it for a screen reader and shown on a press; only on the result', () => {
    const p = panel(shared());
    const mark = p.host.querySelector<HTMLElement>('[data-share-info]')!;
    const tip = p.host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(tip.textContent!.length).toBeGreaterThan(0);
    expect(mark.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.hasAttribute('data-open')).toBe(false);
    act(() => mark.click());
    expect(tip.hasAttribute('data-open')).toBe(true);
    expect(p.words().split(' ').length).toBeLessThanOrEqual(20);
    expect(panel(status()).host.querySelector('[data-share-info]')).toBeNull();
    expect(panel(shared({ changes: 2 })).host.querySelector('[data-share-info]')).toBeNull();
  });

  test('Details: a row with nothing in it is not shown; with every row applying it still holds its 20 words, and a file or page too big to go is never the row left out', () => {
    const rowsOf = (d: SpaceShareDetails) => {
      const p = panel(shared({ details: { all: d, newest: d } }), 'details');
      return { rows: [...p.host.querySelectorAll<HTMLElement>('[data-share-row]')].map((r) => r.dataset.shareRow), words: p.words().split(' ').length };
    };
    const few = rowsOf({ pages: 1, files: 0, comments: 0, approval: null, not: { sent_comments: 0, pictures: 0, original_dates: true, files_over: 0, pages_over: 0, long_comments: 0, older_approvals: 0 } });
    expect(few.rows).toHaveLength(2);
    const usual = rowsOf(details);
    expect(usual.rows).toHaveLength(7);
    expect(usual.words).toBeLessThanOrEqual(20);
    const worst = rowsOf({ pages: 4, files: 3, comments: 1, approval: 4, not: { sent_comments: 3, pictures: 2, original_dates: true, files_over: 1, pages_over: 2, long_comments: 1, older_approvals: 3 } });
    // Both too-big rows with every row above them: the one case that runs a word over, since neither may be left out.
    expect(worst.words).toBe(21);
    expect(worst.rows).toHaveLength(6);
    expect(worst.rows.filter((r) => / over /.test(r!))).toHaveLength(2);
    const one = rowsOf({ pages: 4, files: 3, comments: 1, approval: 4, not: { sent_comments: 3, pictures: 2, original_dates: true, files_over: 1, pages_over: 0, long_comments: 1, older_approvals: 3 } });
    expect(one.words).toBeLessThanOrEqual(20);
    expect(one.rows.filter((r) => / over /.test(r!))).toHaveLength(1);
  });

  test('the access line says what is true: a lock only for a space made signed in; a space kept after it was shared is still open to its link, and says so', () => {
    const lineOf = (s: SpaceShareStatus) => {
      const p = panel(s);
      const row = p.host.querySelector<HTMLElement>('.ib-shr-arow')!;
      return { mark: row.dataset.shareRowMark, words: row.querySelector('.ib-shr-atext')!.textContent };
    };
    const open = lineOf(shared());
    const keptAfter = lineOf(shared({ kept: true, access: 'comment', signed_in: true }));
    const madeSignedIn = lineOf(shared({ kept: true, access: 'private', signed_in: true }));
    expect([open.mark, keptAfter.mark, madeSignedIn.mark]).toEqual(['globe', 'globe', 'lock']);
    // Three states, three different lines: a kept space never borrows the private one's words.
    expect(new Set([open.words, keptAfter.words, madeSignedIn.words]).size).toBe(3);
    expect(lineOf(status({ signed_in: true, access: 'private' })).mark).toBe('lock');
  });

  test('waiting for Keep: Update is shown with its count and waits; the gone state has no link to copy', () => {
    const waits = panel(shared({ needs_keep: true, access: 'comment', changes: 2 }));
    expect(waits.host.querySelector<HTMLButtonElement>('[data-share-act="update"]')!.disabled).toBe(true);
    expect(waits.host.querySelector<HTMLButtonElement>('[data-share-act="keep"]')!.disabled).toBe(false);
    expect(panel(shared({ changes: 2 })).host.querySelector<HTMLButtonElement>('[data-share-act="update"]')!.disabled).toBe(false);
    const gone = panel(status({ phase: 'gone', shared_once: true }));
    expect(gone.host.querySelector('input')).toBeNull();
    gone.press('share-new');
    expect(gone.sent).toEqual([['share', { mode: 'all', fresh: true }]]);
  });

  test('the person\'s own space, signed out here: only the access line and Keep, never beside a "make it yours" row; someone else\'s by now keeps that row', () => {
    const marks = (s: SpaceShareStatus) => [...panel(s).host.querySelectorAll<HTMLElement>('.ib-shr-arow')].map((row) => `${row.dataset.shareRowMark}${row.querySelector('[data-share-act="keep"]') ? '+keep' : ''}`);
    expect(marks(shared({ needs_keep: true, own: true, access: 'private' }))).toEqual(['lock+keep']);
    expect(marks(shared({ needs_keep: true, own: true, access: 'comment', changes: 1 }))).toEqual(['globe+keep', 'doc']);
    expect(marks(shared({ needs_keep: true, access: 'comment', changes: 1 }))).toEqual(['globe', 'user+keep', 'doc']);
    // With a stopped page the access line gives way to the page's row, so Keep has its own row again: never no Keep.
    expect(marks(shared({ needs_keep: true, own: true, access: 'private', stopped_pages: [{ title: 'Rollout' }] }))).toEqual(['excl', 'user+keep']);
    // Over the limit of the person's own space: Try again, never Sign in.
    const over = panel(status({ phase: 'over_limit', limit_own: true, link: LINK }));
    expect(over.host.querySelector('[data-share-act="sign-in"]')).toBeNull();
    over.press('try-again');
    expect(over.sent).toEqual([['share', {}]]);
    expect(panel(status({ phase: 'over_limit' })).host.querySelector('[data-share-act="sign-in"]')).not.toBeNull();
  });

  test('Keep waits while a claim is going', () => {
    expect(panel(shared({ busy: true })).host.querySelector<HTMLButtonElement>('[data-share-act="keep"]')!.disabled).toBe(true);
    expect(panel(shared()).host.querySelector<HTMLButtonElement>('[data-share-act="keep"]')!.disabled).toBe(false);
  });
});

describe.if(hasDom)('what a press sends', () => {
  test('Share goes with the side of the switch that is picked; arrow keys move it', () => {
    const p = panel(status());
    const radios = [...p.host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => [r.dataset.shareMode, r.getAttribute('aria-checked'), r.tabIndex])).toEqual([['all', 'true', 0], ['newest', 'false', -1]]);
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
    // A stopped page opens at its own address there.
    // A stopped page opens the space itself: never an address built here.
    const stopped = panel(shared({ stopped_pages: [{ title: 'Rollout checklist' }] }));
    expect(stopped.host.querySelector<HTMLAnchorElement>('[data-share-act="open-page"]')!.getAttribute('href')).toBe(LINK);
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

  test('its state follows the share, with a note for a screen reader only when it carries a mark', async () => {
    for (const [s, state, noted] of [
      [status(), 'idle', false],
      [shared(), 'shared', false],
      [shared({ changes: 3 }), 'update', false],
      [shared({ stopped_pages: [{ title: 'Rollout' }] }), 'look', true],
      [status({ phase: 'failed' }), 'failed', true],
    ] as const) {
      const m = mount([s]);
      await tick();
      expect([m.button().dataset.state, m.button().hasAttribute('aria-label')]).toEqual([state, noted]);
      act(() => root!.unmount());
      document.body.innerHTML = '';
    }
  });

  test('follows an upload to its end with the panel closed, then stops asking', async () => {
    const m = mount([status({ phase: 'sharing', progress: { done: 1, total: 3 } }), status({ phase: 'sharing', progress: { done: 2, total: 3 } }), shared()]);
    await tick();
    expect(m.button().dataset.state).toBe('busy');
    await tick(1500);
    expect(m.button().dataset.state).toBe('shared');
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
