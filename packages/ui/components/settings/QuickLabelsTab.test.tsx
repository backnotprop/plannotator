/**
 * Settings → Labels: reorder and editable emoji (#1736). DOM-gated
 * (DOM_TESTS=1), driven through the real Settings dialog, the real storage
 * module (over an in-memory backend: happy-dom keeps no cookies), and the real
 * annotation toolbar / Viewer that read the saved list.
 *
 * Failures this catches:
 * - moving a label does not remap its Alt/⌥ digit (or moves only part of it,
 *   e.g. the text but not the emoji, colour or tip);
 * - an edited emoji never reaches the annotation the label creates;
 * - after a move, typing or the open tip editor lands on the neighbouring row
 *   (rows keyed by position, the #829 bug class);
 * - two labels with the same text collide (their derived ids are equal).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';
import type { QuickLabel } from '../../utils/quickLabels';

const hasDom = typeof document !== 'undefined';
// Settings, the Viewer and web-highlighter read the DOM at module scope; load
// lazily so this file stays inert in the DOM-less default `bun test` run.
const settingsModule = hasDom ? await import('../Settings') : null;
const toolbarModule = hasDom ? await import('../AnnotationToolbar') : null;
const dropdownModule = hasDom ? await import('../QuickLabelDropdown') : null;
const viewerModule = hasDom ? await import('../Viewer') : null;
const parserModule = hasDom ? await import('../../utils/parser') : null;
const labelsModule = hasDom ? await import('../../utils/quickLabels') : null;
const storageModule = hasDom ? await import('../../utils/storage') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function unmount() {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  root = null;
  host?.remove();
  host = null;
}

beforeEach(() => {
  if (!hasDom) return;
  const items = new Map<string, string>();
  storageModule!.setStorageBackend({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  });
});

afterEach(async () => {
  await unmount();
  if (hasDom) {
    storageModule!.resetStorageBackend();
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

async function mount(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
}

async function openLabelsTab() {
  const Settings = settingsModule!.Settings;
  await mount(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" origin="claude-code" externalOpen />);
  const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('nav.hidden button'))
    .find((b) => b.textContent?.trim() === 'Labels');
  if (!tab) throw new Error('Labels tab did not render');
  await act(async () => tab.click());
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-quick-label-row]'));
const rowTexts = () => rows().map((r) => r.querySelector<HTMLInputElement>('[data-quick-label-text]')!.value);
const rowByText = (text: string) => {
  const row = rows().find((r) => r.querySelector<HTMLInputElement>('[data-quick-label-text]')!.value === text);
  if (!row) throw new Error(`no row "${text}" in ${JSON.stringify(rowTexts())}`);
  return row;
};

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
}

function pressAltDigit(digit: number) {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: String(digit), code: `Digit${digit}`, altKey: true, bubbles: true, cancelable: true,
  }));
}

/** Apply Alt+N on a real annotation toolbar (which reads the saved list) and
 *  return the label it applied. */
async function labelForAltDigit(digit: number): Promise<QuickLabel | undefined> {
  const anchor = document.createElement('p');
  anchor.textContent = 'annotated paragraph';
  document.body.appendChild(anchor);
  const applied: QuickLabel[] = [];
  const AnnotationToolbar = toolbarModule!.AnnotationToolbar;
  await mount(
    <AnnotationToolbar
      element={anchor}
      positionMode="center-above"
      onAnnotate={() => {}}
      onClose={() => {}}
      onQuickLabel={(label) => applied.push(label)}
    />,
  );
  await act(async () => pressAltDigit(digit));
  await unmount();
  anchor.remove();
  return applied[0];
}

