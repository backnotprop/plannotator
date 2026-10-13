/**
 * What regresses if this fails: a heading rendered inside a question card's
 * context (no block id) is observed as a TOC section. It can never become the
 * active id (it has none), so while it is the topmost heading in view the
 * table of contents stops following the scroll.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const original = hasDom ? globalThis.IntersectionObserver : undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) globalThis.IntersectionObserver = original!;
});

describe.if(hasDom)('useActiveSection', () => {
  test('observes document headings only, never a heading inside a question context', async () => {
    const { useActiveSection } = await import('./useActiveSection');
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class {
      observe(el: Element) { observed.push(el); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;

    function Doc() {
      const ref = useRef<HTMLDivElement>(null);
      useActiveSection(ref, 2);
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
    expect(observed.map((el) => el.textContent)).toEqual(['Plan']);
  });
});
