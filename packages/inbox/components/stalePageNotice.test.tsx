/**
 * "Inbox updated to X · Reload" (StalePageNotice.tsx) at a thread's top on a phone: its × hands focus to the thread's
 * title, which is the pane's bar h2, outside the body the notice sits in.
 *
 * What regresses: focus after the × falling to the page (or the list) because the title is looked for in the body.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StalePageNotice } from './StalePageNotice';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)("the × at a thread's top moves focus to the thread's title in its bar", () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <section className="ib-pane">
        <div className="ib-phead">
          <h2 className="ib-phsubj ib-subject" tabIndex={-1}>
            The title
          </h2>
        </div>
        <div className="ib-pbody">
          <StalePageNotice version="1.2.3" busy={false} onReload={() => {}} onDismiss={() => {}} />
        </div>
      </section>,
    ),
  );
  const x = host.querySelector<HTMLElement>('.ib-stale-x')!;
  x.focus();
  act(() => x.click());
  expect(document.activeElement).toBe(host.querySelector('h2.ib-subject'));
});
