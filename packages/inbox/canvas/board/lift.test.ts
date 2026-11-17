/**
 * The lift keeps the agent's ids (docs/agent-guides/inbox-canvas.md): every element it makes belongs to a part of the
 * board by id (`id`, or `id~…` for a part's other elements), the same board lifts to the same ids, a change to one
 * part leaves every other part's ids alone (the person's pins and the read-back follow parts by these ids), a container
 * is a group its parts move with, and a part the person pinned lands where they left it, at the size they gave it.
 *
 * The DOM test world lays nothing out, so a small stand-in layout gives every box a place: each element stacks below
 * its earlier siblings inside its parent, honours its own width, height, left and top, and words sit at their element.
 * What is proved is the lift's own work on those measurements, not the browser's layout (the Inbox window does that).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CanvasElement } from '@plannotator/core/canvas-scene';

const hasDom = typeof document !== 'undefined';
const { liftBoard } = (hasDom ? await import('./lift') : {}) as typeof import('./lift');

type Box = { x: number; y: number; w: number; h: number };
const px = (v: string) => (v.endsWith('px') ? parseFloat(v) : NaN);

function layout(el: Element): Box {
  const parent = el.parentElement;
  if (!parent || el === el.ownerDocument.body) return { x: 0, y: 0, w: 1200, h: 2000 };
  const P = layout(parent);
  const style = (el as HTMLElement).style;
  let y = P.y + 8;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) y += height(s) + 4;
  const w = px(style.width) || Math.max(40, P.w - 16);
  return { x: P.x + 8 + (px(style.left) || 0), y: y + (px(style.top) || 0), w, h: height(el) };
}
function height(el: Element): number {
  const style = (el as HTMLElement).style;
  if (getComputedStyle(el).display === 'none' || el.matches('style')) return 0;
  const own = px(style.height);
  if (own) return own;
  const kids = [...el.children].filter((k) => !k.matches('style'));
  if (!kids.length) return 24;
  return 16 + kids.reduce((n, k) => n + height(k) + 4, 0);
}
const rect = (b: Box) => ({ x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, toJSON() {} });

const saved: [object, string, PropertyDescriptor | undefined][] = [];
const stub = (proto: object, name: string, fn: unknown) => {
  saved.push([proto, name, Object.getOwnPropertyDescriptor(proto, name)]);
  Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn });
};

beforeAll(() => {
  if (!hasDom) return;
  stub(Element.prototype, 'getBoundingClientRect', function (this: Element) {
    return rect(layout(this));
  });
  // Words: at their element, inset a little (one line: the stand-in never wraps).
  const wordsRect = (range: Range) => {
    const p = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : (range.startContainer as Element))!;
    const b = layout(p);
    return rect({ x: b.x + 4, y: b.y + 3, w: Math.min(80, b.w - 8), h: 18 });
  };
  stub(Range.prototype, 'getClientRects', function (this: Range) {
    return [wordsRect(this)];
  });
  stub(Range.prototype, 'getBoundingClientRect', function (this: Range) {
    return wordsRect(this);
  });
});
afterAll(() => {
  for (const [proto, name, d] of saved.reverse()) {
    if (d) Object.defineProperty(proto, name, d);
    else delete (proto as Record<string, unknown>)[name];
  }
});

const BOARD = `<div id="app" data-frame="phone">
 <div id="header" style="padding:12px;background:var(--paper);border:1px solid var(--rule)">
  <p id="title" style="font-size:18px;color:var(--ink)">Settings</p>
 </div>
 <div id="group-a" style="background:var(--paper);border:1px solid var(--rule);border-radius:12px">
  <div id="row-1" style="padding:14px;border-bottom:1px solid var(--rule)">
   <p id="row-1-label" style="font-size:16px;color:var(--ink)">Push notifications</p>
   <i id="toggle-1" style="width:44px;height:26px;border-radius:13px;background:var(--green)"></i>
  </div>
  <div id="row-2" style="padding:14px;background:var(--sunk)">
   <p id="row-2-label" style="font-size:16px;color:var(--ink)">Email updates</p>
   <i id="toggle-2" style="width:44px;height:26px;border-radius:13px;background:var(--sunk);border:1px solid var(--rule)"></i>
  </div>
 </div>
 <div id="delete" style="padding:12px;background:var(--red-soft);border:1px solid var(--red)">Delete account</div>
</div>
<aside id="note-1" data-note="toggle-2">Starts off.</aside>
<a id="to-delete" data-arrow from="note-1" to="delete">careful</a>`;

const BOARD_IDS = ['app', 'header', 'title', 'group-a', 'row-1', 'row-1-label', 'toggle-1', 'row-2', 'row-2-label', 'toggle-2', 'delete', 'note-1', 'to-delete'];
const lift = (board: string, pins = {}) => liftBoard({ board, pins, pictureUrl: (n) => `/files/${n}` });
const ids = (els: CanvasElement[]) => els.map((e) => e.id).sort();
const partOfEl = (e: CanvasElement) => (e.customData as { part?: string } | undefined)?.part;

test.skipIf(!hasDom)("every element belongs to one of the board's parts, by the agent's id: the part's own id or id~…", async () => {
  const { elements, parts } = await lift(BOARD);
  expect(elements.length).toBeGreaterThan(BOARD_IDS.length);
  for (const e of elements) {
    const part = partOfEl(e);
    expect(BOARD_IDS).toContain(part!);
    expect(e.id === part || e.id.startsWith(`${part}~`)).toBe(true);
  }
  // Every part the board names is known, and ids are never made up or repeated.
  for (const id of BOARD_IDS) expect(parts[id]).toBeDefined();
  expect(new Set(elements.map((e) => e.id)).size).toBe(elements.length);
  // A painted part's main element is the part's own id.
  for (const id of ['header', 'group-a', 'row-2', 'toggle-1', 'toggle-2', 'delete']) expect(elements.some((e) => e.id === id)).toBe(true);
});

test.skipIf(!hasDom)('the same board lifts to the same ids, at the same places', async () => {
  const a = await lift(BOARD);
  const b = await lift(BOARD);
  expect(ids(b.elements)).toEqual(ids(a.elements));
  const where = (els: CanvasElement[]) => Object.fromEntries(els.map((e) => [e.id, [e.x, e.y, e.width, e.height]]));
  expect(where(b.elements)).toEqual(where(a.elements));
});

test.skipIf(!hasDom)("a change to one part leaves every other part's ids alone; a new part adds only its own", async () => {
  const before = await lift(BOARD);
  const reworded = await lift(BOARD.replace('Email updates', 'Weekly email digest'));
  expect(ids(reworded.elements)).toEqual(ids(before.elements));
  const textOf = (els: CanvasElement[], id: string) => (els.find((e) => e.id === id) as { text?: string } | undefined)?.text;
  expect(textOf(reworded.elements, 'row-2-label')).toBe('Weekly email digest');
  expect(textOf(reworded.elements, 'row-1-label')).toBe(textOf(before.elements, 'row-1-label'));

  const added = await lift(BOARD.replace('</div>\n <div id="delete"', '<div id="row-3" style="padding:14px"><p id="row-3-label">Face ID</p></div>\n </div>\n <div id="delete"'));
  const fresh = ids(added.elements).filter((id) => !before.elements.some((e) => e.id === id));
  expect(fresh.length).toBeGreaterThan(0);
  for (const id of fresh) expect(['row-3', 'row-3-label']).toContain(partOfEl(added.elements.find((e) => e.id === id)!)!);
  for (const e of before.elements) expect(added.elements.some((x) => x.id === e.id)).toBe(true);
});

test.skipIf(!hasDom)('a container is a group: its parts carry its id (innermost first), parts outside it do not', async () => {
  const { elements } = await lift(BOARD);
  const el = (id: string) => elements.find((e) => e.id === id)!;
  expect(el('toggle-2').groupIds).toEqual(['row-2', 'group-a', 'app']);
  expect(el('row-2-label').groupIds).toEqual(['row-2', 'group-a', 'app']);
  expect(el('row-2').groupIds).toEqual(['row-2', 'group-a', 'app']);
  expect(el('toggle-1').groupIds).toEqual(['row-1', 'group-a', 'app']);
  expect(el('toggle-1').groupIds).not.toContain('row-2');
  expect(el('delete').groupIds).toEqual(['app']);
  // A note and an arrow stand outside the phone.
  expect(el('to-delete').groupIds).toEqual([]);
  expect(el('note-1').groupIds ?? []).not.toContain('app');
});

test.skipIf(!hasDom)('a part the person pinned lands where they left it, at their size, and keeps its ids', async () => {
  const plain = await lift(BOARD);
  const pin = { x: 520, y: 310, w: 300, h: 70 };
  const pinned = await lift(BOARD, { 'delete': pin, 'toggle-1': { x: 600, y: 40, w: 60, h: 30 } });
  expect(ids(pinned.elements)).toEqual(ids(plain.elements));
  const was = plain.elements.find((e) => e.id === 'delete')!;
  expect([was.x, was.y, was.width, was.height]).not.toEqual([pin.x, pin.y, pin.w, pin.h]);
  const del = pinned.elements.find((e) => e.id === 'delete')!;
  expect([del.x, del.y, del.width, del.height]).toEqual([pin.x, pin.y, pin.w, pin.h]);
  const t1 = pinned.elements.find((e) => e.id === 'toggle-1')!;
  expect([t1.x, t1.y, t1.width, t1.height]).toEqual([600, 40, 60, 30]);
  // The arrow follows the pinned part: it still ends on it.
  const arrow = pinned.elements.find((e) => e.id === 'to-delete') as CanvasElement & { endBinding?: { elementId: string } };
  expect(arrow.endBinding?.elementId).toBe('delete');
});
