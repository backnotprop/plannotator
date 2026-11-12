import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { TaterMark } = (hasDom ? await import('./components/TaterMark') : {}) as typeof import('./components/TaterMark');

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

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
    expect(value(strip, 'animation')).toBe('ib-tater-sidebar 3.5s steps(24) infinite');
    expect(CSS).toMatch(/@keyframes ib-tater-sidebar\s*\{\s*to\s*\{\s*transform:\s*translateX\(-924px\);\s*\}\s*\}/);
    expect(value(win, 'width')).toBe('38.5px');
    expect(value(win, 'overflow')).toBe('hidden');
    expect(value(win, 'transform')).toBe('scaleX(-1)');
    expect(value(strip, 'width')).toBe('924px');
    expect(value(strip, 'background-size')).toBe('924px 44px');
    expect(value(strip, 'margin-left')).toBe('0');
  });

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
