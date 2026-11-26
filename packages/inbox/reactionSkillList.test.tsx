/**
 * The skill (/) list of a saved emoji's name field, in the reaction tray, is all on screen (the owner, 2026-11-26:
 * "The list gets cut off"): typing "/br" in the tray's field opened the list above the field inside the tray's card,
 * whose clip-path (the field's opening reveal, `inset(-60px …)`) cut every row more than 60 px above it, and the list
 * was only as wide as the field, so each row's description was cut to a word.
 *
 * Pinned here: the list is drawn outside the card, in the tray's own positioner (so a press on a row is inside the
 * tray and its field stays open), placed as the reply box's list is (ComposerField's FloatingSkillMenu): above the
 * field with every row inside the viewport, below it when there is no room above, and wider than the field, kept
 * inside a phone's width (and a zoomed phone's visible part). Its room is the thread pane's under the pane's header,
 * as the reply box's is: drawn at the root, the tray's list once measured the whole window and opened over the header.
 * A whole mouse press on a row (down, then the release's click) keeps the field open.
 *
 * happy-dom does no layout: each box the list is placed from gets a rect here, the list its natural height
 * (rows × ROW), and the list's on-screen rect is derived from the placement it committed (side + max-height), as the
 * CSS resolves it (6 px from the box it hangs off).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyInboxReactionChange, parseInboxReactionChange, type InboxReaction } from '@plannotator/core/inbox-types';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const { ReactionTray } = (hasDom ? await import('./components/ReactionTray') : {}) as typeof import('./components/ReactionTray');
const { SKILL_LIST_WIDTH } = (hasDom ? await import('./components/SkillNameInput') : {}) as typeof import('./components/SkillNameInput');
const { resetSavedReactionsForTests } = await import('./reactions');
const catalogMod = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const ROW = 36;
const GAP = 6;
// Eight skills that all match "/br" (the owner's picture: browser-qa, brand-pack, …).
const SKILLS: SkillCatalogEntry[] = ['browser-qa', 'brand-pack', 'break-ui', 'brief-it', 'bring-up', 'broom', 'brush-up', 'bravo'].map((name) => ({
  name,
  root: 'claude' as const,
  description: 'Guide a hands-on check of the change in a real browser, step by step.',
  humanOnly: false,
}));

interface Box {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/**
 * The boxes this test lays out: the window, the tray's card and its positioner (the list's layer), the name field in
 * the card, a row's height, and the thread's header when the tray opens from a thread pane (`inPane`).
 */
const layout = {
  width: 1440,
  height: 900,
  pos: { top: 700, bottom: 800, left: 400, width: 214 } as Box,
  field: { top: 706, bottom: 736, left: 406, width: 202 } as Box,
  row: ROW,
  head: { top: 0, bottom: 56, left: 0, width: 1440 } as Box,
  /** A pinch-zoomed page: the part of the window's width the person sees (the visual viewport), else all of it. */
  seen: null as { left: number; width: number } | null,
};

const rect = (b: Box): DOMRect => ({ x: b.left, y: b.top, top: b.top, bottom: b.bottom, left: b.left, right: b.left + b.width, width: b.width, height: b.bottom - b.top, toJSON: () => ({}) }) as DOMRect;

let root: Root | null = null;
let mount: HTMLElement | null = null;
let restore: (() => void) | null = null;
let savedFetch: typeof fetch;

