import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VimModeAnnouncementDialog } from './VimModeAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface HarnessProps {
  readonly initialVim?: boolean;
  readonly initialHud?: boolean;
  readonly onDismiss?: () => void;
}

function Harness({
  initialVim = false,
  initialHud = false,
  onDismiss,
}: HarnessProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [vimEnabled, setVimEnabled] = useState(initialVim);
  const [hudEnabled, setHudEnabled] = useState(initialHud);

  return (
    <VimModeAnnouncementDialog
      isOpen={isOpen}
      vimModeEnabled={vimEnabled}
      vimHudEnabled={hudEnabled}
      onVimModeChange={setVimEnabled}
      onVimHudChange={setHudEnabled}
      onDismiss={() => {
        onDismiss?.();
        setIsOpen(false);
      }}
    />
  );
}

async function mountDialog(props: HarnessProps = {}): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

function switches(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="switch"]'));
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button containing "${text}" did not render`);
  return button;
}

describe('VimModeAnnouncementDialog', () => {
  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('renders as a labelled modal with the real setup options', async () => {
    await mountDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Navigate and annotate at Vim speed');
    expect(dialog?.textContent).toContain('This is a demo');
    expect(dialog?.textContent).not.toContain('Ship collaborative review');
    expect(dialog?.textContent).toContain('Recommended');
    const selectionTarget = dialog?.querySelector('[data-vim-demo-target="selection"]');
    expect(selectionTarget?.querySelectorAll('.vim-announcement-reticle--selection')).toHaveLength(4);
    expect(selectionTarget?.querySelector('.vim-announcement-comment')).not.toBeNull();
    expect(switches()).toHaveLength(2);
    expect(switches().map(button => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
    ]);
  });

  test.skipIf(!hasDom)('enabling HUD also enables Vim, and disabling Vim clears HUD', async () => {
    await mountDialog();

    switches()[1].focus();
    await act(async () => switches()[1].click());
    expect(switches().map(button => button.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
    ]);
    expect(document.activeElement).toBe(switches()[1]);

    await act(async () => switches()[0].click());
    expect(switches().map(button => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
    ]);
  });

  test.skipIf(!hasDom)('the default primary action enables Vim and HUD before dismissing', async () => {
    const onDismiss = mock(() => {});
    await mountDialog({ onDismiss });

    await act(async () => buttonWithText('Enable Vim + HUD').click());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-vim-announcement-dialog]')).toBeNull();
  });

  test.skipIf(!hasDom)('Escape dismisses the dialog and restores prior focus', async () => {
    const priorButton = document.createElement('button');
    priorButton.textContent = 'Prior focus';
    document.body.appendChild(priorButton);
    priorButton.focus();
    const onDismiss = mock(() => {});
    await mountDialog({ initialVim: true, initialHud: true, onDismiss });

    expect(document.activeElement?.textContent).toContain('Start with Vim + HUD');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(priorButton);
  });
});
