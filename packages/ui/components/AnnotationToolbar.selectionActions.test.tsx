/**
 * The two host toolbar seams (DOM-gated), both opt-in:
 *
 *   selectionActions — one wand button that opens the package's dropdown and
 *                      hands the host the selection context. The package
 *                      creates no annotation of its own.
 *   quickLabels      — false hides the Zap picker AND the Alt+digit label
 *                      shortcuts on that toolbar.
 *
 * The failure each test catches: a host's actions silently not reaching the
 * toolbar, an action invoked with the wrong selection context (the whole
 * point of the seam is the ctx), a quick-label opt-out that hides the button
 * but leaves the Alt+digit keys live, and — the one that matters most for
 * Plannotator — either prop leaking into the default toolbar, which passes
 * NEITHER and must stay exactly what it was.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';
import type { QuickLabel } from '../utils/quickLabels';
import type { SelectionAction, SelectionActionContext } from '../utils/selectionActions';
import type { RichCopySource } from '../utils/richClipboard';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let block: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  block = null;
  if (hasDom) document.body.replaceChildren();
});

interface MountOptions {
  selectionActions?: SelectionAction[];
  selectionActionsIcon?: React.ReactNode;
  quickLabels?: boolean;
  withQuickLabelHandler?: boolean;
  onQuickLabel?: (label: QuickLabel) => void;
  onClose?: () => void;
  copyText?: string;
  /** Shorthand: a builder that returns this HTML with copyText. */
  richCopyHtml?: string;
  getRichCopy?: () => RichCopySource | Promise<RichCopySource>;
  hideCopyButton?: boolean;
}

/** A paragraph inside a data-block-id block, the markdown surface's shape. */
async function mount(options: MountOptions = {}) {
  block = document.createElement('div');
  block.dataset.blockId = 'block-7';
  block.textContent = 'lead in SELECTED tail';
  document.body.appendChild(block);
  const anchor = document.createElement('span');
  anchor.textContent = 'SELECTED';
  block.appendChild(anchor);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        element={anchor}
        positionMode="center-above"
        onAnnotate={() => {}}
        onClose={options.onClose ?? (() => {})}
        onRequestComment={() => {}}
        onQuickLabel={
          options.withQuickLabelHandler === false ? undefined : options.onQuickLabel ?? (() => {})
        }
        copyText={options.copyText ?? 'SELECTED'}
        getRichCopy={options.getRichCopy ?? (options.richCopyHtml === undefined ? undefined : () => ({
          html: options.richCopyHtml!,
          text: options.copyText ?? 'SELECTED',
        }))}
        hideCopyButton={options.hideCopyButton}
        selectionActions={options.selectionActions}
        selectionActionsIcon={options.selectionActionsIcon}
        quickLabels={options.quickLabels}
      />,
    );
  });
  return anchor;
}

function toolbar(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.annotation-toolbar');
  if (!el) throw new Error('annotation toolbar did not render');
  return el;
}

function buttonTitles(): string[] {
  return Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button')).map((b) => b.title);
}

