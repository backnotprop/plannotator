import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImportModal } from './ImportModal';

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

describe('ImportModal mobile input shell', () => {
  test.skipIf(!hasDom)('bounds the dialog to the visible viewport and marks its editor', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <ImportModal
          isOpen
          onClose={() => {}}
          onImport={async () => ({ success: true, count: 0, planTitle: 'Plan' })}
        />,
      );
    });

    const stage = host.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    const body = host.querySelector<HTMLElement>('.overscroll-contain');
    const input = host.querySelector<HTMLInputElement>('input');

    expect(stage).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.hasAttribute('data-pn-secondary-input-dialog')).toBe(true);
    expect(dialog?.className).toContain('max-h-full');
    expect(body?.className).toContain('overflow-y-auto');
    expect(input?.getAttribute('data-pn-mobile-editable')).toBe('true');
  });

  test.skipIf(!hasDom)('dismisses with Escape and restores the opener focus', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open import</button>
          <ImportModal
            isOpen={open}
            onClose={() => setOpen(false)}
            onImport={async () => ({ success: true, count: 0, planTitle: 'Plan' })}
          />
        </>
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));

    const opener = host.querySelector<HTMLButtonElement>('button');
    opener?.focus();
    await act(async () => opener?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test.skipIf(!hasDom)('restores the stable menu trigger when the transient opener unmounts', async () => {
    function Harness() {
      const [menuOpen, setMenuOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <>
          <button id="pn-plan-options-trigger" type="button">Options</button>
          {menuOpen && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setModalOpen(true);
              }}
            >
              Import
            </button>
          )}
          <ImportModal
            isOpen={modalOpen}
            restoreFocusId="pn-plan-options-trigger"
            onClose={() => setModalOpen(false)}
            onImport={async () => ({ success: true, count: 0, planTitle: 'Plan' })}
          />
        </>
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));

    const transientOpener = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Import');
    transientOpener?.focus();
    await act(async () => transientOpener?.click());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement?.id).toBe('pn-plan-options-trigger');
  });
});
