/**
 * Focus for a PR's pane covering the Reviews list (pulls/prPaneFocus.ts), as for a covering thread. What regresses:
 *  - a PR opened over the list (a window too narrow for both) leaving focus on the hidden list, not on `‹ Reviews`;
 *  - the window shrinking into covering with focus on the list, leaving it there under the pane;
 *  - closing back to the list, or growing back out with focus lost, not landing on the PR's row;
 *  - any of it on a phone, which focuses the pane's title itself.
 *
 * The harness draws what the Reviews page draws for it (the list's row; the pane's way back while covering, its Close
 * beside the list). DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { usePrPaneFocus } = (hasDom ? await import('./prPaneFocus') : {}) as typeof import('./prPaneFocus');

/** The first match focused (App.tsx `focusFirst`, less its on-screen check: happy-dom draws no boxes). */
const focus = (selectors: readonly string[]) => {
  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      el.focus();
      return true;
    }
  }
  return false;
};

function Page({ pane, covering, phone = false }: { pane: string | null; covering: boolean; phone?: boolean }) {
  usePrPaneFocus(pane, covering, phone, focus);
  return (
    <div className="pn-inbox">
      <section className="ib-listcol ib-prlist">
        <button type="button" data-pulls-row="stk_1" aria-current={pane ? 'true' : undefined}>
          #880
        </button>
      </section>
      {pane && (
        <section className="ib-pane ib-prpane">
          <div className="ib-pr-bar">
            {covering && (
              <button type="button" data-stack-back="">
                Reviews
              </button>
            )}
            <span>#880</span>
            {!covering && (
              <button type="button" aria-label="Close">
                ×
              </button>
            )}
          </div>
          <h2 className="ib-pr-h" tabIndex={-1}>
            PR 880
          </h2>
        </section>
      )}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(props: { pane: string | null; covering: boolean; phone?: boolean }) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(<Page {...props} />));
}

const focused = (selector: string) => document.activeElement === document.querySelector(selector);

test.skipIf(!hasDom)('a PR opened over the list takes focus to ‹ Reviews; closed, focus goes back to its row', () => {
  draw({ pane: null, covering: true });
  (document.querySelector('[data-pulls-row]') as HTMLElement).focus();
  draw({ pane: 'stk_1', covering: true });
  expect(focused('[data-stack-back]')).toBe(true);
  draw({ pane: null, covering: true });
  expect(focused('[data-pulls-row="stk_1"]')).toBe(true);
});

test.skipIf(!hasDom)('shrinking into covering with focus on the list moves it to ‹ Reviews; growing out with it lost, to the row', () => {
  draw({ pane: 'stk_1', covering: false });
  (document.querySelector('[data-pulls-row]') as HTMLElement).focus();
  draw({ pane: 'stk_1', covering: true });
  expect(focused('[data-stack-back]')).toBe(true);
  // Growing out: `‹ Reviews` goes, focus with it.
  draw({ pane: 'stk_1', covering: false });
  expect(focused('[data-pulls-row="stk_1"]')).toBe(true);
});

test.skipIf(!hasDom)('beside the list, and on a phone, opening a PR leaves focus where it is', () => {
  draw({ pane: null, covering: false });
  const row = document.querySelector('[data-pulls-row]') as HTMLElement;
  row.focus();
  draw({ pane: 'stk_1', covering: false });
  expect(document.activeElement).toBe(row);
  draw({ pane: null, covering: false, phone: true });
  row.focus();
  draw({ pane: 'stk_1', covering: true, phone: true });
  expect(document.activeElement).toBe(row);
});