describe.if(hasDom)('Settings → Labels: reorder and editable emoji (#1736)', () => {
  test('moving a label carries emoji, text, colour and tip, and Alt+N follows the new order', async () => {
    const verify = labelsModule!.DEFAULT_QUICK_LABELS[2]!;
    expect(verify.text).toBe('Verify this');

    await openLabelsTab();
    const before = rowByText('Verify this');
    expect(before.querySelector('[data-quick-label-shortcut]')!.textContent).toMatch(/3$/);
    await click(before.querySelector('[data-quick-label-move="up"]')!);
    await click(rowByText('Verify this').querySelector('[data-quick-label-move="up"]')!);

    expect(rowTexts().slice(0, 3)).toEqual(['Verify this', 'Clarify this', 'Missing overview']);
    const moved = rowByText('Verify this');
    expect(moved.querySelector('[data-quick-label-shortcut]')!.textContent).toMatch(/1$/);
    expect(moved.querySelector<HTMLInputElement>('[data-quick-label-emoji]')!.value).toBe(verify.emoji);
    // At the top the up button is disabled; focus stays on this row's controls.
    expect(moved.querySelector<HTMLButtonElement>('[data-quick-label-move="up"]')!.disabled).toBe(true);
    expect(moved.contains(document.activeElement)).toBe(true);
    await unmount();

    expect(await labelForAltDigit(1)).toEqual(verify);
    expect((await labelForAltDigit(2))?.text).toBe('Clarify this');
    expect((await labelForAltDigit(3))?.text).toBe('Missing overview');
  });

  test('an edited emoji is saved and a new annotation uses it; an invalid entry is not saved', async () => {
    await openLabelsTab();
    const emojiInput = rowByText('Clarify this').querySelector<HTMLInputElement>('[data-quick-label-emoji]')!;

    await typeInto(emojiInput, 'ab');
    expect(emojiInput.getAttribute('aria-invalid')).toBe('true');
    expect(labelsModule!.getQuickLabels()[0]!.emoji).toBe('❓');

    // Picked beside the old emoji (caret after it): the new one wins.
    await typeInto(emojiInput, '❓🤔');
    expect(emojiInput.value).toBe('🤔');
    expect(emojiInput.hasAttribute('aria-invalid')).toBe(false);
    expect(labelsModule!.getQuickLabels()[0]!.emoji).toBe('🤔');
    await unmount();

    // A real Viewer: select text, Alt+1 applies the first label.
    const markdown = 'The rollout plan needs review.\n';
    const added: Annotation[] = [];
    const Viewer = viewerModule!.Viewer;
    await mount(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(markdown)}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
      />,
    );
    const walker = document.createTreeWalker(host!, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent?.includes('rollout plan')) { node = n as Text; break; }
    }
    if (!node) throw new Error('paragraph text not rendered');
    const start = node.textContent!.indexOf('rollout plan');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'rollout plan'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const article = node.parentElement!.closest('article') ?? host!;
    await act(async () => {
      article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    await act(async () => pressAltDigit(1));

    expect(added).toHaveLength(1);
    expect(added[0]!.text).toBe('🤔 Clarify this');
    expect(added[0]!.isQuickLabel).toBe(true);
  });

  test('after editing text and moving, typing and the tip editor stay on the moved row', async () => {
    await openLabelsTab();
    const verifyRow = rowByText('Verify this');
    const textInput = verifyRow.querySelector<HTMLInputElement>('[data-quick-label-text]')!;
    await typeInto(textInput, 'Verify against the code');
    await click(verifyRow.querySelector('[data-quick-label-tip-toggle]')!);
    expect(document.querySelectorAll('[data-quick-label-tip]')).toHaveLength(1);

    await click(rowByText('Verify against the code').querySelector('[data-quick-label-move="up"]')!);
    expect(rowTexts().slice(0, 3)).toEqual(['Clarify this', 'Verify against the code', 'Missing overview']);

    // The tip editor moved with its row and still holds that label's tip.
    const movedRow = rowByText('Verify against the code');
    const tipInput = movedRow.querySelector<HTMLInputElement>('[data-quick-label-tip]');
    expect(tipInput).not.toBeNull();
    expect(tipInput!.value).toBe(labelsModule!.DEFAULT_QUICK_LABELS[2]!.tip!);
    expect(rowByText('Missing overview').querySelector('[data-quick-label-tip]')).toBeNull();

    // The text field the person was typing into is the same element, and
    // further typing edits the moved label, not whoever took its old slot.
    expect(movedRow.contains(textInput)).toBe(true);
    await typeInto(textInput, 'Verify against the code first');
    await typeInto(tipInput!, 'Read the code before trusting this.');
    await act(async () => {
      tipInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const saved = labelsModule!.getQuickLabels();
    expect(saved[1]!.text).toBe('Verify against the code first');
    expect(saved[1]!.tip).toBe('Read the code before trusting this.');
    expect(saved[1]!.emoji).toBe('🔍');
    expect(saved[2]!.text).toBe('Missing overview');
    expect(saved[2]!.tip).toBe(labelsModule!.DEFAULT_QUICK_LABELS[1]!.tip!);
  });

  test('labels with the same text render as distinct rows without key collisions', async () => {
    const same = (emoji: string, color: string): QuickLabel => ({ id: 'same', emoji, text: 'Same', color });
    labelsModule!.saveQuickLabels([same('🅰️', 'blue'), same('🅱️', 'red'), { id: 'other', emoji: '🧪', text: 'Other', color: 'green' }]);

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const QuickLabelDropdown = dropdownModule!.QuickLabelDropdown;
      const picked: QuickLabel[] = [];
      await mount(<QuickLabelDropdown labels={labelsModule!.getQuickLabels()} onSelect={(l) => picked.push(l)} />);
      const buttons = Array.from(host!.querySelectorAll('button'));
      expect(buttons.map((b) => b.textContent)).toEqual(['🅰️Same1', '🅱️Same2', '🧪Other3']);
      await click(buttons[1]!);
      expect(picked[0]!.emoji).toBe('🅱️');
      await unmount();

      await openLabelsTab();
      expect(rows()).toHaveLength(3);
      // Open the tip editor on the SECOND "Same" and rename it: only it changes.
      const second = rows()[1]!;
      await click(second.querySelector('[data-quick-label-tip-toggle]')!);
      await typeInto(second.querySelector<HTMLInputElement>('[data-quick-label-text]')!, 'Same again');
      expect(document.querySelectorAll('[data-quick-label-tip]')).toHaveLength(1);
      expect(rows()[1]!.querySelector('[data-quick-label-tip]')).not.toBeNull();
      expect(rowTexts()).toEqual(['Same', 'Same again', 'Other']);
      expect(labelsModule!.getQuickLabels().map((l) => l.emoji)).toEqual(['🅰️', '🅱️', '🧪']);
    } finally {
      console.error = original;
    }
    const keyWarnings = errors.filter((args) => args.some((a) => typeof a === 'string' && /same key/i.test(a)));
    expect(keyWarnings).toEqual([]);
  });
});