function stubLayout() {
  const proto = HTMLElement.prototype;
  const own = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-skanchor')) {
      // Laid out where its style puts it, against the layer it is drawn in.
      const layer = this.parentElement?.closest('.ib-react-pos') ? layout.pos : { top: 0, left: 0 };
      const top = layer.top + (parseFloat(this.style.top) || 0);
      return rect({ top, bottom: top + (parseFloat(this.style.height) || 0), left: layer.left + (parseFloat(this.style.left) || 0), width: parseFloat(this.style.width) || 0 });
    }
    if (this.matches('[data-skill-item]')) return rect({ top: 0, bottom: layout.row, left: 0, width: 300 });
    if (this.matches('.ib-phead')) return rect(layout.head);
    if (this.matches('.ib-namer-in, .ib-sknf')) return rect(layout.field);
    // The card and its layer (happy-dom reads every box's overflow as clipping, so the card needs its real box).
    if (this.matches('.ib-react-pos, .ib-react-pop')) return rect(layout.pos);
    if (this.matches('.pn-inbox')) return rect({ top: 0, bottom: layout.height, left: 0, width: layout.width });
    return rect({ top: 0, bottom: 0, left: 0, width: 0 });
  };
  const docRect = document.documentElement.getBoundingClientRect;
  document.documentElement.getBoundingClientRect = () => rect({ top: 0, bottom: layout.height, left: 0, width: layout.width });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, writable: true, value: () => document.querySelector('[data-name-field]') });
  const inner = { h: Object.getOwnPropertyDescriptor(window, 'innerHeight'), w: Object.getOwnPropertyDescriptor(window, 'innerWidth'), vv: Object.getOwnPropertyDescriptor(window, 'visualViewport') };
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => layout.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => layout.width });
  const vv = Object.assign(new EventTarget(), { offsetTop: 0 });
  Object.defineProperty(vv, 'height', { get: () => layout.height });
  Object.defineProperty(vv, 'width', { get: () => layout.seen?.width ?? layout.width });
  Object.defineProperty(vv, 'offsetLeft', { get: () => layout.seen?.left ?? 0 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
  restore = () => {
    proto.getBoundingClientRect = own;
    document.documentElement.getBoundingClientRect = docRect;
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
    for (const [key, d] of [['innerHeight', inner.h], ['innerWidth', inner.w], ['visualViewport', inner.vv]] as const) {
      if (d) Object.defineProperty(window, key, d);
      else delete (window as unknown as Record<string, unknown>)[key];
    }
  };
}

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  // The saved emoji's store, as the server keeps it (the tray saves 🚀 before its name field opens).
  let onServer: InboxReaction[] = [];
  let rev = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const change = parseInboxReactionChange(body.reaction_change);
    const next = change ? applyInboxReactionChange(onServer, change) : null;
    if (next) {
      onServer = next;
      rev += 1;
    }
    return new Response(JSON.stringify({ reactions: onServer, reactions_rev: rev }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  catalogMod.resetSkillCatalogCache();
  catalogMod.setSkillCatalogTransport(async () => SKILLS);
  layout.width = 1440;
  layout.height = 900;
  layout.pos = { top: 700, bottom: 800, left: 400, width: 214 };
  layout.field = { top: 706, bottom: 736, left: 406, width: 202 };
  layout.row = ROW;
  layout.head = { top: 0, bottom: 56, left: 0, width: 1440 };
  layout.seen = null;
  stubLayout();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  mount?.remove();
  mount = null;
  restore?.();
  restore = null;
  globalThis.fetch = savedFetch;
  resetSavedReactionsForTests();
  catalogMod.resetSkillCatalogTransport();
  catalogMod.resetSkillCatalogCache();
  document.body.innerHTML = '';
});

const settle = (ms = 60) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const menu = () => $('[data-skill-menu]');

async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
  await settle();
}

/**
 * The tray, + and 🚀: the name field over the tray, with "/br" typed into it and the list open. `inPane`: the tray's
 * 👍 is in a thread pane's foot, under the pane's header (`.ib-phead`, laid out at `layout.head`), as in the Inbox.
 */
async function typedInTray(words = '/br', { inPane = false } = {}): Promise<HTMLInputElement> {
  resetSavedReactionsForTests([]);
  mount = document.createElement('div');
  mount.className = 'pn-inbox';
  document.body.appendChild(mount);
  root = createRoot(mount);
  const foot = (
    <div className="ib-pfoot">
      <ReactionTray messageId="msg_1" agent="Claude Code" on={false} current={null} phone={false} onAck={() => {}} />
    </div>
  );
  act(() =>
    root!.render(
      inPane ? (
        <section className="ib-pane">
          <header className="ib-phead">Harbor search index</header>
          <div className="ib-pbody" data-behind="">
            The search index rebuild is done
          </div>
          {foot}
        </section>
      ) : (
        foot
      ),
    ),
  );
  await settle();
  const more = $('[data-react-more]')!;
  await act(async () => {
    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
  if (!$('[data-reaction-tray]')) await press(more);
  await press($('[data-reaction="add"]')!);
  await settle(80);
  await act(async () => $('.ib-emo [data-emo="🚀"]')!.click());
  await settle(220);
  const field = $('[data-name-field]') as HTMLInputElement;
  expect(field !== null).toBe(true);
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, words);
    field.setSelectionRange(words.length, words.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  // The list's natural height follows its rows; measure again with it.
  const list = $('[data-skill-menu-list]');
  if (list) Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => list.querySelectorAll('[data-skill-item]').length * layout.row });
  await act(async () => window.dispatchEvent(new Event('resize')));
  await settle();
  return field;
}

