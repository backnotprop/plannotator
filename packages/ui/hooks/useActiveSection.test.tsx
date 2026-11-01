/** Document headings, not headings in question context, drive Contents. DOM_TESTS=1. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
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

describe.if(hasDom)('useActiveSection', () => {
  test('tracks document headings only, never a heading inside a question context', async () => {
    const { useActiveSection } = await import('./useActiveSection');
    let active: string | null = null;
    function Doc() {
      const ref = useRef<HTMLDivElement>(null);
      active = useActiveSection(ref, 2);
      return (
        <div ref={ref}>
          <h2 data-block-id="block-0" data-block-type="heading">Plan</h2>
          <fieldset className="question-block" data-block-id="block-1">
            <div data-question-part="context">
              <h3 data-block-type="heading">Inside the card</h3>
            </div>
          </fieldset>
        </div>
      );
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Doc />));
    for (const heading of host.querySelectorAll('h2, h3')) {
      const rect = new DOMRect(0, heading.tagName === 'H2' ? 0 : 40, 600, 30);
      heading.getBoundingClientRect = () => rect;
      heading.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
    }
    await act(async () => {
      host!.firstElementChild!.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(active).toBe('block-0');
  });
});
