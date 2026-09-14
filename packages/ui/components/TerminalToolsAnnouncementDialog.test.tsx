import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TerminalToolsAnnouncementDialog } from './TerminalToolsAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const DIALOG = '[data-terminal-tools-announcement-dialog]';

async function mountDialog(onDismiss: () => void = () => {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<TerminalToolsAnnouncementDialog isOpen onDismiss={onDismiss} />);
  });
}

/** Holds the open state so a dismiss actually unmounts, like the Apps do. */
function Harness({ onDismiss }: { readonly onDismiss: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <TerminalToolsAnnouncementDialog
      isOpen={open}
      onDismiss={() => {
        onDismiss();
        setOpen(false);
      }}
    />
  );
}

async function mountHarness(onDismiss: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness onDismiss={onDismiss} />);
  });
}

function gotItButton(): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
    .find((button) => button.textContent?.trim() === 'Got it');
  if (!match) throw new Error('Dismiss action did not render');
  return match;
}

describe('TerminalToolsAnnouncementDialog', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('renders as a labelled modal with exactly one completion action', async () => {
    await mountDialog();

    const dialog = document.querySelector(DIALOG);
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    const describedBy = dialog?.getAttribute('aria-describedby');
    expect(document.getElementById(labelledBy ?? '')).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).not.toBeNull();

    // One primary way out, so the announcement can never read as a choice.
    const completions = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
      .filter((button) => button.textContent?.trim() === 'Got it');
    expect(completions).toHaveLength(1);
    expect(document.activeElement).toBe(completions[0]);
  });

  test.skipIf(!hasDom)('sends every outbound link to a new tab with an isolated opener', async () => {
    await mountDialog();

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(`${DIALOG} a[href]`));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
  });

  test.skipIf(!hasDom)('the button, Escape and the backdrop all dismiss', async () => {
    const onDismiss = mock(() => {});
    await mountHarness(onDismiss);
    await act(async () => gotItButton().click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(DIALOG)).toBeNull();

    if (root) await act(async () => root?.unmount());
    host?.remove();
    host = null;
    document.body.replaceChildren();

    const onEscape = mock(() => {});
    await mountHarness(onEscape);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.querySelector(DIALOG)).toBeNull();

    if (root) await act(async () => root?.unmount());
    host?.remove();
    host = null;
    document.body.replaceChildren();

    const onBackdrop = mock(() => {});
    await mountHarness(onBackdrop);
    const backdrop = document.querySelector(DIALOG)?.parentElement;
    if (!backdrop) throw new Error('Backdrop did not render');
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onBackdrop).toHaveBeenCalledTimes(1);
    expect(document.querySelector(DIALOG)).toBeNull();
  });

  test.skipIf(!hasDom)('a press inside the panel is not a backdrop dismissal', async () => {
    const onDismiss = mock(() => {});
    await mountHarness(onDismiss);

    const panel = document.querySelector<HTMLElement>(DIALOG);
    if (!panel) throw new Error('Dialog did not render');
    await act(async () => {
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });

  test.skipIf(!hasDom)('swallows Mod+Enter so the app behind it cannot submit a decision', async () => {
    const appHandler = mock(() => {});
    document.addEventListener('keydown', appHandler);
    try {
      await mountDialog();
      await act(async () => {
        gotItButton().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
        );
        gotItButton().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        );
      });
      expect(appHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', appHandler);
    }
  });

  test.skipIf(!hasDom)('Tab wraps inside the dialog instead of escaping into the page', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind the dialog';
    document.body.appendChild(outside);
    try {
      await mountDialog();
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(`${DIALOG} button, ${DIALOG} [href]`),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      last.focus();
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });
      expect(document.activeElement).toBe(first);

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(last);
    } finally {
      outside.remove();
    }
  });

  test.skipIf(!hasDom)('renders nothing at all while closed', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<TerminalToolsAnnouncementDialog isOpen={false} onDismiss={() => {}} />);
    });

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(host.childNodes).toHaveLength(0);
  });
});
