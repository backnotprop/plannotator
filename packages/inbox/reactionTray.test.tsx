/**
 * The reaction tray on 👍 Looks good (approval "inbox-reaction-tray"), as the window draws it. Failures to
 * catch: the tray not being 👍, the saved emoji, the free +, then … in that order; the always-one-free-+ rule
 * broken (two at the start, one from one saved to four, none at five); words drawn on the tray; a + that
 * reacts instead of saving, or a save that loses its optional name (or invents one); the name not reaching
 * config.json through POST /api/inbox/settings `{ reactions }`; … saving its emoji, or not reacting with it;
 * a saved emoji not reacting with its name; the 👍 no longer one click (a tray in the way, two calls, or a
 * reaction where Looks good was), or not taking the mark back when pressed; Escape not closing the tray or
 * the picker.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReaction } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ReactionTray } = (hasDom ? await import('./components/ReactionTray') : {}) as typeof import('./components/ReactionTray');
const { resetSavedReactionsForTests, savedReactions } = await import('./reactions');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let acks: [boolean, InboxReaction | null][] = [];

beforeEach(() => {
  if (!hasDom) return;
  posted = [];
  acks = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://127.0.0.1').pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    posted.push({ path, body });
    return new Response(JSON.stringify({ reactions: body.reactions ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = savedFetch;
  resetSavedReactionsForTests();
  document.body.innerHTML = '';
});

const settle = (ms = 60) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

async function render(opts: { on?: boolean; current?: InboxReaction | null; saved?: InboxReaction[] } = {}) {
  resetSavedReactionsForTests(opts.saved ?? []);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <div className="ib-pfoot">
        <ReactionTray messageId="msg_1" agent="Claude Code" on={opts.on ?? false} current={opts.current ?? null} phone={false} onAck={(on, reaction) => acks.push([on, reaction])} />
      </div>,
    ),
  );
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const tray = () => $('[data-reaction-tray]');
const cells = () => $$('[data-reaction-tray] .ib-react-cells > [data-reaction]').map((el) => el.getAttribute('data-reaction'));

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
  await settle();
}

/** The keyboard's way in: "More reactions" after the 👍. */
async function openTray() {
  const more = $('[data-react-more]')!;
  await act(async () => {
    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
  if (!tray()) await press(more);
  expect(tray()).not.toBeNull();
}

async function key(k: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pickEmoji(emoji: string) {
  await settle(80);
  const cell = $(`.ib-emo [data-emo="${emoji}"]`);
  expect(cell).not.toBeNull();
  await act(async () => cell!.click());
  await settle(220);
}

const settingsPosts = () => posted.filter((p) => p.path === '/api/inbox/settings').map((p) => p.body.reactions);

test.skipIf(!hasDom)('the tray is 👍, the saved emoji, the free +, then …; one free + always, two at the start, none at five; no words', async () => {
  const SAVED: InboxReaction[] = [{ emoji: '🚀', label: 'Ship it' }, { emoji: '🧪' }, { emoji: '👀' }, { emoji: '🎉' }, { emoji: '❤️', label: 'Love it' }];
  const expected: Record<number, (string | null)[]> = {
    0: ['looks-good', 'add', 'add', 'any'],
    1: ['looks-good', 'saved-0', 'add', 'any'],
    2: ['looks-good', 'saved-0', 'saved-1', 'add', 'any'],
    4: ['looks-good', 'saved-0', 'saved-1', 'saved-2', 'saved-3', 'add', 'any'],
    5: ['looks-good', 'saved-0', 'saved-1', 'saved-2', 'saved-3', 'saved-4', 'any'],
  };
  for (const [n, layout] of Object.entries(expected)) {
    await render({ saved: SAVED.slice(0, Number(n)) });
    await openTray();
    expect(cells(), `${n} saved`).toEqual(layout);
    // No words on the tray: each cell is its emoji (or a + / …); a name is only a tooltip and the cell's name.
    expect(tray()!.querySelector('.ib-react-cells')!.textContent!.replace(/\s/g, '')).toBe(['👍', ...SAVED.slice(0, Number(n)).map((r) => r.emoji)].join(''));
    if (Number(n) >= 1) {
      expect($('[data-reaction="saved-0"]')!.getAttribute('data-tip')).toBe('Ship it');
      expect($('[data-reaction="saved-0"]')!.getAttribute('aria-label')).toBe('🚀 Ship it');
    }
    if (Number(n) >= 2) expect($('[data-reaction="saved-1"]')!.hasAttribute('data-tip')).toBe(false);
    // Escape closes the tray.
    await key('Escape');
    expect(tray()).toBeNull();
    act(() => root?.unmount());
    root = null;
    host?.remove();
    document.body.innerHTML = '';
  }
});

test.skipIf(!hasDom)('a + saves an emoji with the name typed (Enter keeps it), into config.json; the tray comes back with it; nothing is sent', async () => {
  await render();
  await openTray();
  await press($('[data-reaction="add"]')!);
  expect($('.ib-emo')).not.toBeNull();
  expect(tray()).toBeNull();
  await pickEmoji('🚀');
  // Saved at once, the light name field over the tray.
  expect(savedReactions()).toEqual([{ emoji: '🚀' }]);
  const field = $('[data-name-field]') as HTMLInputElement;
  expect(field).not.toBeNull();
  expect(field.placeholder).toBe('Name it (optional)');
  await type(field, 'Ship it');
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle(300);
  expect(savedReactions()).toEqual([{ emoji: '🚀', label: 'Ship it' }]);
  expect(settingsPosts()).toEqual([[{ emoji: '🚀' }], [{ emoji: '🚀', label: 'Ship it' }]]);
  // The tray is back, the new emoji in it with its name as the tooltip, and still one free +.
  expect(cells()).toEqual(['looks-good', 'saved-0', 'add', 'any']);
  expect($('[data-reaction="saved-0"]')!.getAttribute('data-tip')).toBe('Ship it');
  // Saving reacts with nothing.
  expect(acks).toEqual([]);
  expect(posted.filter((p) => p.path.endsWith('/ack'))).toEqual([]);

  // The saved one now reacts with its emoji and name in one click.
  await press($('[data-reaction="saved-0"]')!);
  expect(acks).toEqual([[true, { emoji: '🚀', label: 'Ship it' }]]);
});

test.skipIf(!hasDom)('a + saves an emoji without a name: Escape skips the name, and the saved emoji has none', async () => {
  await render({ saved: [{ emoji: '🚀', label: 'Ship it' }] });
  await openTray();
  await press($('[data-reaction="add"]')!);
  await pickEmoji('🧪');
  const field = $('[data-name-field]') as HTMLInputElement;
  expect(field).not.toBeNull();
  await type(field, 'typed then skipped');
  await key('Escape');
  await settle(200);
  expect($('[data-name-field]')).toBeNull();
  expect(savedReactions()).toEqual([{ emoji: '🚀', label: 'Ship it' }, { emoji: '🧪' }]);
  expect(settingsPosts()).toEqual([[{ emoji: '🚀', label: 'Ship it' }, { emoji: '🧪' }]]);
  expect(acks).toEqual([]);
});

test.skipIf(!hasDom)('… reacts once with any emoji: the agent\'s message gets it, nothing is saved; Escape closes the picker', async () => {
  await render({ saved: [{ emoji: '🚀', label: 'Ship it' }] });
  await openTray();
  await press($('[data-reaction="any"]')!);
  expect($('.ib-emo')).not.toBeNull();
  // Escape closes the picker without reacting.
  await key('Escape');
  await settle(200);
  expect($('.ib-emo')).toBeNull();
  expect(acks).toEqual([]);

  await openTray();
  await press($('[data-reaction="any"]')!);
  await pickEmoji('🦄');
  expect(acks).toEqual([[true, { emoji: '🦄' }]]);
  expect($('.ib-emo')).toBeNull();
  expect(tray()).toBeNull();
  // Not saved: the tray and config.json are as they were.
  expect(savedReactions()).toEqual([{ emoji: '🚀', label: 'Ship it' }]);
  expect(settingsPosts()).toEqual([]);
});

test.skipIf(!hasDom)('👍 is still one click: Looks good at once, no tray in the way; pressed, one click takes the mark back', async () => {
  await render({ saved: [{ emoji: '🚀', label: 'Ship it' }] });
  const thumb = $('[data-ack]') as HTMLButtonElement;
  expect(thumb.textContent).toBe('👍Looks good');
  expect(thumb.getAttribute('aria-pressed')).toBe('false');
  await act(async () => thumb.click());
  await settle();
  expect(acks).toEqual([[true, null]]);
  expect(tray()).toBeNull();
  expect($('.ib-emo')).toBeNull();

  // Marked with a saved emoji: the button shows it, and one click takes it back (the one taken back named).
  act(() => root?.unmount());
  host?.remove();
  acks = [];
  await render({ on: true, current: { emoji: '🚀', label: 'Ship it' }, saved: [{ emoji: '🚀', label: 'Ship it' }] });
  const pressed = $('[data-ack]') as HTMLButtonElement;
  expect(pressed.getAttribute('aria-pressed')).toBe('true');
  expect(pressed.textContent).toBe('🚀Ship it');
  await act(async () => pressed.click());
  await settle();
  expect(acks).toEqual([[false, { emoji: '🚀', label: 'Ship it' }]]);
});
