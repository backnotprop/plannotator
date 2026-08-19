/**
 * CommentPopover multi-target seams (all opt-in, default off):
 *  - target chips render (primary first) with remove + hover handlers
 *  - refocusToken returns focus to the textarea
 *  - captureStrayKeys routes a window-level stray printable keydown into the
 *    textarea so the first keystroke after a shift-click is never lost
 *  - yieldState applies the fade / click-through classes
 *  - with none of the props set, none of the new DOM appears (byte-identical
 *    default composer)
 *
 * Requires DOM — runs under bun test with the happy-dom preload (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover, type CommentTargetChip } from './CommentPopover';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

type PopoverProps = Partial<React.ComponentProps<typeof CommentPopover>>;

async function mountPopover(props: PopoverProps = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 50, 20)}
        contextText="Selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
}

async function remount(props: PopoverProps) {
  await act(async () => {
    root!.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 50, 20)}
        contextText="Selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
}

function popoverEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-comment-popover]');
  if (!el) throw new Error('popover missing');
  return el;
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('textarea missing');
  return el;
}

const CHIPS: CommentTargetChip[] = [
  { key: 't1', label: 'Paragraph', excerpt: 'Primary text' },
  { key: 't2', label: 'Button', excerpt: 'Create' },
];

describe.if(hasDom)('CommentPopover multi-target seams', () => {
  test('default composer renders none of the multi-target DOM', async () => {
    await mountPopover();
    expect(document.querySelector('[data-target-chips]')).toBeNull();
    expect(popoverEl().className).not.toContain('pn-composer-yield');
  });

  test('chips render primary-first with working remove and hover handlers', async () => {
    const removed: string[] = [];
    const hovered: string[] = [];
    await mountPopover({
      targetChips: CHIPS,
      onRemoveTargetChip: (key) => removed.push(key),
      onHoverTargetChip: (key) => hovered.push(key),
    });

    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-target-chip]'));
    expect(chips.length).toBe(2);
    expect(chips[0]!.getAttribute('data-target-chip-primary')).toBe('true');
    expect(chips[0]!.textContent).toContain('Paragraph');
    expect(chips[1]!.textContent).toContain('Create');

    await act(async () => {
      chips[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    // React attaches mouseenter via its own delegation of mouseout/mouseover;
    // fall back to mouseover which React maps for onMouseEnter in tests.
    if (hovered.length === 0) {
      await act(async () => {
        chips[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
    }
    expect(hovered).toContain('t2');

    const removeButton = document.querySelector<HTMLButtonElement>('[data-target-chip-remove="t2"]');
    if (!removeButton) throw new Error('remove button missing');
    await act(async () => {
      removeButton.click();
    });
    expect(removed).toEqual(['t2']);
  });

  test('refocusToken bump returns focus to the textarea', async () => {
    await mountPopover({ targetChips: CHIPS, refocusToken: 0 });
    textarea().blur();
    document.body.focus();
    expect(document.activeElement).not.toBe(textarea());
    await remount({ targetChips: CHIPS, refocusToken: 1 });
    expect(document.activeElement).toBe(textarea());
  });

  test('captureStrayKeys routes a body-targeted printable keydown into the textarea', async () => {
    await mountPopover({ targetChips: CHIPS, captureStrayKeys: true });
    const el = textarea();
    el.blur();
    const stray = new KeyboardEvent('keydown', {
      key: 'h',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.body.dispatchEvent(stray);
    });
    expect(stray.defaultPrevented).toBe(true);
    expect(el.value).toBe('h');
    expect(document.activeElement).toBe(el);

    // A keydown already headed somewhere useful is left alone.
    const focused = new KeyboardEvent('keydown', {
      key: 'i',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      el.dispatchEvent(focused);
    });
    expect(focused.defaultPrevented).toBe(false);
  });

  test('stray keys insert at the remembered caret, not end-of-text', async () => {
    await mountPopover({ targetChips: CHIPS, captureStrayKeys: true });
    const el = textarea();
    // Type 'held' through React, then park the caret between 'he' and 'ld'.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    await act(async () => {
      setter?.call(el, 'held');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    el.selectionStart = el.selectionEnd = 2;
    el.blur();

    const stray = new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(stray);
    });
    expect(stray.defaultPrevented).toBe(true);
    expect(el.value).toBe('heXld');
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.selectionStart).toBe(3);
  });

  test('yieldState drives fade and click-through classes with a reduced-motion-aware style', async () => {
    await mountPopover({ targetChips: CHIPS, yieldState: 'none' });
    expect(popoverEl().className).toContain('pn-composer-yieldable');
    expect(popoverEl().className).not.toContain('pn-composer-yield-near');

    await remount({ targetChips: CHIPS, yieldState: 'near' });
    expect(popoverEl().className).toContain('pn-composer-yield-near');

    await remount({ targetChips: CHIPS, yieldState: 'over' });
    expect(popoverEl().className).toContain('pn-composer-yield-over');

    const style = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .find((s) => s.includes('pn-composer-yieldable'));
    expect(style).toBeDefined();
    expect(style).toContain('pointer-events: none');
    expect(style).toContain('prefers-reduced-motion: reduce');
    expect(style).toContain('180ms');
  });
});
