/**
 * The launch dialog (LaunchDialog.tsx), in the DOM.
 *
 * What regresses: a dialog a screen reader cannot name (role, labelled by its title); focus starting anywhere but
 * "See the launch"; the link not being a plain new-tab link with rel noopener (a popup blocker eats a tab opened after
 * an async call); a button that records the wrong answer, or answers twice; Escape not closing it; the layout changing once it is open (the band appearing or going); the art loading from
 * anywhere but the hosted launch folder.
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

async function mount(onAnswer: (a: string) => void, art = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<LaunchDialog campaign="product-hunt-2026" url={URL_} onAnswer={onAnswer} art={art} />));
  await act(async () => new Promise((r) => setTimeout(r, 30)));
}

const dialog = () => document.querySelector<HTMLElement>('[data-launch-dialog]');
const img = () => document.querySelector<HTMLImageElement>('[data-launch-dialog] img');
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

  test('Not now and Escape each answer dismissed', async () => {
    for (const how of ['not-now', 'escape'] as const) {
      const log: string[] = [];
      await mount((a) => log.push(a));
      await act(async () => {
        if (how === 'not-now') document.querySelector<HTMLElement>('[data-launch-not-now]')!.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await wait(5);
      expect([how, log]).toEqual([how, ['dismissed']]);
      await act(async () => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });

  test('with art: a 16:9 band from the hosted launch folder; a later error moves nothing', async () => {
    await mount(() => {}, true);
    const band = img()!.parentElement!;
    expect(Number.parseFloat(band.style.aspectRatio)).toBeCloseTo(16 / 9, 5);
    expect(img()?.getAttribute('src')).toBe(`${LAUNCH_ART_BASE}product-hunt-2026.webp`);
    expect(dialog()?.getAttribute('data-launch-art')).toBe('ready');
    await act(async () => img()!.dispatchEvent(new Event('error')));
    await wait(30);
    expect(img()?.parentElement).toBe(band);
  });

  test('without art (the host gave up on it): the words alone, no band, buttons still there', async () => {
    await mount(() => {}, false);
    expect(img()).toBeNull();
    expect(dialog()?.getAttribute('data-launch-art')).toBe('gone');
    expect(dialog()?.textContent).toContain(LAUNCH_DIALOG_WORDS.title);
    expect(open().textContent).toBe(LAUNCH_DIALOG_WORDS.open);
  });
});
