import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useModalFocusLifecycle } from './useModalFocusLifecycle';

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

describe('useModalFocusLifecycle', () => {
  test.skipIf(!hasDom)('can restore focus without overriding a surface-specific Escape action', async () => {
    let closeCount = 0;

    function Harness() {
      const [open, setOpen] = useState(false);
      useModalFocusLifecycle(
        open,
        () => {
          closeCount += 1;
          setOpen(false);
        },
        { dismissOnEscape: false },
      );
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open && <button type="button" onClick={() => setOpen(false)}>Accept</button>}
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
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(closeCount).toBe(0);
    const accept = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Accept');
    await act(async () => accept?.click());
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement).toBe(opener);
  });
});
