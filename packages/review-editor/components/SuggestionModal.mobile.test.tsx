import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SuggestionModal } from './SuggestionModal';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('SuggestionModal mobile containment', () => {
  test.skipIf(!hasDom)('uses the visible viewport and compact-safe editor structure', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <SuggestionModal
          filePath="src/example.ts"
          toolbarState={null}
          selectedOriginalCode="const value = 1;"
          suggestedCode="const value = 2;"
          setSuggestedCode={() => {}}
          modalLayout="horizontal"
          setModalLayout={() => {}}
          onClose={() => {}}
        />,
      );
    });

    const stage = document.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const panes = document.querySelector<HTMLElement>('.pn-suggestion-panes');
    const editor = document.querySelector<HTMLTextAreaElement>('textarea');
    const labelledButtons = document.querySelectorAll<HTMLButtonElement>('button[aria-label]');

    expect(stage).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.hasAttribute('aria-labelledby')).toBe(true);
    expect(dialog?.hasAttribute('data-pn-secondary-input-dialog')).toBe(true);
    expect(panes?.classList.contains('min-h-0')).toBe(true);
    expect(editor?.getAttribute('data-pn-mobile-editable')).toBe('true');
    expect(editor?.className).toContain('min-h-[300px]');
    expect(labelledButtons.length).toBe(2);
  });

  test.skipIf(!hasDom)('delegates Escape dismissal to the dialog primitive', async () => {
    let closeCount = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <SuggestionModal
          filePath="src/example.ts"
          toolbarState={null}
          selectedOriginalCode="const value = 1;"
          suggestedCode="const value = 2;"
          setSuggestedCode={() => {}}
          modalLayout="horizontal"
          setModalLayout={() => {}}
          onClose={() => { closeCount += 1; }}
        />,
      );
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(closeCount).toBe(1);
  });
});
