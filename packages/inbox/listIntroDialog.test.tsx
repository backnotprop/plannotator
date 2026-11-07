/**
 * "Choose how your list looks" as drawn (components/ListLookIntro.tsx, approval "inbox-rows-dialog", round 7b). What
 * regresses: a look picked before the person picks one, Done saving with nothing picked, Keep as it is or Escape (or
 * "Customize rows") saving anything, Done saving something other than the picked look whole, "Current" on the wrong
 * look, the card not showing the person's own rows in the picked look, the demo not ending on the held picture (left
 * alone, on a key or a click, or at once under reduced motion), and `lightScope`'s palette fallback for the dialogs
 * that still draw a light picture.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { LIST_LOOK_DEFAULT, type ListLook } from './listLook';
import type { ListIntroGroup } from './components/ListLookIntro';

const hasDom = typeof document !== 'undefined';
const { ListLookIntro, lightScope } = (hasDom ? await import('./components/ListLookIntro') : {}) as typeof import('./components/ListLookIntro');
const { ROWS_PRESETS } = (hasDom ? await import('./components/RowsSettings') : {}) as typeof import('./components/RowsSettings');

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

const GROUPS: ListIntroGroup[] = [
  { id: 'waiting', label: 'Waiting on you', count: 3, rows: [row('a'), row('b'), row('c')] },
  { id: 'new', label: 'New since you looked', count: 3, rows: [row('d'), row('e'), row('f')] },
];

/** Reduced motion on or off for the next render (the dialog reads it when it opens). */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

type Seen = { done: ListLook } | 'keep' | 'customize';

function render(initial: ListLook = LIST_LOOK_DEFAULT) {
  const seen: Seen[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ListLookIntro groups={GROUPS} initial={initial} phone={false} onDone={(look) => seen.push({ done: look })} onKeep={() => seen.push('keep')} onCustomize={() => seen.push('customize')} />);
  });
  const dialog = host.querySelector('dialog[data-dialog="list-look-intro"]') as HTMLDialogElement;
  return { dialog, seen };
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const looks = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLInputElement>('.ib-rl-look input[type="radio"]')];
const pickLook = (dialog: HTMLElement, id: string) => act(() => dialog.querySelector<HTMLInputElement>(`[data-list-intro-look="${id}"] input`)!.click());
const done = (dialog: HTMLElement) => dialog.querySelector('[data-list-intro-done]') as HTMLButtonElement;
const scene = (dialog: HTMLElement) => dialog.querySelector('[data-list-intro-picture]')!.getAttribute('data-scene');
const current = (dialog: HTMLElement) => [...dialog.querySelectorAll('.ib-rl-look')].filter((look) => look.querySelector('.ib-rl-cur')?.textContent === 'Current').map((look) => look.getAttribute('data-list-intro-look'));
const preset = (id: string) => ROWS_PRESETS.find((p) => p.id === id)!.look;