/** Where the list is on screen (never inside the tray's clipping card), from what it committed: its side, its list's height (natural, capped) and its anchor's box. */
function menuBox(): Box & { side: string } {
  const el = menu()!;
  // On screen means drawn outside the tray's card too: its clip-path cuts what is more than 60 px outside it.
  expect(el.closest('.ib-react-pop') === null).toBe(true);
  const list = el.querySelector<HTMLElement>('[data-skill-menu-list]')!;
  const side = el.getAttribute('data-skill-menu-placement')!;
  const height = Math.min(list.querySelectorAll('[data-skill-item]').length * layout.row, parseFloat(list.style.maxHeight));
  const anchor = (el.parentElement as HTMLElement).getBoundingClientRect();
  const top = side === 'above' ? anchor.top - GAP - height : anchor.bottom + GAP;
  return { side, top, bottom: top + height, left: anchor.left, width: anchor.width };
}

/**
 * A whole mouse press on a row, as a browser sends it: pointerdown on the row (which writes the pick, so the list
 * closes and the row leaves the page), then, from the same release, pointerup and mouseup on what is under the pointer
 * now (the thread behind the list) and the click on what the pressed row and that share (the window's root). Base UI's
 * Popover dismisses a mouse press on that click unless the press began inside the popover's layer.
 */
async function pressRow(row: HTMLElement) {
  await act(async () => {
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' }));
  });
  await settle();
  const under = row.isConnected ? row : $('[data-behind]')!;
  const clicked = row.isConnected ? row : mount!;
  await act(async () => {
    under.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    under.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    clicked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  });
  await settle();
}

test.skipIf(!hasDom)('the list is drawn in the tray\'s layer, outside its clipping card', async () => {
  await typedInTray('/br', { inPane: true });
  // Booleans, never elements: a failing match on a happy-dom element hangs bun's diff printer.
  expect(menu() !== null).toBe(true);
  // The owner's picture: inside `.ib-react-pop` (clip-path: inset(-60px)) the rows more than 60 px above the field were cut away.
  expect(menu()!.closest('.ib-react-pop') === null).toBe(true);
  expect(menu()!.closest('.ib-react-pos') !== null).toBe(true);
  expect(menu()!.parentElement!.classList.contains('ib-skanchor')).toBe(true);
});

test.skipIf(!hasDom)('a whole mouse press on a row writes the pick and keeps the field open', async () => {
  const field = await typedInTray('/br', { inPane: true });
  expect(menu() !== null).toBe(true);
  // A press on a row is inside the tray: the pick is written and the field stays, through the release's click.
  await pressRow($('[data-skill-item="brand-pack"]')!);
  expect($('[data-name-field]') !== null).toBe(true);
  expect(field.isConnected).toBe(true);
  expect(field.value).toBe('/brand-pack ');
});

test.skipIf(!hasDom)('a tray card 296 px from the top with 8 rows: the list keeps under the thread\'s header (below the card), never over it', async () => {
  // Rows as drawn (34 px): the list (8 rows, capped at 256 px) fits above the card in the window but not under the
  // header, which ends at 56; measured against the whole window it opened above, over the header's Back and actions.
  layout.row = 34;
  layout.pos = { top: 296, bottom: 388, left: 400, width: 214 };
  layout.field = { top: 302, bottom: 332, left: 406, width: 202 };
  await typedInTray('/br', { inPane: true });
  const box = menuBox();
  expect(box.top >= layout.head.bottom).toBe(true);
  // No room above under the header: below the card, as tall as the reply box's list may be (256 px, then it scrolls).
  expect(box.side).toBe('below');
  expect(box.top >= layout.pos.bottom).toBe(true);
  expect(box.bottom - box.top).toBe(256);
  expect(box.bottom <= layout.height).toBe(true);
});

