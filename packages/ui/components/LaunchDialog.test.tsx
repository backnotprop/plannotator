/**
 * The launch dialog (LaunchDialog.tsx), in the DOM.
 *
 * What regresses: a dialog a screen reader cannot name (role, labelled by its title); focus starting on a control (it
 * would open with a ring; it starts on the panel), the first Tab not reaching "Not now" then "See the launch", or Enter
 * on opening following the link or reaching the page behind; the link not being a plain new-tab link with rel noopener (a popup blocker eats a tab opened after
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
  test('a named dialog: role dialog, labelled by its title, described by its line, focus on the panel itself', async () => {
    await mount(() => {});
    const el = dialog()!;
    expect(el.getAttribute('role')).toBe('dialog');
    const title = document.getElementById(el.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(LAUNCH_DIALOG_WORDS.title);
    expect(document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent).toBe(LAUNCH_DIALOG_WORDS.line);
    // On the panel, not a control: nothing opens with a focus ring.
    expect(document.activeElement === el).toBe(true);
    expect(el.tabIndex).toBe(-1);
    // And the panel itself draws no ring (the global :focus-visible outline would otherwise frame the whole dialog).
    expect(el.style.outlineStyle).toBe('none');
  });

  test('the first Tab reaches Not now, the next See the launch (the panel is not in the Tab order)', async () => {
    await mount(() => {});
    const tabbable = [...dialog()!.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter((el) => el.tabIndex >= 0);
    expect(tabbable.map((el) => (el.hasAttribute('data-launch-not-now') ? 'not-now' : el.hasAttribute('data-launch-open') ? 'open' : el.outerHTML))).toEqual(['not-now', 'open']);
  });

  test('Enter on opening does nothing: no answer, the link is not followed, the page behind never sees it', async () => {
    const log: string[] = [];
    await mount((a) => log.push(a));
    let clicked = 0;
    let behind = 0;
    open().addEventListener('click', (e) => {
      clicked += 1;
      e.preventDefault();
    });
    const onWindow = () => (behind += 1);
    window.addEventListener('keydown', onWindow);
    try {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      await wait(5);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
    expect([log, clicked, behind]).toEqual([[], 0, 0]);
    expect(dialog()).not.toBeNull();
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

  test("See the launch in the VS Code panel: the click reaches the panel's link bridge untaken, and still answers opened", async () => {
    // The panel's frame has no popups; its bridge (apps/vscode-extension/src/cookie-proxy.ts) listens for clicks on the
    // document and sends an `a[href][target=_blank]` to another origin to the editor's open-external, unless the page
    // took the click first (defaultPrevented) or stopped it on the way.
    (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE = true;
    const log: string[] = [];
    const bridged: string[] = [];
    const bridge = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!e.defaultPrevented && e.button === 0 && a?.target === '_blank') {
        const href = new URL(a.getAttribute('href')!, location.href);
        if (href.origin !== location.origin && href.protocol === 'https:') bridged.push(href.href);
      }
      e.preventDefault();
    };
    document.addEventListener('click', bridge, false);
    try {
      await mount((a) => log.push(a));
      // On the arrow inside the link, as a person may click it.
      await act(async () => open().querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
      await wait(5);
    } finally {
      document.removeEventListener('click', bridge, false);
      delete (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE;
    }
    expect(bridged).toEqual([URL_]);
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
