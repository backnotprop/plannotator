import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INBOX_FILM, INBOX_PAGE_URL, InboxAnnouncementDialog } from './InboxAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const DIALOG = '[data-inbox-announcement-dialog]';

/** Holds the open state so a dismiss actually unmounts, like the Apps do. */
function Harness({ onDismiss }: { readonly onDismiss: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <InboxAnnouncementDialog
      isOpen={open}
      onDismiss={() => {
        onDismiss();
        setOpen(false);
      }}
    />
  );
}

async function mount(onDismiss: () => void = () => {}) {
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

/** Booleans, not elements: bun's diff printer crashes on a Base UI element. */
function isOpen(): boolean {
  return document.querySelector(DIALOG) !== null;
}

function film(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>(`${DIALOG} video[data-inbox-film]`);
  if (!video) throw new Error('Film did not render');
  return video;
}

describe.if(hasDom)('InboxAnnouncementDialog', () => {
  afterEach(unmount);

  test('links to the Inbox page in a new tab', async () => {
    await mount();
    const link = document.querySelector<HTMLAnchorElement>(`${DIALOG} a[data-inbox-announcement-learn-more]`);
    expect(INBOX_PAGE_URL).toBe('https://plannotator.ai/inbox');
    expect(link?.getAttribute('href')).toBe(INBOX_PAGE_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('following the link counts as seen, after the click has been handled', async () => {
    const onDismiss = mock(() => {});
    await mount(onDismiss);
    const link = document.querySelector<HTMLAnchorElement>(`${DIALOG} a[data-inbox-announcement-learn-more]`);
    if (!link) throw new Error('Link did not render');
    // Stop happy-dom from navigating; the handler under test still runs.
    link.addEventListener('click', (event) => event.preventDefault());

    // A synchronous act: an async one waits a task, past the deferred close.
    let openDuringClick = false;
    link.addEventListener('click', () => { openDuringClick = isOpen(); });
    act(() => link.click());
    // Still on the page during and right after its own click, so the browser
    // follows it.
    expect(openDuringClick).toBe(true);
    expect(isOpen()).toBe(true);
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  test('the film downloads nothing until it is played, and never plays by itself', async () => {
    await mount();
    const video = film();
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('poster')).toBe(INBOX_FILM.poster);
    expect(video.querySelector('source')?.getAttribute('src')).toBe(INBOX_FILM.mp4);
    expect(INBOX_FILM.mp4).toBe('https://plannotator.ai/assets/inbox-film.mp4');
    // One play button over the poster; the native controls come with playing.
    expect(video.hasAttribute('controls')).toBe(false);
  });

  test('play starts the film and hands over to the native controls', async () => {
    await mount();
    const play = mock(() => Promise.resolve());
    film().play = play;
    const button = document.querySelector<HTMLButtonElement>(`${DIALOG} [data-inbox-film-play]`);
    if (!button) throw new Error('Play button did not render');

    await act(async () => button.click());
    expect(play).toHaveBeenCalledTimes(1);
    expect(film().hasAttribute('controls')).toBe(true);
    expect(document.querySelector(`${DIALOG} [data-inbox-film-play]`)).toBeNull();
  });

  test('a film that cannot load says so and leaves the rest of the dialog working', async () => {
    const onDismiss = mock(() => {});
    await mount(onDismiss);
    await act(async () => {
      film().querySelector('source')?.dispatchEvent(new Event('error'));
    });
    expect(document.querySelector(`${DIALOG} [data-inbox-film-unavailable]`)).not.toBeNull();
    expect(document.querySelector(`${DIALOG} [data-inbox-film-play]`)).toBeNull();
    expect(document.querySelector(`${DIALOG} a[data-inbox-announcement-learn-more]`)).not.toBeNull();

    const close = document.querySelector<HTMLButtonElement>(`${DIALOG} [data-inbox-announcement-close]`);
    await act(async () => close?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a film the browser cannot decode says so too', async () => {
    await mount();
    await act(async () => {
      film().dispatchEvent(new Event('error'));
    });
    expect(document.querySelector(`${DIALOG} [data-inbox-film-unavailable]`)).not.toBeNull();
    expect(document.querySelector(`${DIALOG} [data-inbox-film-play]`)).toBeNull();
  });

  test('opens with focus on Close, and Escape closes it without reaching the page', async () => {
    const onDismiss = mock(() => {});
    const pageKeys: string[] = [];
    const onPageKey = (event: KeyboardEvent) => pageKeys.push(event.key);
    window.addEventListener('keydown', onPageKey);
    try {
      await mount(onDismiss);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const close = document.querySelector<HTMLButtonElement>(`${DIALOG} [data-inbox-announcement-close]`);
      expect(document.activeElement === close).toBe(true);

      await act(async () => {
        close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      });
      expect(onDismiss).not.toHaveBeenCalled();

      await act(async () => {
        close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(isOpen()).toBe(false);
      expect(pageKeys).toEqual([]);
    } finally {
      window.removeEventListener('keydown', onPageKey);
    }
  });

  test('renders nothing while closed', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<InboxAnnouncementDialog isOpen={false} onDismiss={() => {}} />);
    });
    expect(isOpen()).toBe(false);
  });
});
