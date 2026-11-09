/**
 * The selection toolbar's opt-in "Side" button (`onSide`, the Inbox's Ask AI).
 * Failures to catch: Side showing for a host that did not ask for it (plan
 * review, Workspaces), or its divider left behind; Side drifting out of its
 * place after the reactions, between its own divider and the one before ×;
 * a press that does not hand the host the selected words and their context,
 * or leaves the toolbar open; Side losing the touch-target marker theme.css sizes to 44px
 * on a phone.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let anchor: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  anchor?.remove();
  anchor = null;
  if (hasDom) document.body.replaceChildren();
});

async function mount(props: Partial<React.ComponentProps<typeof AnnotationToolbar>>) {
  anchor = document.createElement('p');
  anchor.textContent = 'the whole paragraph';
  document.body.appendChild(anchor);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        element={anchor!}
        positionMode="center-above"
        commentOnly
        showDelete
        onAnnotate={() => {}}
        onClose={() => {}}
        onRequestComment={() => {}}
        onQuickLabel={() => {}}
        copyText="the backoff is two, four and eight seconds"
        {...props}
      />,
    );
  });
  const row = document.querySelector<HTMLElement>('.annotation-toolbar [data-pn-annotation-toolbar-row]');
  if (!row) throw new Error('the toolbar did not render');
  return row;
}

/** The row left to right: each button's name ("|" for a divider). */
const rowOrder = (row: HTMLElement) =>
  [...row.children].map((el) => {
    if (el.tagName !== 'BUTTON') return el.querySelector('button') ? nameOf(el.querySelector('button')!) : '|';
    return nameOf(el as HTMLButtonElement);
  });
const nameOf = (button: HTMLButtonElement) => button.getAttribute('aria-label') || button.title || button.textContent?.trim() || '';
const sideButton = () => document.querySelector<HTMLButtonElement>('.annotation-toolbar [data-annotation-side]');

describe.if(hasDom)('AnnotationToolbar Side', () => {
  test('absent without onSide: the toolbar is as before, one divider before ×', async () => {
    const row = await mount({});
    expect(document.querySelectorAll('[data-annotation-side]')).toHaveLength(0);
    expect([...row.querySelectorAll('button')].some((b) => b.textContent?.includes('Side'))).toBe(false);
    expect(rowOrder(row).slice(-3)).toEqual(['Looks good', '|', 'Cancel']);
  });

  test('with onSide: Copy · Delete · Comment · 👍 | Side | ×, the word and the two bubbles on it', async () => {
    const row = await mount({ onSide: () => {} });
    expect(rowOrder(row)).toEqual(['Copy', '|', 'Delete', 'Comment', 'Looks good', '|', 'Side', '|', 'Cancel']);
    const side = sideButton()!;
    expect(side.textContent?.trim()).toBe('Side');
    expect(side.querySelectorAll('svg path')).toHaveLength(2);
    // theme.css grows a marked control to 44px on a touch toolbar; its word is no span (sized there as a glyph).
    expect(side.getAttribute('data-pn-touch-target')).toBe('true');
    expect(side.querySelectorAll('span')).toHaveLength(0);
  });

  test('a press hands the host the selected words and closes the toolbar', async () => {
    const sides: string[] = [];
    const anchors: boolean[] = [];
    let closes = 0;
    await mount({ onSide: (text, context) => (sides.push(text), anchors.push(context.element === anchor && context.text === text)), onClose: () => (closes += 1) });
    await act(async () => sideButton()!.click());
    expect(sides).toEqual(['the backoff is two, four and eight seconds']);
    // The selection's context too, as the selection actions get it: the host says where the words came from.
    expect(anchors).toEqual([true]);
    expect(closes).toBe(1);
  });

  test('with no copyText it reads the element, as the selection actions do', async () => {
    const sides: string[] = [];
    await mount({ onSide: (text) => sides.push(text), copyText: undefined });
    await act(async () => sideButton()!.click());
    expect(sides).toEqual(['the whole paragraph']);
  });
});
