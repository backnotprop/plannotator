/**
 * Share this space on the plan page: every state of the panel as approved (`.product/approved/share-this-space/`,
 * FLOW.md, and its layout "B1 · Three lines", approval "inbox-share-panel-b1"), and the button. What regresses if
 * these fail:
 * - a state is not the three parts (a status line, at most two lines, one row of actions with one main button at
 *   most), or a second row of buttons, an address field or "Make it yours" comes back;
 * - a state shows more than 20 words, or a button it should not have (Keep on a kept space, Stop sharing on a space
 *   nobody kept), or its main button is the wrong one (over the limit: Open in Spaces, Try again beside it);
 * - the one mark that opens the space is missing or opens something else;
 * - on a phone the panel is not the Inbox's own bottom sheet;
 * - the version switch shows for a plan with one version, or cannot be changed from the keyboard;
 * - a press sends the wrong thing (Share without its mode, Share as new onto the old space, Sign in that shares);
 * - the button reads the wrong word, or stops following an upload that is still going;
 * - a link that is not http(s) becomes something to press;
 * - Copy link does nothing without the async clipboard (plain http), or a warning is no longer said as it shows.
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
  /** The words on screen, without the buttons and a closed tip. */
  const words = () => {
    const copy = host.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('.ib-shr-b, [role="tooltip"]:not([data-open])')) node.remove();
    for (const node of copy.querySelectorAll('h2, h3, p, dt, dd, button, span.ib-shr-atext, span.ib-shr-count, span.ib-shr-who')) node.append(' ');
    return copy.textContent!.replace(/\s+/g, ' ').trim();
  };
  /** The panel's buttons, by what each does, in the order drawn. */
  const buttons = () => [...host.querySelectorAll<HTMLElement>('.ib-shr-b')].map((b) => b.dataset.shareAct);
  /** The main button (the filled one), by what it does; null when the state has none. */
  const primary = () => [...host.querySelectorAll<HTMLElement>('.ib-shr-pri, .ib-shr-danger')].map((b) => b.dataset.shareAct);
  const press = (name: string) => act(() => host.querySelector<HTMLElement>(`[data-share-act="${name}"]`)!.click());
  return { host, sent, views, words, buttons, primary, press, mode: () => mode };
}

/**
 * Each state: the buttons in its one row of actions (by what they do, in order), its main button, and whether it has
 * the version switch, the info mark, Details, the person's name and the mark that opens the space. Its words are the
 * approved ones in `SHARE_WORDS`; here only their number is held to the approved limit.
 */
