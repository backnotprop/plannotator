/**
 * The one-time list options dialog as drawn (components/ListLookIntro.tsx, approval "inbox-list-options-intro"): it
 * opens at the list's look (the defaults when the ⋮ menu was never used); the preview turns the options on in turn
 * while the switches are inert (no pointer, no focus, not announced); any key ends the preview at once, back to where
 * it opened; none under reduced motion; Done hands over the switches as they stand; Escape and Keep as it is hand
 * over nothing; Tab stays inside the dialog and never lands on the picture's rows; the picture is a light scope on the
 * person's light palette whatever the window's mode (the owner, 2026-10-31), and only the picture: the dialog itself
 * follows the window's mode.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { LIST_LOOK_OFF, type ListLook } from './listLook';
import type { ListIntroGroup } from './components/ListLookIntro';

const hasDom = typeof document !== 'undefined';
const { ListLookIntro, lightScope } = (hasDom ? await import('./components/ListLookIntro') : {}) as typeof import('./components/ListLookIntro');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  if (hasDom) window.matchMedia = realMatchMedia!;
});

function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing' },
    thread_name: `Name of ${id}`,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const GROUPS: ListIntroGroup[] = [{ id: 'waiting', label: 'Waiting on you', count: 3, rows: [row('a'), row('b'), row('c')] }];

/** Reduced motion on or off for the next render (the dialog reads it when it opens). */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

function render(initial: ListLook = LIST_LOOK_OFF) {
  const seen: (ListLook | 'keep')[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ListLookIntro groups={GROUPS} initial={initial} phone={false} onDone={(look) => seen.push(look)} onKeep={() => seen.push('keep')} />);
  });
  const dialog = host.querySelector('dialog[data-dialog="list-look-intro"]') as HTMLDialogElement;
  return { dialog, seen };
}

const checked = (dialog: HTMLElement) =>
  Object.fromEntries([...dialog.querySelectorAll('[data-list-intro-option]')].map((sw) => [sw.getAttribute('data-list-intro-option'), sw.getAttribute('aria-checked') === 'true']));
const group = (dialog: HTMLElement) => dialog.querySelector('[role="group"][aria-label="List options"]') as HTMLElement;
const preview = (dialog: HTMLElement) => dialog.querySelector('[data-list-intro-preview]') as HTMLElement;
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const sw = (dialog: HTMLElement, key: string) => dialog.querySelector(`[data-list-intro-option="${key}"]`) as HTMLElement;
const doneButton = (dialog: HTMLElement) => dialog.querySelector('[data-list-intro-done]') as HTMLElement;
/** A Tab (or Shift+Tab) pressed on what has focus, as the browser sends it. */
function tab(shift = false) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
  });
}

