/**
 * Failures to catch: a root with no slot is not left exactly as is; the two directions disagree;
 * web-highlighter's sentinel indexes are rewritten; a position inside the slot is renumbered.
 */
import { afterEach, expect, test } from 'bun:test';
import { BELOW_TITLE_SLOT_ATTRIBUTE, BELOW_TITLE_SLOT_MARKER, metaWithBelowTitle, metaWithoutBelowTitle } from './belowTitleSlot';

const hasDom = typeof document !== 'undefined';

afterEach(() => { if (hasDom) document.body.replaceChildren(); });

function build(withSlot: boolean): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = [
    '<h1>T</h1>',
    withSlot ? `<div ${BELOW_TITLE_SLOT_ATTRIBUTE}="${BELOW_TITLE_SLOT_MARKER}"><p>a</p><p>b</p></div>` : '',
    '<p>one</p><p>two</p><p>three</p>',
  ].join('');
  document.body.appendChild(root);
  return root;
}

const meta = (parentIndex: number) => ({ parentTagName: 'P', parentIndex, textOffset: 1 });

test.skipIf(!hasDom)('no slot: both directions return the very same object', () => {
  const root = build(false);
  for (const i of [0, 1, 2, -1, -2]) {
    const m = meta(i);
    expect(metaWithoutBelowTitle(root, m, 'start')).toBe(m);
    expect(metaWithBelowTitle(root, m)).toBe(m);
  }
  expect(metaWithoutBelowTitle(root, undefined, 'end')).toBeUndefined();
});

test.skipIf(!hasDom)('with a slot: live index ↔ slot-free index, round trip', () => {
  const root = build(true);
  const live = [...root.getElementsByTagName('p')];
  for (const text of ['one', 'two', 'three']) {
    const liveIndex = live.findIndex((p) => p.textContent === text);
    const stored = metaWithoutBelowTitle(root, meta(liveIndex), 'start');
    expect(stored.parentIndex).toBe(['one', 'two', 'three'].indexOf(text));
    expect(metaWithBelowTitle(root, stored).parentIndex).toBe(liveIndex);
  }
  for (const m of [meta(-1), meta(-2)]) expect(metaWithoutBelowTitle(root, m, 'end')).toBe(m);
  const past = meta(9);
  expect(metaWithBelowTitle(root, past)).toBe(past);
});

test.skipIf(!hasDom)('a boundary inside the slot is moved out of it: an end back to the title, a start on to the body', () => {
  const root = build(true);
  expect(metaWithoutBelowTitle(root, meta(0), 'end')).toEqual({ parentTagName: 'H1', parentIndex: 0, textOffset: 1 });
  expect(metaWithoutBelowTitle(root, meta(1), 'start')).toEqual({ parentTagName: 'P', parentIndex: 0, textOffset: 0 });
});

test.skipIf(!hasDom)('raw HTML carrying the attribute is not the slot: nothing is translated', () => {
  for (const html of [
    `<h1>T</h1><div ${BELOW_TITLE_SLOT_ATTRIBUTE}=""><p>a</p></div><p>one</p>`,
    `<h1>T</h1><div data-block-id="b"><div ${BELOW_TITLE_SLOT_ATTRIBUTE}="${BELOW_TITLE_SLOT_MARKER}"><p>a</p></div></div><p>one</p>`,
  ]) {
    const root = document.createElement('article');
    root.innerHTML = html;
    document.body.appendChild(root);
    for (const i of [0, 1]) {
      const m = meta(i);
      expect(metaWithoutBelowTitle(root, m, 'end')).toBe(m);
      expect(metaWithBelowTitle(root, m)).toBe(m);
    }
    root.remove();
  }
});
