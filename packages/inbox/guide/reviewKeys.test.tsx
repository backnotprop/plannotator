/**
 * The code review app's keys on a review in the Inbox (guide/ReviewKeys.tsx; approval 2026-11-23: "Yes, the same keys
 * as code review", "Yes, the review's keys win while a review is open"). What would regress:
 *
 *  - with a review on screen, J, N, Z or C meaning their Inbox key (next thread, first new message, Undo, New
 *    message) instead of the review's, or a review key doing nothing where its control is on the page;
 *  - an Inbox key not coming back once the review has left the screen;
 *  - a review key firing while typing in a comment box;
 *  - a key whose feature the Inbox's review lacks (C, file comments) acting, or falling through to the Inbox;
 *  - a review key that is not the code review app's own (a new key, or retyped bindings drifting from production's).
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
import { reviewSettingsShortcutRegistry } from '@plannotator/review-editor/shortcuts';
import { REVIEW_KEY_ACTIONS, ReviewKeys } from './ReviewKeys';
import { activeFile, changeStarts, fileStep, reopenTarget, stepOrigin } from './reviewWalk';
import { bareKeyAllowed, inboxAppShortcuts, inboxThreadShortcuts } from '../shortcuts';
import { openReviewKeys } from '../shortcuts/review';
import { ShortcutMap } from '../components/ShortcutMap';

const hasDom = typeof document !== 'undefined';
const VIEW = 400;
const FILES = [
  { path: 'src/a.ts', top: 0, change: 100 },
  { path: 'src/b.ts', top: 500, change: 650 },
  { path: 'src/c.ts', top: 1000, change: 1100 },
];

/** What the Inbox's own keys did. */
let inbox: string[] = [];
const inboxKey = (name: string) => ({ when: (event: KeyboardEvent) => bareKeyAllowed(event), handle: () => void inbox.push(name) });
function InboxKeys() {
  useShortcutScope({ scope: inboxThreadShortcuts, handlers: { nextThread: inboxKey('next thread'), firstNew: inboxKey('first new'), undo: inboxKey('undo') } });
  useShortcutScope({ scope: inboxAppShortcuts, handlers: { compose: inboxKey('new message') } });
  return null;
}

describe.skipIf(!hasDom)('the review’s keys in the Inbox', () => {
  let root: Root;
  let host: HTMLElement;
  let scroller: HTMLElement;
  let scrollTop = 0;
  /** Where the page went: each file or change brought into view. */
  let reached: string[] = [];
  let clicks: string[] = [];

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
    };
  };

  const Review = ({ keys = true }: { keys?: boolean }) => (
    <section data-pull-review="">
      <div data-scroller="" style={{ overflowY: 'auto' }}>
        {FILES.map((file) => (
          <div key={file.path} data-guide-file-shell={file.path}>
            <div data-file-header-path={file.path}>
              <div>
                <button type="button" title={file.path === 'src/c.ts' ? 'Expand diff' : 'Collapse diff'} onClick={() => clicks.push(`arrow ${file.path}`)} />
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
      {keys && <ReviewKeys />}
    </section>
  );

  const mount = async (keys = true) => {
    await act(async () => root.render(
      <>
        <InboxKeys />
        <Review keys={keys} />
      </>,
    ));
    scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => void (scrollTop = value) });
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
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
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
  });

  test('with a review open, J moves to the next file and never the next thread', async () => {
    await mount();
    expect(press('j').defaultPrevented).toBe(true);
    expect(reached).toEqual(['src/b.ts']);
    press('ArrowDown');
    expect(reached).toEqual(['src/b.ts', 'src/c.ts']);
    // At the last file J stays, and it is still not the Inbox's.
    press('j');
    press('k');
    expect(reached.slice(2)).toEqual(['src/c.ts', 'src/b.ts']);
    press(']');
    press('Home');
    press('End');
    expect(reached.slice(4)).toEqual(['src/c.ts', 'src/a.ts', 'src/c.ts']);
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

  test('N from the top, with the next change not drawn yet: it scrolls on until it is, never back to the same change', async () => {
    await mount();
    // The other files' rows are not drawn until the view comes near them (a mounted viewer draws only rows near it).
    const later = FILES.slice(1).map((file) => {
      const tbody = host.querySelector(`[data-guide-file-shell="${file.path}"] tbody`)!;
      const rows = [...tbody.children];
      for (const row of rows) row.remove();
      return { file, tbody, rows };
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        for (const { file, tbody, rows } of later) if (scrollTop + VIEW > file.change && !tbody.firstChild) tbody.append(...rows);
      },
    });
    press('n');
    expect(reached).toEqual(['1,1']);
    expect(scrollTop).toBe(100 - VIEW / 2);
    scrollTop = 0;
    press('n');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(reached).toEqual(['1,1', '1,1']);
    expect(scrollTop).toBe(650 - VIEW / 2);
    expect(inbox).toEqual([]);
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

  test('C, whose feature the Inbox’s review does not have yet, does nothing: no New message', async () => {
    await mount();
    expect(press('c').defaultPrevented).toBe(true);
    expect(press('p').defaultPrevented).toBe(true);
    expect(press('a').defaultPrevented).toBe(true);
    expect(reached).toEqual([]);
    expect(clicks).toEqual([]);
    expect(inbox).toEqual([]);
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
    await drawMap(false);
    expect(document.querySelector('section.ib-map-group[aria-label="Code review"]')).toBeNull();
    for (const row of ['inbox-thread.nextThread', 'inbox-thread.firstNew', 'inbox-thread.undo', 'inbox-app.compose']) expect(mapRows()).toContain(row);
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
    expect(stepOrigin(files, 0)).toBe(1);
    expect(stepOrigin([{ top: 200, bottom: 300 }], 0)).toBe(-1);
    expect(activeFile(files, { top: 0, bottom: VIEW })).toBe(1);
    expect(fileStep('next', -1, 3)).toBe(0);
    expect(fileStep('next', 2, 3)).toBe(2);
    expect(fileStep('prev', -1, 3)).toBeNull();
    expect(fileStep('prev', 0, 3)).toBe(0);
    expect(reopenTarget([true, false, true, false], 3)).toBe(2);
    expect(reopenTarget([false, false, true], 0)).toBe(2);
    expect(reopenTarget([false, false], 1)).toBeNull();
  });

  test('a change counts by its first row: a run whose start is not drawn yet is no change of its own', () => {
    const shell = document.createElement('div');
    shell.innerHTML = [
      // Drawn from the middle of a long run (rows 40, 41), then context, then a change of its own.
      '<div data-line-index="40,40" data-line-type="change-addition"></div>',
      '<div data-line-index="41,41"></div><div data-line-index="41,41" data-line-type="change-addition"></div>',
      '<div data-line-index="42,42" data-line-type="context"></div>',
      '<div data-line-index="43,43" data-line-type="change-deletion"></div>',
      '<div data-line-index="44,44" data-line-type="change-addition"></div>',
    ].join('');
    const rows = [...shell.children] as HTMLElement[];
    shell.getBoundingClientRect = () => ({ top: -2000 }) as DOMRect;
    rows.forEach((row, i) => (row.getBoundingClientRect = () => ({ top: i * 20, bottom: i * 20 + 20, height: 20 }) as DOMRect));
    expect(changeStarts(shell).map((start) => start.index)).toEqual([43]);
    // At the top of its file the same row opens the file's first change.
    shell.getBoundingClientRect = () => ({ top: -40 }) as DOMRect;
    expect(changeStarts(shell).map((start) => start.index)).toEqual([40, 43]);
  });
});
