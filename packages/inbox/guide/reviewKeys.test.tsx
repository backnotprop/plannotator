/**
 * The code review app's keys on a review in the Inbox (guide/ReviewKeys.tsx; approval 2026-11-23: "Yes, the same keys
 * as code review", "Yes, the review's keys win while a review is open"). What would regress:
 *
 *  - with a review on screen, J, N, Z or C meaning their Inbox key (next thread, first new message, Undo, New
 *    message) instead of the review's, or a review key doing nothing where its control is on the page;
 *  - an Inbox key not coming back once the review has left the screen;
 *  - a review key firing while typing in a comment box;
 *  - a key whose feature the Inbox's review lacks (C, file comments) acting, or falling through to the Inbox;
 *  - a review key that is not the code review app's own (a new key, or retyped bindings drifting from production's);
 *  - a review key acting on a diff the person is not looking at (focus in the PR's Details, a repository file over
 *    it, a menu, a sheet or anything else drawn over it), or breaking an Inbox sequence (G P);
 *  - N scrolling when there is no further change, J / K re-jumping to the file already being read, a held X or V
 *    flipping the file over and over, a toast promising Z while the review has it.
 *
 * The review is the reader's DOM as review-editor draws it (file shells, the header's arrow and Viewed, change rows),
 * with the layout stubbed: happy-dom lays nothing out. The Inbox's keys are its scopes with the rule every Inbox key
 * shares (guards.ts `bareKeyAllowed`: a used key is not theirs). DOM-gated: runs under DOM_TESTS=1 (happy-dom), from
 * tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { listRegistryShortcuts, resolveShortcutBindings, useShortcutScope } from '@plannotator/ui/shortcuts';
import { bareKeyAllowed, inboxAppShortcuts, inboxThreadShortcuts } from '../shortcuts';
import { openReviewKeys } from '../shortcuts/review';

const hasDom = typeof document !== 'undefined';
// review-editor reads `window` as it loads: only under happy-dom (the plain unit lane loads this file too).
const { reviewSettingsShortcutRegistry } = (hasDom ? await import('@plannotator/review-editor/shortcuts') : {}) as typeof import('@plannotator/review-editor/shortcuts');
const { REVIEW_KEY_ACTIONS, ReviewKeys, endsSequence } = (hasDom ? await import('./ReviewKeys') : {}) as typeof import('./ReviewKeys');
const { activeFile, changeTarget, fileStep, reopenTarget, stepOrigin } = (hasDom ? await import('./reviewWalk') : {}) as typeof import('./reviewWalk');
const { ShortcutMap } = (hasDom ? await import('../components/ShortcutMap') : {}) as typeof import('../components/ShortcutMap');
const { InboxToast, toastSpeech } = (hasDom ? await import('../components/Toast') : {}) as typeof import('../components/Toast');
const VIEW = 400;
const FILES = [
  { path: 'src/a.ts', top: 0, change: 100 },
  { path: 'src/b.ts', top: 500, change: 650 },
  { path: 'src/c.ts', top: 1000, change: 1100 },
];
/** Each file's patch: one line of context, then one change of two added lines (unified rows 1 and 2). */
const DIFF = FILES.map(({ path }) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,3 @@\n const a = 0;\n+const b = 1;\n+const c = 2;\n`).join('');

/** What the Inbox's own keys did. */
let inbox: string[] = [];
const inboxKey = (name: string) => ({ when: (event: KeyboardEvent) => bareKeyAllowed(event), handle: () => void inbox.push(name) });
function InboxKeys() {
  useShortcutScope({ scope: inboxThreadShortcuts, handlers: { nextThread: inboxKey('next thread'), firstNew: inboxKey('first new'), undo: inboxKey('undo') } });
  useShortcutScope({
    scope: inboxAppShortcuts,
    handlers: {
      compose: inboxKey('new message'),
      goInbox: inboxKey('go inbox'),
      goBoard: inboxKey('go board'),
      goSettings: inboxKey('go settings'),
      goPulls: inboxKey('go reviews'),
      goDrafts: inboxKey('go drafts'),
    },
  });
  return null;
}
const frames = (count = 6) => act(async () => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
});

describe.skipIf(!hasDom)('the review’s keys in the Inbox', () => {
  let root: Root;
  let host: HTMLElement;
  let scroller: HTMLElement;
  let scrollTop = 0;
  /** Where the page went: each file or change brought into view. */
  let reached: string[] = [];
  let clicks: string[] = [];
  /** What the page draws as it scrolls (a file's rows coming on screen). */
  let onScroll = () => {};
  /** What is on top at a point of the window (the diff unless a test puts something over it). */
  let atPoint: () => Element | null = () => scroller;
  const realElementFromPoint = hasDom ? document.elementFromPoint : undefined;

  /** Stubbed layout: an element at `top` in the scroller's content, `height` tall. */
  const place = (el: Element, top: number, height: number) => {
    (el as HTMLElement).getBoundingClientRect = () => {
      const y = top - scrollTop;
      return { top: y, bottom: y + height, height, left: 0, right: 800, width: 800, x: 0, y, toJSON: () => ({}) } as DOMRect;
    };
    (el as HTMLElement).scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      reached.push(`${(el as HTMLElement).dataset.guideFileShell ?? (el as HTMLElement).dataset.lineIndex}`);
      const block = typeof options === 'object' ? options.block : 'start';
      scrollTop = block === 'center' ? top - VIEW / 2 : top;
      onScroll();
    };
  };

  /** The files folded (the card's state, on its shell): c unless a test says otherwise. */
  type ReviewOptions = { viewed?: boolean; details?: boolean; diff?: string; folded?: ReadonlySet<string> };
  const C_FOLDED: ReadonlySet<string> = new Set(['src/c.ts']);
  const Review = ({ keys = true, viewed = true, details = false, diff = DIFF, folded = C_FOLDED }: ReviewOptions & { keys?: boolean }) => (
    <section data-pull-review="">
      <div data-scroller="" style={{ overflowY: 'auto' }}>
        {FILES.map((file) => (
          <div key={file.path} data-guide-file-shell={file.path} data-guide-file-folded={folded.has(file.path) ? 'true' : 'false'}>
            <div data-file-header-path={file.path} tabIndex={0}>
              <div>
                <button type="button" data-file-collapse-toggle={folded.has(file.path) ? 'collapsed' : 'expanded'} onClick={() => clicks.push(`arrow ${file.path}`)} />
              </div>
              <button type="button" data-file-header-viewed="" onClick={() => clicks.push(`viewed ${file.path}`)} />
            </div>
            <table>
              <tbody>
                <tr data-line-type="context" data-line-index="0,0" />
                <tr data-line-type="change-addition" data-line-index="1,1" data-change={file.path} />
                <tr data-line-type="change-addition" data-line-index="2,2" />
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <textarea data-comment-box="" />
      {details && (
        <aside className="ib-prd" tabIndex={-1} data-pull-details="">
          <button type="button" data-in-details="">Reviewers</button>
        </aside>
      )}
      {keys && <ReviewKeys diff={diff} viewed={viewed} />}
    </section>
  );

  const mount = async (keys = true, options: ReviewOptions = {}) => {
    await act(async () => root.render(
      <>
        <InboxKeys />
        <Review keys={keys} {...options} />
      </>,
    ));
    scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        onScroll();
      },
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEW });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1500 });
    place(scroller, scrollTop, VIEW);
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: VIEW, height: VIEW, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    for (const file of FILES) {
      const shell = host.querySelector(`[data-guide-file-shell="${file.path}"]`)!;
      place(shell, file.top, 500);
      const rows = shell.querySelectorAll('tr');
      place(rows[0]!, file.change - 20, 20);
      place(rows[1]!, file.change, 20);
      place(rows[2]!, file.change + 20, 20);
    }
  };
  /** Files whose viewer is not mounted yet: no header, no rows, until the view comes near them. */
  const undraw = (paths: string[]) => {
    const later = paths.map((path) => {
      const shell = host.querySelector(`[data-guide-file-shell="${path}"]`)!;
      const parts = [...shell.children];
      for (const part of parts) part.remove();
      return { shell, parts, top: FILES.find((file) => file.path === path)!.top };
    });
    onScroll = () => {
      for (const { shell, parts, top } of later) if (scrollTop + VIEW > top && !shell.firstChild) shell.append(...parts);
    };
  };
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    onScroll = () => {};
    // The review's scroller, whichever review is drawn (a test that draws one without `mount` too).
    atPoint = () => host.querySelector('[data-scroller]');
    (document as { elementFromPoint: unknown }).elementFromPoint = () => atPoint();
    inbox = [];
    reached = [];
    clicks = [];
    scrollTop = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (document as { elementFromPoint: unknown }).elementFromPoint = realElementFromPoint;
  });

  test('with a review open, J moves to the next file and never the next thread', async () => {
    await mount();
    expect(press('j').defaultPrevented).toBe(true);
    expect(reached).toEqual(['src/b.ts']);
    press('ArrowDown');
    expect(reached).toEqual(['src/b.ts', 'src/c.ts']);
    // At the last file J stays (the page too), and it is still not the Inbox's.
    expect(press('j').defaultPrevented).toBe(true);
    press('k');
    expect(reached.slice(2)).toEqual(['src/b.ts']);
    press(']');
    press('Home');
    press('End');
    expect(reached.slice(3)).toEqual(['src/c.ts', 'src/a.ts', 'src/c.ts']);
    expect(inbox).toEqual([]);
  });

  test('N goes to the next change, across files, and Shift+N back; the Inbox’s N (first new message) does nothing', async () => {
    await mount();
    press('n');
    expect(reached).toEqual(['1,1']);
    press('n');
    expect(reached).toEqual(['1,1', '1,1']);
    expect(scrollTop).toBe(650 - VIEW / 2);
    press('N', { shiftKey: true });
    expect(scrollTop).toBe(100 - VIEW / 2);
    expect(inbox).toEqual([]);
  });

  test('N toward a file not drawn yet: its file comes on screen, then its change; never back to the same change', async () => {
    await mount();
    // The other files are not drawn until the view comes near them (each file's viewer mounts near the view): no
    // header, no arrow, no rows.
    undraw(['src/b.ts', 'src/c.ts']);
    press('n');
    expect(reached).toEqual(['1,1']);
    expect(scrollTop).toBe(100 - VIEW / 2);
    press('n');
    await frames();
    // b's file first (not drawn), then its change, centred.
    expect(reached).toEqual(['1,1', 'src/b.ts', '1,1']);
    expect(scrollTop).toBe(650 - VIEW / 2);
    expect(inbox).toEqual([]);
  });

  test('N past the last change and Shift+N before the first leave the page where it is; a collapsed file has none', async () => {
    await mount();
    press('n');
    press('n');
    expect(scrollTop).toBe(650 - VIEW / 2);
    // c is collapsed: b's change is the last one on the page.
    expect(press('n').defaultPrevented).toBe(true);
    await frames();
    expect(scrollTop).toBe(650 - VIEW / 2);
    expect(reached).toEqual(['1,1', '1,1']);
    press('N', { shiftKey: true });
    expect(scrollTop).toBe(100 - VIEW / 2);
    press('N', { shiftKey: true });
    await frames();
    expect(scrollTop).toBe(100 - VIEW / 2);
    expect(reached).toEqual(['1,1', '1,1', '1,1']);
    expect(inbox).toEqual([]);
  });

  test('N passes over a folded file not drawn yet (a generated file starts folded) to the next open one', async () => {
    await mount(true, { folded: new Set(['src/b.ts']) });
    // b has no arrow to say it is folded: its viewer is not mounted.
    undraw(['src/b.ts', 'src/c.ts']);
    press('n');
    press('n');
    await frames();
    // Never b: its file is not brought on screen and no change of it is looked for; c's change, centred.
    expect(reached).toEqual(['1,1', 'src/c.ts', '1,1']);
    expect(scrollTop).toBe(1100 - VIEW / 2);
    press('N', { shiftKey: true });
    await frames();
    expect(scrollTop).toBe(100 - VIEW / 2);
    expect(inbox).toEqual([]);
  });

  test('after Collapse all, N and Shift+N stay put: no change is on the page, none is looked for', async () => {
    await mount(true, { folded: new Set(FILES.map((file) => file.path)) });
    undraw(['src/b.ts', 'src/c.ts']);
    expect(press('n').defaultPrevented).toBe(true);
    await frames();
    press('N', { shiftKey: true });
    await frames();
    expect(reached).toEqual([]);
    expect(scrollTop).toBe(0);
    expect(inbox).toEqual([]);
  });

  test('J in the last file and K in the first stay put; J lands the keyboard on the file’s header', async () => {
    await mount();
    press('j');
    await frames();
    expect(document.activeElement).toBe(host.querySelector('[data-file-header-path="src/b.ts"]'));
    (document.activeElement as HTMLElement).blur();
    // Deep in the last file (its top above the view): there is no next file, so J does nothing.
    scrollTop = 1100;
    reached = [];
    press('j');
    expect(reached).toEqual([]);
    expect(scrollTop).toBe(1100);
    // Inside the first file: no file before it.
    scrollTop = 50;
    press('k');
    expect(reached).toEqual([]);
    expect(scrollTop).toBe(50);
    expect(inbox).toEqual([]);
  });

  test('a held X or V acts once: the file is not folded and unfolded, or ticked and unticked, over and over', async () => {
    await mount();
    press('x');
    press('x', { repeat: true });
    press('x', { repeat: true });
    press('v');
    press('v', { repeat: true });
    expect(clicks).toEqual(['arrow src/a.ts', 'viewed src/a.ts']);
  });

  test('Z opens the collapsed file again and never undoes; X folds and V ticks the file on screen', async () => {
    await mount();
    expect(press('z').defaultPrevented).toBe(true);
    expect(clicks).toEqual(['arrow src/c.ts']);
    expect(reached).toEqual(['src/c.ts']);
    scrollTop = 0;
    press('x');
    press('v');
    expect(clicks.slice(1)).toEqual(['arrow src/a.ts', 'viewed src/a.ts']);
    expect(inbox).toEqual([]);
  });

  test('C and A, whose features the Inbox’s review does not have yet, do nothing: no New message; P is not taken', async () => {
    await mount();
    expect(press('c').defaultPrevented).toBe(true);
    expect(press('a').defaultPrevented).toBe(true);
    expect(press('p').defaultPrevented).toBe(false);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    expect(inbox).toEqual([]);
  });

  test('G P, G I, G B, G S and G D still go where they go with a review open', async () => {
    await mount();
    for (const key of ['p', 'i', 'b', 's', 'd']) {
      press('g');
      press(key);
    }
    expect(inbox).toEqual(['go reviews', 'go inbox', 'go board', 'go settings', 'go drafts']);
    expect(reached).toEqual([]);
    // The key after G is only the Inbox's when it ends one of its sequences, and only in time.
    const key = (k: string) => new KeyboardEvent('keydown', { key: k, code: `Key${k.toUpperCase()}` });
    expect(endsSequence(key('p'), { event: key('g'), at: 1000 }, 1200)).toBe(true);
    expect(endsSequence(key('j'), { event: key('g'), at: 1000 }, 1200)).toBe(false);
    expect(endsSequence(key('p'), { event: key('g'), at: 1000 }, 2000)).toBe(false);
  });

  test('with focus in the PR’s Details, the keys are the panel’s: ↓ ↑ Home End scroll it and the diff behind it stays', async () => {
    await mount(true, { details: true });
    const inDetails = host.querySelector<HTMLElement>('[data-in-details]')!;
    inDetails.focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(press(key, {}, inDetails).defaultPrevented).toBe(false);
    for (const key of ['j', 'n', 'x', 'v']) press(key, {}, inDetails);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    expect(scrollTop).toBe(0);
  });

  test('a repository file open over the diff, or anything drawn over it, keeps the keys from the diff', async () => {
    await mount();
    // The PR page keeps the diff in place under a repository file (`visibility: hidden`), its scroller marked.
    scroller.setAttribute('data-repo-open', '');
    for (const key of ['j', 'n', 'x', 'ArrowDown']) press(key);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    scroller.removeAttribute('data-repo-open');
    // A sheet, a chat or a dialog drawn over the diff's middle line.
    const cover = document.createElement('div');
    document.body.append(cover);
    atPoint = () => cover;
    press('j');
    expect(reached).toEqual([]);
    atPoint = () => scroller;
    // An open menu anywhere: the keys are the menu's.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.getClientRects = () => [{}] as unknown as DOMRectList;
    document.body.append(menu);
    press('j');
    expect(reached).toEqual([]);
    menu.remove();
    cover.remove();
    // The diff on top again: J is the review's.
    press('j');
    expect(reached).toEqual(['src/b.ts']);
  });

  test('typing in the comment box triggers none of them', async () => {
    await mount();
    const box = host.querySelector('[data-comment-box]')!;
    for (const key of ['j', 'n', 'z', 'c', 'x', 'v', '[', ']']) expect(press(key, {}, box).defaultPrevented).toBe(false);
    expect(press('ArrowDown', {}, box).defaultPrevented).toBe(false);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    expect(inbox).toEqual([]);
  });

  test('a Shape board open over the review keeps its keys: the review’s stand down, and act again once it is hidden', async () => {
    await mount();
    const layer = document.createElement('section');
    layer.setAttribute('data-shape-layer', 'board-1');
    const card = document.createElement('button');
    layer.append(card);
    host.append(layer);
    for (const key of ['j', 'n', 'x', 'ArrowDown']) press(key);
    press('z', {}, card);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    // Landed on code from the board: the layer is hidden and the review is on screen again.
    layer.hidden = true;
    expect(press('j').defaultPrevented).toBe(true);
    expect(reached).toEqual(['src/b.ts']);
    layer.remove();
  });

  test('once the review leaves the screen every key has its Inbox meaning again', async () => {
    await mount();
    expect(openReviewKeys()?.claimed.has('J')).toBe(true);
    await mount(false);
    expect(openReviewKeys()).toBeNull();
    for (const key of ['j', 'n', 'z', 'c']) press(key);
    expect(inbox).toEqual(['next thread', 'first new', 'undo', 'new message']);
    expect(reached).toEqual([]);
    // ⌘Z is not Z: with the review open it is left to whoever undoes.
    await mount();
    expect(press('z', { metaKey: true }).defaultPrevented).toBe(false);
  });

  test('the shortcut map shows the review’s keys first, in its words, and leaves out the Inbox meanings they replace', async () => {
    const mapRows = () => [...document.querySelectorAll<HTMLElement>('[data-map-row]')].map((row) => row.dataset.mapRow);
    const drawMap = async (keys: boolean) => {
      await act(async () => root.render(
        <>
          <Review keys={keys} />
          <ShortcutMap onClose={() => {}} onSettings={() => {}} />
        </>,
      ));
    };
    await drawMap(true);
    const group = document.querySelector('section.ib-map-group[aria-label="Code review"]');
    expect(group?.querySelector('[data-map-row="review-file-tree.nextFile"] dt')?.textContent).toBe('Next file');
    expect(mapRows()).toContain('review-editor.nextChange');
    // J / K threads, N first new message, Z Undo and C New message are not what those keys do now.
    for (const row of ['inbox-thread.nextThread', 'inbox-thread.firstNew', 'inbox-thread.undo', 'inbox-app.compose']) expect(mapRows()).not.toContain(row);
    // A key the review does not take keeps its row.
    expect(mapRows()).toContain('inbox-thread.reply');
    expect(mapRows()).toContain('review-editor.toggleViewed');
    // Only keys that do something here: not C (file comments) or A (staging).
    for (const row of ['review-all-files-diff.addFileComment', 'review-editor.stageFile', 'review-markdown-preview.cycleMarkdownView']) expect(mapRows()).not.toContain(row);
    // A review without Viewed ticks: V does nothing, so it is not listed.
    await act(async () => root.render(
      <>
        <Review viewed={false} />
        <ShortcutMap onClose={() => {}} onSettings={() => {}} />
      </>,
    ));
    expect(mapRows()).toContain('review-editor.nextChange');
    expect(mapRows()).not.toContain('review-editor.toggleViewed');
    await drawMap(false);
    expect(document.querySelector('section.ib-map-group[aria-label="Code review"]')).toBeNull();
    for (const row of ['inbox-thread.nextThread', 'inbox-thread.firstNew', 'inbox-thread.undo', 'inbox-app.compose']) expect(mapRows()).toContain(row);
  });

  test('while a review has Z, a toast’s Undo offers no key, in the words a phone hears; it offers Z again after', async () => {
    const toast = { id: 1, icon: 'check' as const, lead: 'Marked read', onUndo: () => {} };
    const draw = async (keys: boolean) => {
      await act(async () => root.render(
        <>
          <Review keys={keys} />
          <InboxToast toast={toast} />
        </>,
      ));
    };
    await draw(true);
    expect(host.querySelector('[data-toast-undo]')?.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(toastSpeech(toast, false, true)).toBe('Marked read. Undo is available.');
    await draw(false);
    expect(host.querySelector('[data-toast-undo]')?.hasAttribute('aria-keyshortcuts')).toBe(true);
    expect(toastSpeech(toast, false, true)).toBe('Marked read. Press Z to undo.');
  });

  test('while the review’s keys stand down (Details, a menu), the map and the Undo toast are the Inbox’s again', async () => {
    const mapRows = () => [...document.querySelectorAll<HTMLElement>('[data-map-row]')].map((row) => row.dataset.mapRow);
    const toast = { id: 1, icon: 'check' as const, lead: 'Marked read', onUndo: () => {} };
    await act(async () => root.render(
      <>
        <Review details />
        <InboxToast toast={toast} />
      </>,
    ));
    const undo = () => host.querySelector('[data-toast-undo]')!;
    expect(undo().hasAttribute('aria-keyshortcuts')).toBe(false);
    // A menu opens: Z is the Inbox's Undo again, and the toast says so.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.getClientRects = () => [{}] as unknown as DOMRectList;
    document.body.append(menu);
    await act(async () => void document.body.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(undo().hasAttribute('aria-keyshortcuts')).toBe(true);
    expect(toastSpeech(toast, false, true)).toBe('Marked read. Press Z to undo.');
    menu.remove();
    await act(async () => void document.body.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(undo().hasAttribute('aria-keyshortcuts')).toBe(false);
    // The map opened with focus in the PR's Details: J / K threads, N and Z are the Inbox's, and listed as such.
    const inDetails = host.querySelector<HTMLElement>('[data-in-details]')!;
    await act(async () => inDetails.focus());
    await act(async () => root.render(
      <>
        <Review details />
        <ShortcutMap onClose={() => {}} onSettings={() => {}} />
      </>,
    ));
    expect(document.querySelector('section.ib-map-group[aria-label="Code review"]')).toBeNull();
    for (const row of ['inbox-thread.nextThread', 'inbox-thread.firstNew', 'inbox-thread.undo']) expect(mapRows()).toContain(row);
  });

  test('a review is not read for its changes until a key asks: a patch Pierre finds fault with says nothing on open', async () => {
    // A hunk that declares more lines than it has (Pierre logs it when it reads the patch).
    const bad = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,6 @@\n const a = 0;\n+const b = 1;\n';
    const errors: unknown[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await mount(true, { diff: bad });
      press('j');
      press('x');
      expect(errors).toEqual([]);
    } finally {
      console.error = real;
    }
  });

  test('every key is the code review app’s own: its registry entries, no binding of its own', () => {
    const production = listRegistryShortcuts(reviewSettingsShortcutRegistry);
    for (const ref of REVIEW_KEY_ACTIONS) {
      const entry = production.find((candidate) => candidate.scopeId === ref.scope.id && candidate.actionId === ref.action);
      expect(entry, `${ref.scope.id}.${ref.action}`).toBeDefined();
      expect(resolveShortcutBindings(ref.scope.shortcuts[ref.action]!)).toEqual(entry!.bindings);
      expect(ref.scope.shortcuts).toBe(reviewSettingsShortcutRegistry.find((scope) => scope.id === ref.scope.id)!.shortcuts);
    }
  });

  test('where a step goes: the file being read, the ends, and the collapsed file Z opens', () => {
    const files = [{ top: -600, bottom: -100 }, { top: -100, bottom: 400 }, { top: 400, bottom: 900 }];
    expect(stepOrigin(files, { top: 0, bottom: VIEW })).toBe(1);
    expect(stepOrigin([{ top: 200, bottom: 300 }], { top: 0, bottom: VIEW })).toBe(-1);
    // At the start of the view, a first file held below the top by what is drawn above it (a chapter's title) counts
    // as reached, so J goes on to the next; out of view, or scrolled, it does not.
    expect(stepOrigin([{ top: 150, bottom: 300 }, { top: 300, bottom: 800 }], { top: 0, bottom: VIEW }, true)).toBe(0);
    expect(stepOrigin([{ top: 500, bottom: 900 }], { top: 0, bottom: VIEW }, true)).toBe(-1);
    expect(stepOrigin([{ top: 150, bottom: 300 }], { top: 0, bottom: VIEW }, false)).toBe(-1);
    // Where a jump leaves a file in a guided review's chapter (30 px down, its margin and its card's edge): that file is
    // the one being read, so J goes on to the next and never back to it.
    expect(stepOrigin([{ top: 76, bottom: 2600 }, { top: 2605, bottom: 3400 }], { top: 46, bottom: 893 })).toBe(0);
    expect(activeFile(files, { top: 0, bottom: VIEW })).toBe(1);
    expect(fileStep('next', -1, 3)).toBe(0);
    expect(fileStep('next', 2, 3)).toBe(2);
    expect(fileStep('prev', -1, 3)).toBeNull();
    expect(fileStep('prev', 0, 3)).toBe(0);
    expect(reopenTarget([true, false, true, false], 3)).toBe(2);
    expect(reopenTarget([false, false, true], 0)).toBe(2);
    expect(reopenTarget([false, false], 1)).toBeNull();
  });

  test('the change a step picks: every change of the file, drawn or not, placed as production places them', () => {
    const shell = document.createElement('div');
    shell.dataset.guideFileFolded = 'false';
    // Rows 30 to 50 drawn, 40 a change's first row; the file's other changes start at 1 (above) and 90 (below).
    shell.innerHTML = Array.from({ length: 21 }, (_, i) => `<div data-line-index="${30 + i},${30 + i}" data-line-type="${30 + i === 40 ? 'change-addition' : 'context'}"></div>`).join('');
    [...shell.children].forEach((row, i) => ((row as HTMLElement).getBoundingClientRect = () => ({ top: i * 20, bottom: i * 20 + 20, height: 20 }) as DOMRect));
    shell.getBoundingClientRect = () => ({ top: -600, bottom: 1400 }) as DOMRect;
    const changes = [1, 40, 90].map((unifiedIndex) => ({ unifiedIndex, lineNumber: unifiedIndex + 1, side: 'additions' as const }));
    const pick = (shells: HTMLElement[], line: number, direction: 'next' | 'prev', from: { shell: HTMLElement; index: number } | null = null) => {
      const spot = changeTarget(shells, () => changes, line, direction, from);
      return spot && [spot.change.unifiedIndex, spot.placement, !!spot.el];
    };
    // Reading line at 300: row 40 is drawn at 200, above it; 90 is past the drawn rows, 1 before them.
    expect(pick([shell], 300, 'next')).toEqual([90, 'after', false]);
    expect(pick([shell], 300, 'prev')).toEqual([40, 'before', true]);
    expect(pick([shell], 100, 'next')).toEqual([40, 'after', true]);
    // From the change it landed on: the one after or before it in the file.
    expect(pick([shell], 300, 'prev', { shell, index: 40 })).toEqual([1, 'before', false]);
    // A file not drawn yet: by where its box is.
    const notDrawn = document.createElement('div');
    notDrawn.dataset.guideFileFolded = 'false';
    notDrawn.getBoundingClientRect = () => ({ top: 900, bottom: 1500 }) as DOMRect;
    expect(pick([notDrawn], 300, 'next')).toEqual([1, 'after', false]);
    expect(pick([notDrawn], 300, 'prev')).toBeNull();
    // A folded file, drawn or not (its card says so on its shell): none.
    const folded = document.createElement('div');
    folded.dataset.guideFileFolded = 'true';
    folded.getBoundingClientRect = () => ({ top: 900, bottom: 1500 }) as DOMRect;
    expect(pick([folded], 300, 'next')).toBeNull();
    expect(pick([folded, notDrawn], 300, 'next')).toEqual([1, 'after', false]);
  });

  test('a step reads the files one at a time the way it goes, and stops at the first with a change', () => {
    const box = (top: number) => {
      const shell = document.createElement('div');
      shell.dataset.guideFileFolded = 'false';
      shell.getBoundingClientRect = () => ({ top, bottom: top + 500 }) as DOMRect;
      return shell;
    };
    // A big review: files above the view, the one being read, and many below, none drawn.
    const shells = Array.from({ length: 200 }, (_, i) => box(-5000 + i * 500));
    const read: number[] = [];
    const changesOf = (shell: HTMLElement) => {
      const at = shells.indexOf(shell);
      read.push(at);
      // File 10 has no change (a rename, a mode change).
      return at === 10 ? [] : [{ unifiedIndex: 1, lineNumber: 2, side: 'additions' as const }];
    };
    // The reading line at 200, in file 10 (0 to 500): the files above it are not read, and 10 has no change, so 11.
    expect(shells.indexOf(changeTarget(shells, changesOf, 200, 'next')!.shell)).toBe(11);
    expect(read).toEqual([10, 11]);
    read.length = 0;
    // From file 9's change on: file 10 has none, so 11.
    expect(shells.indexOf(changeTarget(shells, changesOf, 200, 'next', { shell: shells[9]!, index: 1 })!.shell)).toBe(11);
    expect(read).toEqual([9, 10, 11]);
    read.length = 0;
    // Back: the files below the reading line are not read; file 9 is the first before it with a change.
    expect(shells.indexOf(changeTarget(shells, changesOf, 200, 'prev')!.shell)).toBe(9);
    expect(read).toEqual([9]);
  });
});
