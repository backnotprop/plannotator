/**
 * The one-time "The Inbox can ring now" dialog as drawn
 * (components/SoundIntro.tsx): the notification line in each of its four
 * states, the buttons, and the keyboard (Keep it on has the first focus,
 * Escape keeps the sound on, Tab stays inside, focus follows the line when
 * it changes).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NotificationLine, SoundIntroDialogProps } from './components/SoundIntro';

const hasDom = typeof document !== 'undefined';
const { SoundIntroDialog, notificationLine } = (hasDom ? await import('./components/SoundIntro') : {}) as typeof import('./components/SoundIntro');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function calls() {
  const seen: string[] = [];
  const props: SoundIntroDialogProps = {
    line: 'on',
    playing: false,
    onPlay: () => seen.push('play'),
    onTurnOnNotifications: () => seen.push('turn-on-notifications'),
    onKeep: () => seen.push('keep'),
    onTurnOff: () => seen.push('off'),
  };
  return { seen, props };
}

function render(props: SoundIntroDialogProps) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<SoundIntroDialog {...props} />);
  });
  return host.querySelector('dialog[data-dialog="sound-intro"]') as HTMLDialogElement;
}

const button = (dialog: HTMLElement, name: string) =>
  [...dialog.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name) as HTMLButtonElement;

/** The dialog's Play: named by its own words, "Play" or "Playing…". */
const playButton = (dialog: HTMLElement) => dialog.querySelector('[data-sound-play]') as HTMLButtonElement;

function key(target: Element, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe.if(hasDom)('the sound dialog', () => {
  test('notifications on: the title with Play, the one sentence, no notification line, Turn it off · Keep it on', () => {
    const { props } = calls();
    const dialog = render(props);
    expect(dialog.getAttribute('aria-labelledby')).toBe('ib-sound-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('ib-sound-desc');
    expect(dialog.querySelector('#ib-sound-title')?.textContent).toBe('The Inbox can ring now');
    expect(dialog.querySelector('#ib-sound-desc')?.textContent?.trim()).toBe(
      'A soft doorbell when an agent asks you something and this tab is hidden.',
    );
    expect(dialog.querySelector('[data-sound-nline]')).toBeNull();
    expect([...dialog.querySelectorAll('.ib-acts-row button')].map((b) => b.textContent)).toEqual(['Turn it off', 'Keep it on']);
    expect(playButton(dialog).textContent).toBe('Play');
    // No aria-label: the words themselves ("Play", "Playing…") are what a screen reader announces.
    expect(playButton(dialog).hasAttribute('aria-label')).toBe(false);
  });

  const lines: [NotificationLine, string, string | null][] = [
    ['not-allowed', "Notifications aren't allowed yet.Allow", 'Allow'],
    ['off', 'Notifications are off.Turn on', 'Turn on'],
    ['blocked', 'Notifications are blocked. Allow them from the address bar.', null],
  ];
  for (const [line, text, action] of lines) {
    test(`notifications ${line}: one line${action ? ` with ${action}` : ', no button (a page cannot unblock itself)'}`, () => {
      const { seen, props } = calls();
      const dialog = render({ ...props, line });
      const el = dialog.querySelector(`[data-sound-nline="${line}"]`) as HTMLElement;
      expect(el.textContent).toBe(text);
      expect(el.closest('[aria-live="polite"]')).not.toBeNull();
      if (action) {
        act(() => button(dialog, action).click());
        expect(seen).toEqual(['turn-on-notifications']);
      } else expect(el.querySelector('button')).toBeNull();
    });
  }

  test('Keep it on has the first focus; Escape keeps the sound on and never reaches the page', () => {
    const { seen, props } = calls();
    let pageHeard = 0;
    const onPage = (event: KeyboardEvent) => event.key === 'Escape' && pageHeard++;
    window.addEventListener('keydown', onPage);
    try {
      const dialog = render({ ...props, line: 'not-allowed' });
      expect(document.activeElement?.textContent).toBe('Keep it on');
      key(document.activeElement!, { key: 'Escape' });
      expect(seen).toEqual(['keep']);
      expect(pageHeard).toBe(0);
      expect(dialog).toBeTruthy();
    } finally {
      window.removeEventListener('keydown', onPage);
    }
  });

  test('Tab stays inside: from Keep it on to Play, and Shift+Tab back', () => {
    const { props } = calls();
    const dialog = render({ ...props, line: 'off' });
    const keep = button(dialog, 'Keep it on');
    const play = playButton(dialog);
    expect(document.activeElement).toBe(keep);
    key(keep, { key: 'Tab' });
    expect(document.activeElement).toBe(play);
    key(play, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(keep);
  });

  test('Turn it off and Play report to the page; Play reads Playing… while it plays', () => {
    const { seen, props } = calls();
    const dialog = render(props);
    act(() => playButton(dialog).click());
    act(() => button(dialog, 'Turn it off').click());
    expect(seen).toEqual(['play', 'off']);
    act(() => root!.render(<SoundIntroDialog {...props} playing />));
    expect(playButton(dialog).textContent).toBe('Playing…');
  });

  test('Allow answered: the line goes and focus moves to Keep it on; Block: the blocked line takes focus', () => {
    const { props } = calls();
    const dialog = render({ ...props, line: 'not-allowed' });
    button(dialog, 'Allow').focus();
    act(() => root!.render(<SoundIntroDialog {...props} line="on" />));
    expect(dialog.querySelector('[data-sound-nline]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Keep it on');
    act(() => root!.render(<SoundIntroDialog {...props} line="blocked" />));
    expect(document.activeElement?.getAttribute('data-sound-nline')).toBe('blocked');
  });
});

describe.if(hasDom)('notificationLine', () => {
  test('the browser first, then the Inbox switch', () => {
    expect(notificationLine(true, 'granted')).toBe('on');
    expect(notificationLine(true, 'default')).toBe('not-allowed');
    expect(notificationLine(false, 'granted')).toBe('off');
    expect(notificationLine(false, 'default')).toBe('off');
    expect(notificationLine(false, 'denied')).toBe('blocked');
    expect(notificationLine(true, 'unsupported')).toBe('on');
  });
});