function wand(): HTMLButtonElement | null {
  return toolbar().querySelector<HTMLButtonElement>('[data-selection-actions]');
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe.if(hasDom)('AnnotationToolbar host seams', () => {
  test('with NEITHER prop the toolbar is what it always was: no wand, the Zap present, same order', async () => {
    await mount();
    // The pin: the exact button set and order Plannotator ships, and no
    // trace of either seam in the DOM.
    expect(buttonTitles()).toEqual(['Copy', 'Delete', 'Comment', 'Quick label', 'Looks good', 'Cancel']);
    expect(wand()).toBeNull();
    expect(document.querySelectorAll('[data-selection-actions]').length).toBe(0);
    expect(document.querySelectorAll('[data-selection-actions-picker]').length).toBe(0);
    // No stray attributes on the buttons the seam touched.
    const zap = Array.from(toolbar().querySelectorAll('button')).find((b) => b.title === 'Quick label')!;
    expect(zap.getAttributeNames().sort()).toEqual([
      'class', 'data-pn-touch-target', 'data-pn-touch-target-icon', 'title',
    ]);
  });

  test('an EMPTY selectionActions array renders no wand', async () => {
    await mount({ selectionActions: [] });
    expect(wand()).toBeNull();
    expect(buttonTitles()).toEqual(['Copy', 'Delete', 'Comment', 'Quick label', 'Looks good', 'Cancel']);
  });

  test('rich copy is the one Copy button, shown also where the plain Copy is hidden; without it, unchanged', async () => {
    const rich = ['Copy', 'Delete', 'Comment', 'Quick label', 'Looks good', 'Cancel'];
    await mount({ richCopyHtml: '<p><strong>SELECTED</strong></p>' });
    expect(buttonTitles()).toEqual(rich);

    for (const options of [
      { richCopyHtml: '<p>SELECTED</p>', hideCopyButton: true },
      { hideCopyButton: true },
    ]) {
      await act(async () => root?.unmount());
      root = null;
      document.body.replaceChildren();
      await mount(options);
      expect(buttonTitles()).toEqual(options.richCopyHtml ? rich : rich.slice(1));
    }
  });

  test('with rich copy off, Copy writes plain text exactly as before', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    const write = mock(async () => {});
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: class {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
    try {
      await mount({ copyText: 'SELECTED' });
      const copy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy')!;
      await click(copy);
      expect(writeText).toHaveBeenCalledWith('SELECTED');
      expect(write).not.toHaveBeenCalled();
      expect(buttonTitles()).toContain('Copied!');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clipboardItemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
      else delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    }
  });

  test('with rich copy on, Copy writes text/html and text/plain in one clipboard item', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    let items: Record<string, Blob> | undefined;
    class TestClipboardItem {
      constructor(value: Record<string, Blob>) { items = value; }
    }
    const write = mock(async () => {});
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
    try {
      await mount({ copyText: 'SELECTED', richCopyHtml: '<p><strong>SELECTED</strong></p>', hideCopyButton: true });
      const richCopy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy');
      if (!richCopy) throw new Error('rich-copy action missing');
      await click(richCopy);

      expect(write).toHaveBeenCalledTimes(1);
      expect(writeText).not.toHaveBeenCalled();
      expect(Object.keys(items ?? {}).sort()).toEqual(['text/html', 'text/plain']);
      expect(await items!['text/html'].text()).toBe('<p><strong>SELECTED</strong></p>');
      expect(await items!['text/plain'].text()).toBe('SELECTED');
      expect(buttonTitles()).toContain('Copied!');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clipboardItemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
      else delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    }
  });

  test('the rich HTML is built only when Copy is pressed, never for the selection itself', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const build = mock(() => ({ html: '<p>SELECTED</p>', text: 'SELECTED' }));
    try {
      await mount({ getRichCopy: build });
      await press('a');
      expect(build).not.toHaveBeenCalled();
      const richCopy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy')!;
      await click(richCopy);
      expect(build).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  test('a selection too large for rich text copies plain text and says why', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = mock(async (_text: string) => {});
    const write = mock(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, write } });
    try {
      await mount({ getRichCopy: () => ({ tooLarge: true, text: 'the whole selection' }) });
      const richCopy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy')!;
      await click(richCopy);
      expect(write).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith('the whole selection');
      expect(buttonTitles()).toContain('Copied as plain text (too large for rich text)');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  test('reports plain fallback without claiming why rich copy was unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      await mount({ richCopyHtml: '<p><strong>SELECTED</strong></p>' });
      const richCopy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy');
      if (!richCopy) throw new Error('rich-copy action missing');
      await click(richCopy);
      expect(writeText).toHaveBeenCalledWith('SELECTED');
      expect(buttonTitles()).toContain('Copied as plain text (rich clipboard unavailable)');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  test('rich copy has no keyboard shortcut: Ctrl+Alt+C and Cmd+Option+C do nothing', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const write = mock(async () => {});
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
    try {
      await mount({ richCopyHtml: '<p><strong>SELECTED</strong></p>' });
      for (const init of [
        { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true },
        { key: 'ç', code: 'KeyC', metaKey: true, altKey: true },
      ]) {
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        await act(async () => { window.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(false);
      }
      expect(write).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(buttonTitles()).toContain('Copy');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  test('a late rich-copy result does not update toolbar for a replacement selection', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    let resolveWrite!: () => void;
    const write = mock(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    class TestClipboardItem {
      constructor(_items: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    try {
      await mount({ copyText: 'FIRST', richCopyHtml: '<p>FIRST</p>' });
      const richCopy = Array.from(toolbar().querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.title === 'Copy')!;
      await click(richCopy);
      expect(write).toHaveBeenCalledTimes(1);

      const next = document.createElement('span');
      next.textContent = 'SECOND';
      block!.appendChild(next);
      await act(async () => root?.render(
        <AnnotationToolbar
          element={next}
          positionMode="center-above"
          onAnnotate={() => {}}
          onClose={() => {}}
          onRequestComment={() => {}}
          onQuickLabel={() => {}}
          copyText="SECOND"
          getRichCopy={() => ({ html: '<p>SECOND</p>', text: 'SECOND' })}
        />,
      ));
      await act(async () => {
        resolveWrite();
        await Promise.resolve();
      });

      expect(buttonTitles()).toContain('Copy');
      expect(buttonTitles()).not.toContain('Copied!');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clipboardItemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
      else delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    }
  });

  test('actions take the Zap slot; quickLabels:false hides the Zap and keeps the thumbs-up', async () => {
    await mount({
      selectionActions: [{ id: 'a', label: 'Ask', onSelect: () => {} }],
      quickLabels: false,
    });
    const titles = buttonTitles();
    expect(titles).toEqual(['Copy', 'Delete', 'Comment', 'Actions', 'Looks good', 'Cancel']);
    expect(wand()).not.toBeNull();
  });

  test('selectionActionsIcon replaces the glyph inside the wand button and nothing else', async () => {
    // Sentinel node: the only thing asserted is that the host's node is what
    // the button contains, and that the package's own svg is gone.
    await mount({
      selectionActions: [{ id: 'a', label: 'A', onSelect: () => {} }],
      selectionActionsIcon: <span data-host-icon="true">W</span>,
    });
    const button = wand();
    expect(button).not.toBeNull();
    expect(button!.querySelector('[data-host-icon]')).not.toBeNull();
    expect(button!.querySelector('svg')).toBeNull();
    expect(button!.title).toBe('Actions');
    expect(button!.getAttribute('data-selection-actions')).toBe('true');
  });

  test('without selectionActionsIcon the wand button carries the package svg', async () => {
    await mount({ selectionActions: [{ id: 'a', label: 'A', onSelect: () => {} }] });
    expect(wand()!.querySelector('svg')).not.toBeNull();
    expect(wand()!.querySelector('[data-host-icon]')).toBeNull();
  });

  test('with both, the wand sits immediately left of the Zap', async () => {
    await mount({ selectionActions: [{ id: 'a', label: 'Ask', onSelect: () => {} }] });
    expect(buttonTitles()).toEqual([
      'Copy', 'Delete', 'Comment', 'Actions', 'Quick label', 'Looks good', 'Cancel',
    ]);
  });

  test('the dropdown opens under the wand, arrows + Enter invoke with the selection context, and the toolbar closes', async () => {
    const seen: SelectionActionContext[] = [];
    let closed = 0;
    const anchor = await mount({
      onClose: () => { closed++; },
      selectionActions: [
        { id: 'first', label: 'Explain', detail: 'Ask the agent' },
        { id: 'second', label: 'Rewrite' },
      ].map((a) => ({ ...a, onSelect: (ctx: SelectionActionContext) => seen.push(ctx) })),
    });

    await click(wand()!);
    const picker = document.querySelector('[data-selection-actions-picker]');
    expect(picker).not.toBeNull();
    expect(
      Array.from(picker!.querySelectorAll('[data-selection-action]')).map((b) =>
        b.getAttribute('data-selection-action'),
      ),
    ).toEqual(['first', 'second']);
    // Nothing is preselected until the first arrow.
    expect(picker!.querySelector('[aria-selected="true"]')).toBeNull();

    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe('SELECTED');
    expect(seen[0]!.blockId).toBe('block-7');
    expect(seen[0]!.startOffset).toBe('lead in '.length);
    expect(seen[0]!.endOffset).toBe('lead in '.length + 'SELECTED'.length);
    expect(seen[0]!.element).toBe(anchor);
    // Selecting an item closes the toolbar, exactly as a quick label does.
    expect(closed).toBe(1);
    expect(document.querySelector('[data-selection-actions-picker]')).toBeNull();
  });

  test('a click on a row invokes it without ever arming Enter', async () => {
    const seen: string[] = [];
    await mount({
      selectionActions: [{ id: 'only', label: 'Explain', onSelect: (ctx) => seen.push(ctx.text) }],
    });
    await click(wand()!);
    await click(document.querySelector('[data-selection-action="only"]')!);
    expect(seen).toEqual(['SELECTED']);
  });

  test('Escape closes the dropdown without closing the toolbar', async () => {
    let closed = 0;
    await mount({
      onClose: () => { closed++; },
      selectionActions: [{ id: 'only', label: 'Explain', onSelect: () => {} }],
    });
    await click(wand()!);
    expect(document.querySelector('[data-selection-actions-picker]')).not.toBeNull();
    await press('Escape');
    expect(document.querySelector('[data-selection-actions-picker]')).toBeNull();
    expect(closed).toBe(0);
  });

  test('an actions list that empties while the dropdown is open does not wedge the toolbar', async () => {
    // The failure this catches: the open flag outliving the button that owns
    // it. The dropdown (and its Escape handler) unmount with the wand, but a
    // raw `showSelectionActions` would keep the toolbar's own Escape,
    // type-to-comment and outside-dismiss listeners stood down forever.
    let closed = 0;
    const anchor = await mount({
      onClose: () => { closed++; },
      selectionActions: [{ id: 'only', label: 'Explain', onSelect: () => {} }],
    });
    await click(wand()!);
    expect(document.querySelector('[data-selection-actions-picker]')).not.toBeNull();

    // The host recomputes its actions for this selection and has none.
    await act(async () => {
      root?.render(
        <AnnotationToolbar
          element={anchor}
          positionMode="center-above"
          onAnnotate={() => {}}
          onClose={() => { closed++; }}
          onRequestComment={() => {}}
          onQuickLabel={() => {}}
          copyText="SELECTED"
          selectionActions={[]}
        />,
      );
    });
    expect(wand()).toBeNull();
    expect(document.querySelector('[data-selection-actions-picker]')).toBeNull();
    await press('Escape');
    expect(closed).toBeGreaterThan(0);
  });

  test('Alt+digit applies a quick label by default and is dead with quickLabels:false', async () => {
    const applied: string[] = [];
    await mount({ onQuickLabel: (label) => applied.push(label.id) });
    await press('1', { code: 'Digit1', altKey: true });
    expect(applied).toHaveLength(1);

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    document.body.replaceChildren();

    const off: string[] = [];
    await mount({ quickLabels: false, onQuickLabel: (label) => off.push(label.id) });
    await press('1', { code: 'Digit1', altKey: true });
    expect(off).toEqual([]);
  });
});