test.skipIf(!hasDom)('the thread scrolls with the list open: once the card moves up where the list would cover the header, it goes below', async () => {
  layout.row = 34;
  layout.pos = { top: 340, bottom: 432, left: 400, width: 214 };
  layout.field = { top: 346, bottom: 378, left: 406, width: 202 };
  await typedInTray('/br', { inPane: true });
  expect(menuBox().side).toBe('above');
  // A scroll: the tray's positioner follows its anchor a frame later (Base UI), carrying the card and the list's layer.
  await act(async () => {
    requestAnimationFrame(() => {
      layout.pos = { top: 296, bottom: 388, left: 400, width: 214 };
      layout.field = { top: 302, bottom: 332, left: 406, width: 202 };
    });
    $('[data-behind]')!.dispatchEvent(new Event('scroll'));
  });
  await settle(120);
  const box = menuBox();
  expect(box.side).toBe('below');
  expect(box.top >= layout.head.bottom).toBe(true);
});

test.skipIf(!hasDom)('near the bottom of the window it opens above the tray\'s card, every row inside the viewport, wider than the field', async () => {
  await typedInTray();
  const box = menuBox();
  expect(box.side).toBe('above');
  expect(box.top >= 0).toBe(true);
  expect(box.bottom <= layout.pos.top).toBe(true);
  expect(menu()!.querySelectorAll('[data-skill-item]').length).toBe(8);
  // Readable rows: as wide as SKILL_LIST_WIDTH, from the card's left edge.
  expect(box.width).toBe(SKILL_LIST_WIDTH);
  expect(box.left).toBe(layout.pos.left);
});

test.skipIf(!hasDom)('near the top of the window (no room above) it opens below the tray\'s card, never over its emoji, inside the viewport', async () => {
  layout.pos = { top: 40, bottom: 140, left: 400, width: 214 };
  layout.field = { top: 46, bottom: 76, left: 406, width: 202 };
  await typedInTray();
  const box = menuBox();
  expect(box.side).toBe('below');
  expect(box.top >= layout.pos.bottom).toBe(true);
  expect(box.bottom <= layout.height).toBe(true);
});

test.skipIf(!hasDom)('a short window: the list is capped to the room it has and scrolls, never past the viewport', async () => {
  layout.height = 420;
  layout.pos = { top: 200, bottom: 300, left: 400, width: 214 };
  layout.field = { top: 206, bottom: 236, left: 406, width: 202 };
  await typedInTray();
  const box = menuBox();
  expect(box.top >= 0).toBe(true);
  expect(box.bottom <= layout.height).toBe(true);
  // Fewer rows fit than there are: the list scrolls in what is left.
  expect(box.bottom - box.top < 8 * ROW).toBe(true);
});

test.skipIf(!hasDom)('on a phone the widened list stays inside the window\'s width', async () => {
  layout.width = 390;
  layout.height = 844;
  layout.pos = { top: 600, bottom: 700, left: 180, width: 214 };
  layout.field = { top: 606, bottom: 636, left: 186, width: 202 };
  await typedInTray();
  const box = menuBox();
  expect(box.left >= 0).toBe(true);
  expect(box.left + box.width <= layout.width).toBe(true);
  expect(box.width > layout.field.width).toBe(true);
});

test.skipIf(!hasDom)('a pinch-zoomed phone: the widened list stays inside the part of the window the person sees', async () => {
  layout.width = 390;
  layout.height = 844;
  // Zoomed in and panned right: x 90 to 390 is what shows; the card starts left of it.
  layout.seen = { left: 90, width: 300 };
  layout.pos = { top: 600, bottom: 700, left: 40, width: 214 };
  layout.field = { top: 606, bottom: 636, left: 46, width: 202 };
  await typedInTray();
  const box = menuBox();
  expect(box.left >= layout.seen.left).toBe(true);
  expect(box.left + box.width <= layout.seen.left + layout.seen.width).toBe(true);
});
