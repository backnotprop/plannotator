/**
 * What regresses if this fails: plan review's Contents list marks a different
 * heading at the same scroll position. Plan review keeps `useActiveSection`
 * unchanged (the contents rail has its own scroll math, utils/headingScrollSpy),
 * and its answer is pinned here at positions of plan review's own wiring (App:
 * the plan area as the container, the OverlayScrollArea viewport as the
 * scroll element). The band runs from 80 px below the top to 20% of the
 * height: positions below sit a heading just above 80 px (a 52 px line would
 * mark it), across 80 px but not 100 (a 100 px line would not), and just
 * below 20% (a 30% bottom would mark it). The topmost heading in the band
 * wins; with none in it the last answer stays (scrolling back up included).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installBandIntersectionObserver } from '../test-setup/bandIntersectionObserver';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreObserver: (() => void) | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreObserver?.();
  restoreObserver = null;
});

/** Headings 30 px tall at these offsets in the plan; the viewport is 600 px tall, so the band is 80 to 120 px. */
const TOPS = { Overview: 0, Context: 300, Design: 700, Rollout: 1100, Risks: 1500 };

describe.if(hasDom)('useActiveSection at fixed scroll positions (plan review)', () => {
  test('marks the topmost heading in the band and keeps it while none is there', async () => {
    restoreObserver = installBandIntersectionObserver();
    const { useActiveSection } = await import('./useActiveSection');
    let active: string | null = 'unset';
    let viewportEl: HTMLDivElement | null = null;

    function Plan() {
      const planAreaRef = useRef<HTMLDivElement>(null);
      const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
      active = useActiveSection(planAreaRef, Object.keys(TOPS).length, viewport);
      return (
        <div
          ref={(el) => {
            viewportEl = el;
            if (el && el !== viewport) setViewport(el);
          }}
        >
          <div ref={planAreaRef}>
            {Object.keys(TOPS).map((name) => (
              <h2 key={name} data-block-id={name} data-block-type="heading">
                {name}
              </h2>
            ))}
          </div>
        </div>
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Plan />));
    const viewport = viewportEl!;
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    for (const heading of viewport.querySelectorAll<HTMLElement>('h2')) {
      const top = TOPS[heading.textContent as keyof typeof TOPS];
      heading.getBoundingClientRect = () => new DOMRect(0, top - viewport.scrollTop, 600, 30);
    }

    const at = async (scrollTop: number) => {
      await act(async () => {
        viewport.scrollTop = scrollTop;
        viewport.dispatchEvent(new Event('scroll'));
      });
      return active;
    };

    // The observer was created before the layout above: nothing was in the band then.
    expect(await at(0)).toBeNull();
    expect(await at(255)).toBeNull(); // Context at 45 to 75 px: above the band's 80 px top
    expect(await at(235)).toBe('Context'); // Context at 65 to 95 px: across the top, not past 100
    expect(await at(570)).toBe('Context'); // Design at 130 to 160 px: below the band's 120 px bottom: kept
    expect(await at(610)).toBe('Design'); // Design at 90 px
    expect(await at(450)).toBe('Design'); // back up: Context at -150, Design at 250, none in the band: kept
    expect(await at(1000)).toBe('Rollout'); // Rollout at 100 px
    expect(await at(1010)).toBe('Rollout');
  });
});
