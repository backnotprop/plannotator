import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LookAndFeelAnnouncementDialog } from './LookAndFeelAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountDialog(props: {
  gridEnabled?: boolean;
  onToggleGrid?: (enabled: boolean) => void;
  onDismiss?: () => void;
} = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <LookAndFeelAnnouncementDialog
        isOpen
        gridEnabled={props.gridEnabled ?? true}
        onToggleGrid={props.onToggleGrid ?? (() => {})}
        onDismiss={props.onDismiss ?? (() => {})}
      />,
    );
  });
}

function option(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
    .find((button) => button.textContent?.includes(label));
  if (!match) throw new Error(`Missing ${label} option`);
  return match;
}

describe('LookAndFeelAnnouncementDialog', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('renders only the Grid/Clean decision as a labelled modal', async () => {
    await mountDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).not.toContain('0.20.0');
    expect(dialog?.textContent).not.toContain('release notes');
    expect(dialog?.querySelectorAll('button[aria-pressed]')).toHaveLength(2);
    expect(option('Grid').getAttribute('aria-pressed')).toBe('true');
    expect(option('Clean').getAttribute('aria-pressed')).toBe('false');
  });

  test.skipIf(!hasDom)('exposes the real choice and a single completion action', async () => {
    const onToggleGrid = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onToggleGrid, onDismiss });

    await act(async () => option('Clean').click());
    expect(onToggleGrid).toHaveBeenCalledWith(false);

    const continueButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Continue');
    expect(continueButton).toBeDefined();
    expect(document.activeElement).toBe(continueButton);

    await act(async () => continueButton?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('Escape resolves the displayed choice and restores prior focus', async () => {
    const prior = document.createElement('button');
    prior.textContent = 'Prior';
    document.body.appendChild(prior);
    prior.focus();
    const onDismiss = mock(() => {});
    await mountDialog({ onDismiss });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(prior);
  });
});
