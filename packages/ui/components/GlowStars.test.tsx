/**
 * The lit look (GlowStars.tsx, glowStars.css), in the DOM.
 *
 * What regresses: the glow or a star reaching a screen reader or taking a click (they are decoration); a star drawn
 * over the control's label (the control must paint above the glow and the stars); the loops running in a hidden tab;
 * motion under prefers-reduced-motion, or an animation of anything but transform and opacity (the cheap, composited
 * properties).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { GlowStars, GLOW_FACE } = (hasDom ? await import('./GlowStars') : {}) as typeof import('./GlowStars');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <GlowStars>
        <a href="https://example.com/launch" className={GLOW_FACE} data-face>
          See the launch
        </a>
      </GlowStars>,
    ),
  );
  return host.querySelector<HTMLElement>('[data-glow-stars]')!;
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe.skipIf(!hasDom)('GlowStars', () => {
  test('decoration only: the glow and the stars are hidden from assistive tech, carry no text, and the control paints above them', async () => {
    const glow = await mount();
    const face = glow.querySelector<HTMLElement>('[data-face]')!;
    const decoration = [...glow.children].filter((child) => child !== face);
    expect(decoration.length).toBeGreaterThan(0);
    for (const part of decoration) {
      expect(part.getAttribute('aria-hidden')).toBe('true');
      expect(part.textContent).toBe('');
    }
    expect(glow.querySelectorAll('.pn-glow-star').length).toBeGreaterThan(0);
    // Later siblings paint above earlier ones at the same stacking level; the face is last.
    expect(glow.lastElementChild).toBe(face);
    expect(glow.textContent).toBe('See the launch');
  });

  test('a hidden tab pauses the loops; visible again, they run', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      const glow = await mount();
      expect(glow.hasAttribute('data-paused')).toBe(false);
      await act(async () => setVisibility('hidden'));
      expect(glow.hasAttribute('data-paused')).toBe(true);
      await act(async () => setVisibility('visible'));
      expect(glow.hasAttribute('data-paused')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});

describe('glowStars.css', () => {
  const css = readFileSync(join(import.meta.dir, 'glowStars.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  test('every keyframe changes transform or opacity only', () => {
    const frames = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
    expect(frames.length).toBeGreaterThan(0);
    for (const [, body] of frames) {
      for (const [, decls] of body!.matchAll(/\{([^{}]*)\}/g)) {
        for (const prop of decls!.split(';').map((d) => d.split(':')[0]!.trim()).filter(Boolean)) {
          expect(['transform', 'opacity']).toContain(prop);
        }
      }
    }
  });

  test('no animation outside prefers-reduced-motion: no-preference (reduced motion: still)', () => {
    const outside = css.replace(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
    expect(outside).not.toMatch(/(^|[\s;{])animation(-name)?\s*:/);
    expect(css).toMatch(/prefers-reduced-motion:\s*no-preference/);
  });
});
