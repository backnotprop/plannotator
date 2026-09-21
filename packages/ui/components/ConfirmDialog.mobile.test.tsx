import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmDialog } from './ConfirmDialog';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

interface HarnessProps {
  readonly onClose?: () => void;
  readonly onConfirm?: () => void;
  readonly showCancel?: boolean;
}

function Harness({ onClose, onConfirm, showCancel = false }: HarnessProps) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={() => {
        onClose?.();
        setIsOpen(false);
      }}
      onConfirm={onConfirm}
      title="Discard changes?"
      message="This action cannot be undone."
      confirmText="Discard"
      cancelText="Keep editing"
      showCancel={showCancel}
      variant="warning"
    />
  );
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('ConfirmDialog mobile foundation', () => {
  test.skipIf(!hasDom)('uses the safe visible viewport and touch-safe actions', async () => {
    await mount(<Harness showCancel />);

    const popup = document.querySelector<HTMLElement>('[data-plannotator-confirm-dialog="true"]');
    const overlay = document.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const actions = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-pn-touch-target="true"]'),
    );

    expect(popup?.getAttribute('role')).toBe('dialog');
    expect(overlay).not.toBeNull();
    expect(actions.map(button => button.textContent)).toEqual(['Keep editing', 'Discard']);
    expect(document.activeElement).toBe(actions[0]);
  });

  test.skipIf(!hasDom)('contains Escape and restores focus to the prior control', async () => {
    const prior = document.createElement('button');
    prior.textContent = 'Open warning';
    document.body.appendChild(prior);
    prior.focus();
    const onClose = mock(() => {});

    await mount(<Harness showCancel onClose={onClose} />);
    expect(document.activeElement?.textContent).toBe('Keep editing');

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-plannotator-confirm-dialog]')).toBeNull();
    expect(document.activeElement).toBe(prior);
  });

  test.skipIf(!hasDom)('preserves the established non-dismissible backdrop', async () => {
    const onClose = mock(() => {});
    await mount(<Harness showCancel onClose={onClose} />);
    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');

    await act(async () => {
      backdrop?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      backdrop?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-plannotator-confirm-dialog]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('keeps the established command-enter confirmation shortcut', async () => {
    const onConfirm = mock(() => {});
    await mount(<Harness onConfirm={onConfirm} />);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