type Has = { primary?: string; switch?: boolean; info?: boolean; details?: boolean; who?: boolean; open?: boolean };
const STATES: [string, SpaceShareStatus, View, string[], Has][] = [
  ['first share, not signed in', status(), 'main', ['share'], { primary: 'share', switch: true, details: true }],
  ['first share, signed in', status({ signed_in: true, who: 'Ada Novak', access: 'private' }), 'main', ['share'], { primary: 'share', switch: true, details: true, who: true }],
  ['first share, one version', status({ versions: 1 }), 'main', ['share'], { primary: 'share', details: true }],
  ['first share, one version, signed in', status({ versions: 1, signed_in: true, who: 'Ada Novak', access: 'private' }), 'main', ['share'], { primary: 'share', details: true, who: true }],
  ['uploading', status({ phase: 'sharing', progress: { done: 12, total: 40 }, link: LINK }), 'main', ['stop', 'copy'], {}],
  ['uploading, before the link', status({ phase: 'sharing', progress: { done: 0, total: 40 } }), 'main', ['stop'], {}],
  ['uploading, waiting', status({ phase: 'sharing', progress: { done: 120, total: 200 }, waiting: 8, link: LINK }), 'main', ['stop', 'copy'], {}],
  ['too many new spaces in a minute', status({ phase: 'sharing', progress: { done: 0, total: 9 }, waiting: 40 }), 'main', ['sign-in'], { primary: 'sign-in' }],
  ['shared, not signed in', shared(), 'main', ['keep', 'copy'], { primary: 'copy', info: true, details: true, open: true }],
  ['shared, then kept', shared({ kept: true, access: 'comment', signed_in: true, who: 'Ada Novak' }), 'main', ['invite', 'copy'], { primary: 'copy', details: true, open: true }],
  ['shared, made signed in', shared({ kept: true, access: 'private', signed_in: true, who: 'Ada Novak' }), 'main', ['invite', 'copy'], { primary: 'copy', details: true, open: true }],
  ['keep this space', shared({ keep: 'waiting' }), 'main', ['keep-cancel', 'keep-again'], {}],
  ['keep, from a remote window', shared({ keep: 'remote' }), 'main', ['keep-close'], {}],
  ['update, not signed in', shared({ changes: 2 }), 'main', ['copy', 'update'], { primary: 'update', details: true, open: true }],
  ['update, signed in', shared({ changes: 1, kept: true, access: 'comment', signed_in: true }), 'main', ['copy', 'update'], { primary: 'update', details: true, open: true }],
  ['update stopped for a page', shared({ stopped_pages: [{ title: 'Rollout checklist' }] }), 'main', ['copy'], { primary: 'copy', details: true, open: true }],
  ['someone else kept it', status({ phase: 'refused', link: LINK, shared_once: true }), 'main', ['open-space', 'share-new'], { primary: 'share-new' }],
  ['over the limit', status({ phase: 'over_limit', progress: { done: 3, total: 9 } }), 'main', ['sign-in'], { primary: 'sign-in' }],
  ['did not finish', status({ phase: 'failed', progress: { done: 3, total: 9 }, link: LINK }), 'main', ['copy', 'try-again'], { primary: 'try-again', open: true }],
  ['nothing went up', status({ phase: 'failed', progress: { done: 0, total: 9 } }), 'main', ['try-again'], { primary: 'try-again' }],
  ['started signed in, the sign-in gone', status({ phase: 'failed', needs_keep: true, access: 'private', progress: { done: 0, total: 9 } }), 'main', ['keep'], { primary: 'keep' }],
  ['the space is gone', status({ phase: 'gone', shared_once: true }), 'main', ['share-new'], { primary: 'share-new' }],
  ['waiting for Keep, with changes', shared({ needs_keep: true, access: 'comment', changes: 2 }), 'main', ['copy', 'keep'], { primary: 'keep', details: true, open: true }],
  ['waiting for Keep, nothing new', shared({ needs_keep: true, access: 'comment' }), 'main', ['keep', 'copy'], { primary: 'copy', details: true, open: true }],
  ['the person\'s own space, signed out here', shared({ needs_keep: true, own: true, access: 'private', changes: 1 }), 'main', ['copy', 'keep'], { primary: 'keep', details: true, open: true }],
  ['over the limit, the person\'s own space', status({ phase: 'over_limit', limit_own: true, link: LINK, access: 'private', progress: { done: 3, total: 9 } }), 'main', ['try-again', 'open-space'], { primary: 'open-space' }],
  ['over the limit, the person\'s own space, no link yet', status({ phase: 'over_limit', limit_own: true, access: 'private', progress: { done: 0, total: 9 } }), 'main', ['try-again'], { primary: 'try-again' }],
  ['stopped', status({ phase: 'stopped', progress: { done: 3, total: 9 }, link: LINK }), 'main', ['copy', 'try-again'], { primary: 'try-again', open: true }],
  ['stop sharing', shared({ kept: true, signed_in: true }), 'stop', ['cancel', 'delete'], { primary: 'delete' }],
  ['details', shared(), 'details', [], {}],
  ['details, signed in', shared({ kept: true, signed_in: true }), 'details', ['stop-sharing'], {}],
];

