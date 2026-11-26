/**
 * The launch dialog (LaunchDialog.tsx), in the DOM.
 *
 * What regresses: a dialog a screen reader cannot name (role, labelled by its title); focus starting anywhere but
 * "See the launch"; the link not being a plain new-tab link with rel noopener (a popup blocker eats a tab opened after
 * an async call); a button that records the wrong answer, or answers twice; Escape or the close button not closing
 * it; a band that moves the layout while the art loads; a broken or slow picture leaving an empty band instead of
 * the words alone; the art loading from anywhere but the hosted launch folder.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { LaunchDialog } = (hasDom ? await import('./LaunchDialog') : {}) as typeof import('./LaunchDialog');
const { LAUNCH_DIALOG_WORDS, LAUNCH_ART_BASE } = (hasDom ? await import('../utils/launchDialogWords') : {}) as typeof import('../utils/launchDialogWords');

const URL_ = 'https://www.producthunt.com/posts/plannotator';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mount(onAnswer: (a: string) => void, artWaitMs?: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<LaunchDialog campaign="product-hunt-2026" url={URL_} onAnswer={onAnswer} artWaitMs={artWaitMs} />));
  await act(async () => new Promise((r) => setTimeout(r, 30)));
}

const dialog = () => document.querySelector<HTMLElement>('[data-launch-dialog]');
const band = () => document.querySelector<HTMLElement>('[data-launch-art-band]');
const img = () => document.querySelector<HTMLImageElement>('[data-launch-art-band] img');
const open = () => document.querySelector<HTMLAnchorElement>('[data-launch-open]')!;
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

describe.skipIf(!hasDom)('LaunchDialog', () => {
  test('a named dialog: role dialog, labelled by its title, described by its line, focus on See the launch', async () => {
    await mount(() => {});
    const el = dialog()!;
    expect(el.getAttribute('role')).toBe('dialog');
    const title = document.getElementById(el.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(LAUNCH_DIALOG_WORDS.title);
    expect(document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent).toBe(LAUNCH_DIALOG_WORDS.line);
    expect(document.activeElement === open()).toBe(true);
  });

  test('See the launch: a plain new-tab link with rel noopener, answered opened once', async () => {
    const log: string[] = [];
    await mount((a) => log.push(a));
    const link = open();
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(URL_);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')?.split(' ')).toContain('noopener');
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    await act(async () => link.click());
    await wait(5);
    await act(async () => document.querySelector<HTMLElement>('[data-launch-not-now]')!.click());
    expect(log).toEqual(['opened']);
  });

  test('Not now, Escape and the close button each answer dismissed', async () => {
    for (const how of ['not-now', 'escape', 'close'] as const) {
      const log: string[] = [];
      await mount((a) => log.push(a));
      await act(async () => {
        if (how === 'not-now') document.querySelector<HTMLElement>('[data-launch-not-now]')!.click();
        else if (how === 'close') document.querySelector<HTMLElement>('[data-launch-close]')!.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await wait(5);
      expect([how, log]).toEqual([how, ['dismissed']]);
      await act(async () => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });

  test('the art: a 16:9 band from the hosted launch folder while it loads, kept once it loads', async () => {
    await mount(() => {}, 60);
    expect(band()?.style.aspectRatio.replace(/\s/g, '')).toBe('16/9');
    expect(img()?.getAttribute('src')).toBe(`${LAUNCH_ART_BASE}product-hunt-2026.webp`);
    expect(dialog()?.getAttribute('data-launch-art')).toBe('loading');
    await act(async () => img()!.dispatchEvent(new Event('load')));
    await wait(90);
    expect(dialog()?.getAttribute('data-launch-art')).toBe('ready');
    expect(band()).not.toBeNull();
  });

  test('art that fails: the words alone, buttons still there', async () => {
    await mount(() => {});
    await act(async () => img()!.dispatchEvent(new Event('error')));
    expect(band()).toBeNull();
    expect(dialog()?.textContent).toContain(LAUNCH_DIALOG_WORDS.title);
    expect(open().textContent).toBe(LAUNCH_DIALOG_WORDS.open);
  });

  test('art that is slow: the band goes at the wait, and a late load does not bring it back', async () => {
    await mount(() => {}, 40);
    expect(band()).not.toBeNull();
    const late = img()!;
    await wait(70);
    expect(band()).toBeNull();
    await act(async () => late.dispatchEvent(new Event('load')));
    expect(band()).toBeNull();
    expect(dialog()?.getAttribute('data-launch-art')).toBe('gone');
  });
});
