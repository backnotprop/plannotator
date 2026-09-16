import { describe, expect, test } from 'bun:test';
import {
  getLineNumberFromNode,
  getSideFromNode,
  snapshotDiffSelection,
} from './diffSelection';

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('diffSelection', () => {
  test('resolves line number from node or ancestor data-line attribute', () => {
    const parent = document.createElement('div');
    parent.setAttribute('data-line', '42');
    const child = document.createElement('span');
    parent.appendChild(child);
    const textNode = document.createTextNode('code content');
    child.appendChild(textNode);

    expect(getLineNumberFromNode(textNode)).toBe(42);
    expect(getLineNumberFromNode(child)).toBe(42);
    expect(getLineNumberFromNode(parent)).toBe(42);
    expect(getLineNumberFromNode(document.createElement('div'))).toBeNull();
  });

  test('resolves diff side from node or ancestor attribute, defaulting to additions', () => {
    const additionsEl = document.createElement('div');
    additionsEl.setAttribute('data-additions', '');
    const delEl = document.createElement('div');
    delEl.setAttribute('data-deletions', '');
    const neutralEl = document.createElement('div');

    expect(getSideFromNode(additionsEl)).toBe('additions');
    expect(getSideFromNode(delEl)).toBe('deletions');
    expect(getSideFromNode(neutralEl)).toBe('additions');
  });

  test('guards against collapsed selection by returning null', () => {
    const el = document.createElement('div');
    el.setAttribute('data-line', '10');
    const selection = {
      isCollapsed: true,
      toString: () => 'selected',
      anchorNode: el,
      focusNode: el,
    } as unknown as Selection;

    expect(snapshotDiffSelection(null, selection)).toBeNull();
  });

  test('guards against whitespace-only selection by returning null', () => {
    const el = document.createElement('div');
    el.setAttribute('data-line', '10');
    const selection = {
      isCollapsed: false,
      toString: () => '   \n  \t  ',
      anchorNode: el,
      focusNode: el,
    } as unknown as Selection;

    expect(snapshotDiffSelection(null, selection)).toBeNull();
  });

  test('guards against selection missing anchor or focus lines by returning null', () => {
    const lineEl = document.createElement('div');
    lineEl.setAttribute('data-line', '10');
    const outsideEl = document.createElement('div');

    const selectionNoAnchor = {
      isCollapsed: false,
      toString: () => 'code',
      anchorNode: outsideEl,
      focusNode: lineEl,
    } as unknown as Selection;

    expect(snapshotDiffSelection(null, selectionNoAnchor)).toBeNull();
  });

  test('snapshots a multi-line selection with min/max bounds and side', () => {
    const line2 = document.createElement('div');
    line2.setAttribute('data-line', '2');
    line2.setAttribute('data-additions', '');
    const line6 = document.createElement('div');
    line6.setAttribute('data-line', '6');
    line6.setAttribute('data-additions', '');

    // Focus on line 2, anchor on line 6 (backward selection drag)
    const selection = {
      isCollapsed: false,
      toString: () => 'lines 2 through 6',
      anchorNode: line6,
      focusNode: line2,
    } as unknown as Selection;

    const snapshot = snapshotDiffSelection(null, selection);
    expect(snapshot).toEqual({
      start: 2,
      end: 6,
      side: 'additions',
      host: null,
    });
  });
});