describe.if(hasDom)('the panel, state by state', () => {
  for (const [name, s, view, buttons, has] of STATES) {
    test(`${name}: its buttons and parts, one row of actions with one main button at most, and at most 20 words`, () => {
      const p = panel(s, view);
      expect(p.buttons()).toEqual(buttons);
      expect(p.primary()).toEqual(has.primary ? [has.primary] : []);
      expect({ switch: !!p.host.querySelector('[role="radiogroup"]'), info: !!p.host.querySelector('[data-share-info]'), details: !!p.host.querySelector('[data-share-act="details"]'), who: !!p.host.querySelector('[data-share-who]'), open: !!p.host.querySelector('[data-share-status] [data-share-act="open"]') }).toEqual({ switch: !!has.switch, info: !!has.info, details: !!has.details, who: !!has.who, open: !!has.open });
      // B1: every button is in the one row of actions (never a second row, never a button on a line), the status line
      // comes first, and the address is never drawn: no field, and no text that is the link.
      const rows = p.host.querySelectorAll('[data-share-actions]');
      expect(rows.length).toBeLessThanOrEqual(1);
      if (buttons.length > 0) expect(rows.length).toBe(1);
      for (const b of p.host.querySelectorAll('.ib-shr-b')) expect(b.closest('[data-share-actions]')).toBe(rows[0]!);
      if (view !== 'details') expect(p.host.firstElementChild!.hasAttribute('data-share-status')).toBe(true);
      expect(p.host.querySelector('input')).toBeNull();
      expect(p.host.textContent).not.toContain('spaces.example');
      expect(p.host.textContent).not.toContain('Make it yours');
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

  test('waiting for Keep with changes: the count is the status line and Keep is the main button, which keeps (it sends what waits); nothing goes up without it', () => {
    const waits = panel(shared({ needs_keep: true, access: 'comment', changes: 2 }));
    expect(waits.host.querySelector('[data-share-status] h2')!.textContent).toBe('2 changes here');
    expect(waits.host.querySelector('[data-share-act="update"]')).toBeNull();
    waits.press('keep');
    expect(waits.sent).toEqual([['keep']]);
    const update = panel(shared({ changes: 2 }));
    expect(update.host.querySelector('[data-share-status] h2')!.textContent).toBe('2 changes here');
    expect(update.host.querySelector<HTMLButtonElement>('[data-share-act="update"]')!.disabled).toBe(false);
    const gone = panel(status({ phase: 'gone', shared_once: true }));
    expect(gone.host.querySelector('[data-share-act="open"], [data-share-act="copy"]')).toBeNull();
    gone.press('share-new');
    expect(gone.sent).toEqual([['share', { mode: 'all', fresh: true }]]);
  });

  test('the person\'s own space, signed out here: Keep is always offered, in the row of actions, with or without a stopped page; no line holds a button', () => {
    for (const s of [shared({ needs_keep: true, own: true, access: 'private' }), shared({ needs_keep: true, own: true, access: 'comment', changes: 1 }), shared({ needs_keep: true, access: 'comment', changes: 1 }), shared({ needs_keep: true, own: true, access: 'private', stopped_pages: [{ title: 'Rollout' }] })]) {
      const p = panel(s);
      expect(p.host.querySelector('[data-share-actions] [data-share-act="keep"]')).not.toBeNull();
      expect(p.host.querySelector('.ib-shr-arow .ib-shr-b')).toBeNull();
    }
    // A stopped page takes the access line's place, and names the page.
    const stopped = panel(shared({ needs_keep: true, own: true, access: 'private', stopped_pages: [{ title: 'Rollout' }] }));
    expect([...stopped.host.querySelectorAll<HTMLElement>('.ib-shr-arow')].map((row) => [row.dataset.shareRowMark, row.textContent])).toEqual([['excl', 'Rollout changed']]);
    // Over the limit of the person's own space: Try again, never Sign in.
    const over = panel(status({ phase: 'over_limit', limit_own: true, link: LINK }));
    expect(over.host.querySelector('[data-share-act="sign-in"]')).toBeNull();
    over.press('try-again');
    expect(over.sent).toEqual([['share', {}]]);
    expect(panel(status({ phase: 'over_limit' })).host.querySelector('[data-share-act="sign-in"]')).not.toBeNull();
  });

  test('over the limit of the person\'s own space: Open in Spaces is the main button and opens the space in a new tab; Try again is beside it; with no link to open, Try again is the main one', () => {
    const over = panel(status({ phase: 'over_limit', limit_own: true, link: LINK }));
    const open = over.host.querySelector<HTMLAnchorElement>('[data-share-actions] [data-share-act="open-space"]')!;
    expect([open.getAttribute('href'), open.target, open.rel, open.textContent]).toEqual([LINK, '_blank', 'noopener noreferrer', 'Open in Spaces']);
    expect(over.primary()).toEqual(['open-space']);
    expect(over.buttons()).toEqual(['try-again', 'open-space']);
    // One way to open the space: the button, not also the mark.
    expect(over.host.querySelector('[data-share-act="open"]')).toBeNull();
    for (const link of [null, 'javascript:alert(1)']) {
      const none = panel(status({ phase: 'over_limit', limit_own: true, link }));
      expect([none.buttons(), none.primary()]).toEqual([['try-again'], ['try-again']]);
      expect(none.host.querySelector('a')).toBeNull();
    }
    // Over 100 MB without sign-in keeps Sign in alone, even with a link.
    expect(panel(status({ phase: 'over_limit', link: LINK })).buttons()).toEqual(['sign-in']);
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

  test('the one mark at the end of the status line opens the space in a new tab, and only an http(s) link is ever drawn', () => {
    for (const s of [shared(), shared({ kept: true, access: 'comment' }), shared({ changes: 2 }), shared({ stopped_pages: [{ title: 'Rollout checklist' }] }), status({ phase: 'failed', link: LINK })]) {
      const open = panel(s).host.querySelector<HTMLAnchorElement>('[data-share-status] [data-share-act="open"]')!;
      expect([open.getAttribute('href'), open.target, open.rel, open.getAttribute('aria-label')]).toEqual([LINK, '_blank', 'noopener noreferrer', 'Open in Spaces']);
    }
    // Invite leads to the same address.
    expect(panel(shared({ kept: true, access: 'comment' })).host.querySelector<HTMLAnchorElement>('[data-share-act="invite"]')!.getAttribute('href')).toBe(LINK);
    const odd = panel(shared({ link: 'javascript:alert(1)' }));
    expect(odd.host.querySelector('a')).toBeNull();
    expect(odd.host.querySelector('[data-share-act="copy"]')).toBeNull();
  });

  test('Copy link puts the link on the clipboard and reads Copied for a moment', async () => {
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    try {
      const p = panel(shared());
      await act(async () => p.host.querySelector<HTMLElement>('[data-share-act="copy"]')!.click());
      expect(copied).toEqual([LINK]);
      expect(p.host.querySelector('[data-share-act="copy"]')!.textContent).toBe('Copied');
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test('Copy link still copies where the window has no async clipboard (plain http): the copy command\'s way', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const realExec = document.execCommand;
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = ((command: string) => {
      if (command !== 'copy') return false;
      const data = new Map<string, string>();
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => void data.set(type, value) } });
      document.dispatchEvent(event);
      if (data.has('text/plain')) copied.push(data.get('text/plain')!);
      return true;
    }) as typeof document.execCommand;
    try {
      const p = panel(shared());
      await act(async () => p.host.querySelector<HTMLElement>('[data-share-act="copy"]')!.click());
      expect(copied).toEqual([LINK]);
      expect(p.host.querySelector('[data-share-act="copy"]')!.textContent).toBe('Copied');
    } finally {
      document.execCommand = realExec;
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test('a warning, and the line beside a space someone else kept, are said as they show (a live region); the rest are not', () => {
    const live = (s: SpaceShareStatus) => [...panel(s).host.querySelectorAll('[role="status"]')].map((el) => el.textContent);
    expect(live(status({ phase: 'failed', link: LINK }))).toEqual(['Couldn’t reach Spaces.']);
    expect(live(status({ phase: 'stopped', link: LINK }))).toEqual(['Sharing stopped']);
    expect(live(status({ phase: 'gone', shared_once: true }))).toEqual(['This space is gone']);
    expect(live(status({ phase: 'over_limit' }))).toEqual(['Over 100 MB without sign-in.']);
    expect(live(status({ phase: 'over_limit', limit_own: true, link: LINK }))).toEqual(['Over the limit']);
    expect(live(status({ phase: 'sharing', waiting: 3, progress: { done: 0, total: 9 } }))).toEqual(['Spaces is busy. Trying again in 3 s.']);
    expect(live(status({ phase: 'refused', link: LINK, shared_once: true }))).toEqual(['You can still comment there.']);
    // Calm states say nothing by themselves.
    expect(live(shared())).toEqual([]);
    expect(live(status())).toEqual([]);
  });
});

describe.if(hasDom)('the button', () => {
  function mount(answers: SpaceShareStatus[], phone = false) {
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
    act(() => root!.render(<PlanShare id="pln_01HZZZZZZZZZZZZZZZZZZZZZZ0" phone={phone} />));
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

  test('on a phone the panel is the Inbox\'s own bottom sheet, named Share, and Escape closes it back to the button', async () => {
    const m = mount([shared()], true);
    await tick();
    await act(async () => m.button().click());
    await tick(20);
    const sheet = document.querySelector<HTMLElement>('[data-sheet][data-plan-share-sheet]')!;
    expect(sheet).not.toBeNull();
    expect([sheet.getAttribute('role'), sheet.getAttribute('aria-label'), m.button().getAttribute('aria-expanded')]).toEqual(['dialog', 'Share', 'true']);
    expect(sheet.querySelector('[data-plan-share-panel][data-phone] [data-share-actions] [data-share-act="copy"]')).not.toBeNull();
    // Not the old sheet: no popover positioner, no second scrim of its own.
    expect(document.querySelector('.ib-shr-pos, [data-plan-share-scrim]')).toBeNull();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(m.button().getAttribute('aria-expanded')).toBe('false');
    await tick(400);
    expect(document.querySelector('[data-plan-share-sheet]')).toBeNull();
  });
});
