import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ASK_SESSION_DOCS_URL, ASK_SESSION_WATCH_URL, AskSessionAnnouncementDialog } from './AskSessionAnnouncementDialog';
import type { AskSessionAgent } from '../utils/askSessionAnnouncement';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const DIALOG = '[data-ask-session-announcement-dialog]';
const VIDEO = `${DIALOG} video[data-ask-session-demo]`;

interface MountProps {
  readonly agent?: AskSessionAgent;
  readonly reducedMotion?: boolean;
}

async function mountDialog(onDismiss: () => void = () => {}, props: MountProps = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AskSessionAnnouncementDialog
        isOpen
        agent={props.agent ?? 'claude-code'}
        reducedMotion={props.reducedMotion}
        onDismiss={onDismiss}
      />,
    );
  });
}

/** Holds the open state so a dismiss actually unmounts, like the Apps do. */
function Harness({ onDismiss }: { readonly onDismiss: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <AskSessionAnnouncementDialog
      isOpen={open}
      agent="claude-code"
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

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
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

describe('AskSessionAnnouncementDialog', () => {
  afterEach(unmount);

  test.skipIf(!hasDom)('renders as a labelled modal with exactly one completion action, focused', async () => {
    await mountDialog();

    const dialog = document.querySelector(DIALOG);
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')).not.toBeNull();
    expect(document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')).not.toBeNull();

    const completions = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
      .filter((button) => button.textContent?.trim() === 'Got it');
    expect(completions).toHaveLength(1);
    expect(document.activeElement).toBe(completions[0]);
  });

  test.skipIf(!hasDom)('names the agent that opened the session', async () => {
    // The copy must address the reader's own host: a Pi user told about
    // "Claude Code" would be told about a session they do not have.
    for (const [agent, name] of [['claude-code', 'Claude Code'], ['pi', 'Pi'], ['opencode', 'OpenCode']] as const) {
      await mountDialog(() => {}, { agent });
      const dialog = document.querySelector(DIALOG);
      expect(dialog?.getAttribute('data-ask-session-agent')).toBe(agent);
      const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
      expect(title?.textContent).toContain(name);
      await unmount();
    }
  });

  test.skipIf(!hasDom)('always says the session is connected; there is no setup variant', async () => {
    // The Apps open it only for a connected session, so the footer never
    // tells a reader to go and set something up.
    for (const agent of ['claude-code', 'pi', 'opencode'] as const) {
      await mountDialog(() => {}, { agent });
      expect(document.querySelector(`${DIALOG} [data-ask-session-status="connected"]`)).not.toBeNull();
      await unmount();
    }
  });

  test.skipIf(!hasDom)('Watch on X and Learn more open in a new tab without dismissing', async () => {
    const onDismiss = mock(() => {});
    await mountHarness(onDismiss);

    const links = [
      ['a[data-ask-session-watch]', ASK_SESSION_WATCH_URL],
      ['a[data-ask-session-learn-more]', ASK_SESSION_DOCS_URL],
    ] as const;
    const gotIt = gotItButton();
    // Got it stays the primary: it has focus, and Tab order reaches the links first.
    expect(document.activeElement).toBe(gotIt);

    for (const [selector, href] of links) {
      const link = document.querySelector<HTMLAnchorElement>(`${DIALOG} ${selector}`);
      if (!link) throw new Error(`${selector} did not render`);
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.compareDocumentPosition(gotIt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // Like the terminal-tools announcement's outbound links, following one
      // neither closes the announcement nor spends its cookie.
      const stopNavigation = (event: Event) => event.preventDefault();
      link.addEventListener('click', stopNavigation);
      await act(async () => link.click());
      link.removeEventListener('click', stopNavigation);
    }
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });

  test.skipIf(!hasDom)('the footage is hosted, inline, silent, looping and autoplaying', async () => {
    await mountDialog();

    const element = video();
    expect(element.muted || element.hasAttribute('muted')).toBe(true);
    expect(element.hasAttribute('playsinline')).toBe(true);
    expect(element.hasAttribute('loop')).toBe(true);
    expect(element.hasAttribute('autoplay')).toBe(true);
    expect(element.getAttribute('poster')).toMatch(/^https:\/\/plannotator\.ai\/assets\//);
    const sources = Array.from(element.querySelectorAll('source'));
    expect(sources.map((source) => source.type)).toEqual(['video/mp4', 'video/webm']);
    for (const source of sources) expect(source.getAttribute('src')).toMatch(/^https:\/\/plannotator\.ai\/assets\//);
  });

  test.skipIf(!hasDom)('reduced motion withholds autoplay and offers a play button instead', async () => {
    await mountDialog(() => {}, { reducedMotion: true });

    const element = video();
    expect(element.hasAttribute('autoplay')).toBe(false);
    expect(element.muted || element.hasAttribute('muted')).toBe(true);
    const play = document.querySelector(`${DIALOG} [data-ask-session-playback="play"]`);
    expect(play?.getAttribute('aria-label')).toBe('Play demo');
  });

  test.skipIf(!hasDom)('when the media cannot load, the frame stays and offers the X post', async () => {
    await mountDialog();
    const sources = video().querySelectorAll('source');
    await act(async () => {
      sources[sources.length - 1].dispatchEvent(new Event('error'));
    });
    const fallback = document.querySelector(`${DIALOG} [data-ask-session-demo-unavailable]`);
    expect(fallback?.querySelector('a')?.getAttribute('href')).toBe(ASK_SESSION_WATCH_URL);
    // The way out is unaffected.
    expect(gotItButton()).toBeDefined();
  });

  test.skipIf(!hasDom)('the button, Escape and the backdrop all dismiss', async () => {
    const onDismiss = mock(() => {});
    await mountHarness(onDismiss);
    await act(async () => gotItButton().click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(DIALOG)).toBeNull();
    await unmount();

    const onEscape = mock(() => {});
    await mountHarness(onEscape);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.querySelector(DIALOG)).toBeNull();
    await unmount();

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
        gotItButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
        gotItButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      });
      expect(appHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', appHandler);
    }
  });

  test.skipIf(!hasDom)('Tab wraps inside the dialog and focus returns on close', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind the dialog';
    document.body.appendChild(outside);
    outside.focus();
    await mountHarness(() => {});

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

    first.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);

    await act(async () => gotItButton().click());
    expect(document.activeElement).toBe(outside);
  });
});