describe.skipIf(!hasDom)('the list options dialog', () => {
  test('the preview: options on in turn, switches inert meanwhile; a key ends it at once, back to the defaults', async () => {
    motion(false);
    const { dialog } = render();
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
    // The switches are out of reach and out of the accessibility tree while it plays.
    expect(group(dialog).hasAttribute('inert')).toBe(true);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: false, hideAgents: false, smallNames: false });
    expect(preview(dialog).classList.contains('ib-lk-pill')).toBe(true);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: false, smallNames: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
    expect(group(dialog).hasAttribute('inert')).toBe(false);
    expect([...preview(dialog).classList].filter((c) => c.startsWith('ib-lk-'))).toEqual([]);
    // Nothing plays on after it: the rest of the steps were cancelled.
    await wait(1700);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
  });

  test('left alone, the preview turns on all four, then ends with every option off and the switches usable', async () => {
    motion(false);
    const { dialog } = render();
    await wait(1450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: true, smallNames: false });
    expect(preview(dialog).classList.contains('ib-lk-noagents')).toBe(true);
    await wait(500);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: true, smallNames: true });
    expect(preview(dialog).classList.contains('ib-lk-small')).toBe(true);
    expect(group(dialog).hasAttribute('inert')).toBe(true);
    await wait(700);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
    expect(group(dialog).hasAttribute('inert')).toBe(false);
  });

  test('reduced motion: no preview; the switches work at once and Done hands them over', async () => {
    motion(true);
    const { dialog, seen } = render();
    expect(group(dialog).hasAttribute('inert')).toBe(false);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
    act(() => (dialog.querySelector('[data-list-intro-option="compact"]') as HTMLElement).click());
    expect(preview(dialog).classList.contains('ib-lk-compact')).toBe(true);
    act(() => (dialog.querySelector('[data-list-intro-done]') as HTMLElement).click());
    expect(seen).toEqual([{ highlight: false, compact: true, hideAgents: false, smallNames: false }]);
  });

  test('Tab stays inside the dialog and skips the picture: Done to the first switch, and back with Shift+Tab', () => {
    motion(true);
    const { dialog } = render();
    // The picture holds the real rows' buttons, all inert.
    expect(dialog.querySelector('.ib-lo-frame [data-thread-id]')).not.toBeNull();
    act(() => doneButton(dialog).focus());
    tab();
    expect(document.activeElement).toBe(sw(dialog, 'highlight'));
    tab(true);
    expect(document.activeElement).toBe(doneButton(dialog));
  });

  test('the first Tab during the preview ends it and reaches the switches', async () => {
    motion(false);
    const { dialog } = render();
    await wait(450);
    expect(group(dialog).hasAttribute('inert')).toBe(true);
    act(() => doneButton(dialog).focus());
    tab();
    expect(group(dialog).hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(sw(dialog, 'highlight'));
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false, smallNames: false });
  });

  test('options already set from the ⋮ menu: it opens at them, the preview returns to them, Done keeps them', async () => {
    motion(false);
    const { dialog, seen } = render({ highlight: false, compact: true, hideAgents: false, smallNames: false });
    expect(checked(dialog)).toEqual({ highlight: false, compact: true, hideAgents: false, smallNames: false });
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: false, smallNames: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(checked(dialog)).toEqual({ highlight: false, compact: true, hideAgents: false, smallNames: false });
    act(() => doneButton(dialog).click());
    expect(seen).toEqual([{ highlight: false, compact: true, hideAgents: false, smallNames: false }]);
  });

  test('only the picture is light: a light scope on the light palette; the dialog and the window keep their mode', () => {
    motion(true);
    document.documentElement.classList.remove('light');
    const { dialog } = render();
    // The picture: a light scope (the window's tokens worked out again), the palette's light half, `light`.
    const picture = dialog.querySelector('[data-list-intro-picture]')!;
    for (const cls of ['ib-lo-frame', 'ib-lightscope', 'theme-plannotator', 'light']) expect(picture.classList.contains(cls)).toBe(true);
    expect(picture.querySelector('[data-list-intro-preview]')).not.toBeNull();
    // Nothing else is: the dialog, its words, switches and actions follow the window's mode.
    expect([...document.querySelectorAll('.light, .ib-lightscope')]).toEqual([picture]);
    // Not a second window root: the window's .pn-inbox layout rules and its menus' portals never reach it.
    expect([...document.querySelectorAll('.pn-inbox')]).toEqual([host!]);
    expect(picture.closest('.pn-inbox')).toBe(host);
    expect(dialog.classList.contains('light')).toBe(false);
    expect(picture.contains(dialog.querySelector('#ib-lo-title'))).toBe(false);
    expect(picture.contains(dialog.querySelector('[role="switch"]'))).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    // A palette with no light half falls back to Plannotator's own; a light-only one is used.
    expect(lightScope('kanagawa-lotus')).toBe('ib-lightscope theme-kanagawa-lotus light');
    expect(lightScope('andromeeda')).toBe('ib-lightscope theme-plannotator light');
  });

  test('Escape and Keep as it is hand over nothing', () => {
    motion(true);
    const first = render();
    act(() => {
      first.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => (first.dialog.querySelector('[data-list-intro-keep]') as HTMLElement).click());
    expect(first.seen).toEqual(['keep', 'keep']);
  });
});