describe.skipIf(!hasDom)('Choose how your list looks', () => {
  test('nothing is picked when it opens, Done is disabled, and the person\'s look says "Current"', () => {
    motion(true);
    const { dialog, seen } = render(LIST_LOOK_DEFAULT);
    expect(looks(dialog).map((input) => input.value)).toEqual(['minimal', 'balanced', 'detailed']);
    expect(looks(dialog).filter((input) => input.checked)).toEqual([]);
    expect(dialog.querySelector('.ib-rl-art')!.hasAttribute('data-preview')).toBe(false);
    expect(done(dialog).disabled).toBe(true);
    act(() => done(dialog).click());
    expect(seen).toEqual([]);
    expect(current(dialog)).toEqual(['balanced']);
    // The words, as approved.
    expect(dialog.querySelector('#ib-lo-title')!.textContent).toBe('Choose how your list looks');
    expect(dialog.querySelector('#ib-lo-desc')!.textContent).toBe('Pick a look. Fine-tune it any time in Customize rows, from ⋮ above the list.');
  });

  test('"Current" follows the look: Minimal saved reads Minimal; a custom look marks none', () => {
    motion(true);
    expect(current(render(preset('minimal')).dialog)).toEqual(['minimal']);
    act(() => root?.unmount());
    host?.remove();
    expect(current(render({ ...LIST_LOOK_DEFAULT, compact: true }).dialog)).toEqual([]);
  });

  test("a pick raises the card with the person's own rows in that look; Done hands over that look, whole", () => {
    motion(true);
    const { dialog, seen } = render();
    pickLook(dialog, 'detailed');
    expect(dialog.querySelector('.ib-rl-art')!.getAttribute('data-preview')).toBe('detailed');
    expect(done(dialog).disabled).toBe(false);
    const layer = (id: string) => dialog.querySelector(`.ib-rl-cl[data-look="${id}"]`)!;
    expect([...dialog.querySelectorAll('.ib-rl-cl[data-on]')].map((l) => l.getAttribute('data-look'))).toEqual(['detailed']);
    // The person's threads, drawn by the list's rows: Detailed with its letter avatars, Minimal title first.
    expect([...layer('detailed').querySelectorAll('[data-thread-id]')].map((r) => r.getAttribute('data-thread-id'))).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(layer('detailed').querySelector('.ib-lm-av')).not.toBeNull();
    expect(layer('minimal').querySelector('.ib-listcol')!.classList.contains('ib-lk-tfirst')).toBe(true);
    expect(layer('minimal').querySelector('.ib-lm-av')).toBeNull();
    // A second pick changes the look shown; nothing is saved before Done.
    pickLook(dialog, 'minimal');
    expect([...dialog.querySelectorAll('.ib-rl-cl[data-on]')].map((l) => l.getAttribute('data-look'))).toEqual(['minimal']);
    expect(seen).toEqual([]);
    act(() => done(dialog).click());
    expect(seen).toEqual([{ done: preset('minimal') }]);
  });

  test('Keep as it is and Escape hand over nothing, even with a look picked; "Customize rows" saves nothing either', () => {
    motion(true);
    const { dialog, seen } = render();
    pickLook(dialog, 'detailed');
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => (dialog.querySelector('[data-list-intro-keep]') as HTMLElement).click());
    act(() => (dialog.querySelector('[data-list-intro-customize]') as HTMLElement).click());
    expect(seen).toEqual(['keep', 'keep', 'customize']);
  });

  test('left alone, the demo runs to the stacked look and holds it', async () => {
    motion(false);
    const { dialog } = render();
    expect(scene(dialog)).toBe('off');
    expect(dialog.querySelector('.ib-rl-stack')!.hasAttribute('data-off')).toBe(true);
    await wait(1600);
    expect(scene(dialog)).toBe('projects');
    await wait(1200);
    expect(scene(dialog)).toBe('held');
    expect(dialog.querySelector('.ib-rl-comp')!.getAttribute('data-marks')).toBe('both');
    expect(dialog.querySelector('.ib-rl-stack')!.hasAttribute('data-off')).toBe(false);
    await wait(600);
    expect(scene(dialog)).toBe('held');
  });

  test('a key during the demo jumps to the held picture at once, with no motion left; a pick during it also picks', async () => {
    motion(false);
    const { dialog } = render();
    await wait(400);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(scene(dialog)).toBe('held');
    expect(dialog.querySelector('.ib-rl-comp')!.hasAttribute('data-moving')).toBe(false);
    act(() => root?.unmount());
    host?.remove();
    const again = render();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    pickLook(again.dialog, 'balanced');
    expect(scene(again.dialog)).toBe('held');
    expect(done(again.dialog).disabled).toBe(false);
  });

  test('reduced motion: it opens on the held picture, the notes card in, nothing moving', () => {
    motion(true);
    const { dialog } = render();
    expect(scene(dialog)).toBe('held');
    expect(dialog.querySelector('.ib-rl-stack')!.hasAttribute('data-off')).toBe(false);
    expect(dialog.querySelector('[data-moving]')).toBeNull();
  });

  test('the picture and the card are out of reach: inert and hidden from a screen reader; focus starts on the looks', () => {
    motion(true);
    const { dialog } = render();
    for (const part of [dialog.querySelector('[data-list-intro-picture]')!, dialog.querySelector('.ib-rl-card')!]) {
      expect(part.hasAttribute('inert')).toBe(true);
      expect(part.getAttribute('aria-hidden')).toBe('true');
    }
    expect(document.activeElement).toBe(looks(dialog)[0]!);
  });

  test("lightScope (the List view's and voice dialogs' light picture): the person's light palette, else Plannotator's", () => {
    expect(lightScope('kanagawa-lotus')).toBe('ib-lightscope theme-kanagawa-lotus light');
    expect(lightScope('andromeeda')).toBe('ib-lightscope theme-plannotator light');
  });
});
