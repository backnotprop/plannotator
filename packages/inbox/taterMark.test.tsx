/**
 * The sidebar's Tater mark loops on the compositor (#2593): a sprite strip slides by `transform` inside a
 * one-frame window, where a `background-position` loop restyled the page 60 times a second while idle.
 * The failures this catches:
 * - the loop animating anything but `transform` again (back to a style recalculation every frame);
 * - the frame arithmetic drifting (24 frames of 38.5 px: a 38.5 px window over a 924 px strip, moved by
 *   the strip's whole width), which shows a slice of two frames at once;
 * - the strip taking `.ib-brand span`'s -4 px margin (the brand's words), which shifts every frame
 *   4 px and shows the edge of the next one (it did, while this was built).
 * The real TaterMark is rendered; the cascade is worked out from inbox.css (cssCascade.testing.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { TaterMark } = (hasDom ? await import('./components/TaterMark') : {}) as typeof import('./components/TaterMark');

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

/** The body of the `@media (prefers-reduced-motion: reduce)` block that mentions the Tater mark. The cascade
 *  never applies `@media`, so the test applies this one by appending its body unwrapped. */
function reducedMotionBody(css: string): string {
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    const body = css.slice(re.lastIndex, i - 1);
    if (body.includes('ib-tater')) return body;
  }
  throw new Error('no reduced-motion block for the Tater mark');
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe.skipIf(!hasDom)('the Tater mark', () => {
  test('a strip slides by transform inside a one-frame window, every frame whole', () => {
    host = document.createElement('div');
    host.className = 'ib-brand';
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<TaterMark />));
    const win = host.querySelector('.ib-tater')!;
    const strip = win.querySelector<HTMLElement>('[data-sprite="tater-sidebar"]')!;
    expect(strip).not.toBeNull();
    expect(strip.style.backgroundImage).toContain('url(');

    const css = loadCascade(CSS);
    const value = (el: Element, prop: string) => css.winner(el, prop)?.value;
    // The loop moves only transform: composited, no style work on the page per frame.
    expect(value(strip, 'animation')).toBe('ib-tater-sidebar 3.5s steps(24) infinite');
    expect(CSS).toMatch(/@keyframes ib-tater-sidebar\s*\{\s*to\s*\{\s*transform:\s*translateX\(-924px\);\s*\}\s*\}/);
    // One frame shows: 24 × 38.5 = 924, the window clips the rest, mirrored as before.
    expect(value(win, 'width')).toBe('38.5px');
    expect(value(win, 'overflow')).toBe('hidden');
    expect(value(win, 'transform')).toBe('scaleX(-1)');
    expect(value(strip, 'width')).toBe('924px');
    expect(value(strip, 'background-size')).toBe('924px 44px');
    // The brand's words' -4 px margin stays off the strip.
    expect(value(strip, 'margin-left')).toBe('0');
  });

  // The loop stops under reduced motion on the element that carries it (the strip). The failure: the rule
  // moving to the window (`.ib-tater`), which has no animation of its own, so the strip keeps looping.
  test("reduced motion switches the strip's loop off, not the window's", () => {
    host = document.createElement('div');
    host.className = 'ib-brand';
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<TaterMark />));
    const strip = host.querySelector<HTMLElement>('[data-sprite="tater-sidebar"]')!;
    const css = loadCascade(`${CSS}\n${reducedMotionBody(CSS)}`);
    expect(css.winner(strip, 'animation')?.value).toBe('none');
  });

  // Nothing runs while the mark cannot be seen: the docked sidebar collapsed (clipped to no width) and its
  // hover copy parked offscreen both report "not intersecting", and the loop pauses until it shows again.
  // (A closed phone sheet unmounts the mark; a hidden tab draws no frames.) The failure: the pause landing
  // on an element that does not carry the animation, so a collapsed sidebar keeps the loop going.
  test('the loop pauses while the mark is off screen and resumes when it shows', () => {
    const observers: { callback: IntersectionObserverCallback; target: Element | null; disconnected: boolean }[] = [];
    const Real = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, target: null, disconnected: false };
        observers.push(this.entry);
      }
      observe(el: Element) { this.entry.target = el; }
      unobserve() {}
      disconnect() { this.entry.disconnected = true; }
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    try {
      host = document.createElement('div');
      host.className = 'ib-brand';
      document.body.append(host);
      root = createRoot(host);
      act(() => root!.render(<TaterMark />));
      const strip = host.querySelector<HTMLElement>('[data-sprite="tater-sidebar"]')!;
      const css = loadCascade(CSS);
      // The element whose play state is switched is the one that carries the loop.
      expect(css.winner(strip, 'animation')?.value).toContain('ib-tater-sidebar');
      const watcher = observers.find((o) => o.target !== null && !o.disconnected)!;
      const report = (isIntersecting: boolean) =>
        act(() => watcher.callback([{ isIntersecting, target: watcher.target } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(strip.style.animationPlayState).toBe('running');
      report(false);
      expect(strip.style.animationPlayState).toBe('paused');
      report(true);
      expect(strip.style.animationPlayState).toBe('running');
    } finally {
      globalThis.IntersectionObserver = Real;
    }
  });
});
