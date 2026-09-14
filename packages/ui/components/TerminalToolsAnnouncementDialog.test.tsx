import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TERMINAL_TOOLS_DEMOS,
  TerminalToolsAnnouncementDialog,
} from './TerminalToolsAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const DIALOG = '[data-terminal-tools-announcement-dialog]';
const VIDEO = `${DIALOG} video[data-terminal-tools-demo]`;

async function mountDialog(
  onDismiss: () => void = () => {},
  props: { readonly reducedMotion?: boolean } = {},
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<TerminalToolsAnnouncementDialog isOpen onDismiss={onDismiss} {...props} />);
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

function video(): HTMLVideoElement {
  const match = document.querySelector<HTMLVideoElement>(VIDEO);
  if (!match) throw new Error('Demo video did not render');
  return match;
}

function tab(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} [role="tab"]`))
    .find((button) => button.textContent?.trim() === label);
  if (!match) throw new Error(`Demo tab "${label}" did not render`);
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

  test.skipIf(!hasDom)('the footage is inline, silent, looping and autoplaying', async () => {
    await mountDialog();

    const element = video();
    // Silent + inline is what lets a browser autoplay it at all (and what
    // keeps iOS from hijacking the dialog into a fullscreen player). React
    // mirrors `muted` to the property, not the attribute, so read both ways.
    expect(element.muted || element.hasAttribute('muted')).toBe(true);
    expect(element.hasAttribute('playsinline')).toBe(true);
    expect(element.hasAttribute('loop')).toBe(true);
    expect(element.hasAttribute('autoplay')).toBe(true);
    expect(element.getAttribute('poster')).toMatch(/^https:\/\/plannotator\.ai\/assets\//);

    // mp4 is the first source every browser can play; webm is the fallback.
    const sources = Array.from(element.querySelectorAll('source')).map((source) => source.type);
    expect(sources).toEqual(['video/mp4', 'video/webm']);
  });

  test.skipIf(!hasDom)('reduced motion withholds autoplay and offers a play button instead', async () => {
    await mountDialog(() => {}, { reducedMotion: true });

    const element = video();
    expect(element.hasAttribute('autoplay')).toBe(false);
    // Still silent and inline: the reader may press play, and it must then
    // behave exactly like the autoplaying version.
    expect(element.muted || element.hasAttribute('muted')).toBe(true);
    expect(element.hasAttribute('playsinline')).toBe(true);
    const play = document.querySelector(`${DIALOG} [data-terminal-tools-playback="play"]`);
    expect(play).not.toBeNull();
    expect(play?.getAttribute('aria-label')).toBe('Play demo');
    // The tag's sheen is motion too: it must not run for a reader who asked
    // for none, while the tag itself stays.
    const tag = document.querySelector(`${DIALOG} [data-terminal-tools-tag]`);
    expect(tag).not.toBeNull();
    expect(tag?.getAttribute('data-shimmer')).toBe('off');
    expect(tag?.classList.contains('terminal-tools-announcement-tag--sheen')).toBe(false);
  });

  test.skipIf(!hasDom)('the footage tag shimmers by default', async () => {
    await mountDialog();
    const tag = document.querySelector(`${DIALOG} [data-terminal-tools-tag]`);
    expect(tag?.getAttribute('data-shimmer')).toBe('on');
    expect(tag?.classList.contains('terminal-tools-announcement-tag--sheen')).toBe(true);
  });

  test.skipIf(!hasDom)('the demo switch swaps the footage and the X link together', async () => {
    await mountDialog();

    const full = TERMINAL_TOOLS_DEMOS.find((demo) => demo.id === 'full');
    const lite = TERMINAL_TOOLS_DEMOS.find((demo) => demo.id === 'lite');
    if (!full || !lite) throw new Error('Both demos must be defined');

    expect(video().getAttribute('data-terminal-tools-demo')).toBe('full');
    const watchLink = () =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(`${DIALOG} a[href]`))
        .find((link) => link.textContent?.trim() === 'Watch on X');
    expect(watchLink()?.getAttribute('href')).toBe(full.watchUrl);
    expect(tab('Full').getAttribute('aria-selected')).toBe('true');

    await act(async () => tab('Lite').click());

    // The X link has to follow the footage: "Watch on X" under the Lite demo
    // pointing at the Full post would be a lie.
    expect(video().getAttribute('data-terminal-tools-demo')).toBe('lite');
    expect(watchLink()?.getAttribute('href')).toBe(lite.watchUrl);
    expect(tab('Lite').getAttribute('aria-selected')).toBe('true');
    expect(tab('Full').getAttribute('aria-selected')).toBe('false');
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
      // The unselected demo tab is tabindex -1 (roving tabindex), so the
      // wrap must skip it the same way the browser's own Tab order does.
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(`${DIALOG} button, ${DIALOG} [href]`),
      ).filter((element) => element.getAttribute('tabindex') !== '-1');
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
