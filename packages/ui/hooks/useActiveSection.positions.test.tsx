/**
 * Contents must recover after a scroll skips headings and after another document
 * replaces them with the same count and ids. DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const TOPS = { Overview: 0, Context: 300, Design: 700, Rollout: 1100, Risks: 1500 };

/** Let the hook's coalesced scroll or mutation callback run. */
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

describe.if(hasDom)('useActiveSection at fixed scroll positions (plan review)', () => {
  test('follows the reading line after large jumps, reverse scrolling and same-count replacement', async () => {
    const { useActiveSection } = await import('./useActiveSection');
    let active: string | null = 'unset';
    let viewportEl: HTMLDivElement | null = null;

    function Plan({ documentKey = 'a', spacing = 1 }: { documentKey?: string; spacing?: number }) {
      const planAreaRef = useRef<HTMLDivElement>(null);
      const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
      active = useActiveSection(planAreaRef, Object.keys(TOPS).length, viewport);
      return (
        <div
          ref={(el) => {
            viewportEl = el;
            if (el) el.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
            if (el && el !== viewport) setViewport(el);
          }}
        >
          <div ref={planAreaRef}>
            <article key={documentKey}>
              {Object.entries(TOPS).map(([name, top]) => (
                <h2
                  key={name}
                  data-block-id={name}
                  data-block-type="heading"
                  ref={(el) => {
                    if (!el) return;
                    const rect = () => new DOMRect(0, top * spacing - (viewportEl?.scrollTop ?? 0), 600, 30);
                    el.getBoundingClientRect = rect;
                    el.getClientRects = () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null });
                  }}
                >
                  {documentKey}: {name}
                </h2>
              ))}
            </article>
          </div>
        </div>
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Plan />));
    const viewport = viewportEl!;
    const at = async (scrollTop: number) => {
      await act(async () => {
        viewport.scrollTop = scrollTop;
        viewport.dispatchEvent(new Event('scroll'));
        await nextFrame();
      });
      return active;
    };

    expect(await at(0)).toBe('Overview');
    expect(await at(255)).toBe('Context');
    expect(await at(235)).toBe('Context');
    expect(await at(570)).toBe('Context');
    expect(await at(610)).toBe('Context'); // Design has not yet reached the 80px reading line.
    expect(await at(450)).toBe('Context');
    expect(await at(1010)).toBe('Design');
    expect(await at(1460)).toBe('Risks'); // Jumped over Rollout without intersecting it.
    expect(await at(650)).toBe('Design'); // Reverse jump also selects current geometry.
    expect(await at(0)).toBe('Overview');

    // No scroll and no heading-count change: replacement itself must refresh.
    await act(async () => root!.render(<Plan documentKey="b" spacing={0.2} />));
    expect(await at(255)).toBe('Risks');
    await act(async () => root!.render(<Plan documentKey="c" />));
    await act(async () => { await nextFrame(); });
    expect(active).toBe('Context');
    expect(await at(1010)).toBe('Design');

    // Removing the document must not leave its last section highlighted.
    await act(async () => {
      viewport.querySelector('article')!.replaceChildren();
      await nextFrame();
    });
    expect(active).toBeNull();
  });
});
