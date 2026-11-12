import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { markInboxPage } from './pageMarks';

const hasDom = typeof document !== 'undefined';
const { DecisionPill } = (hasDom ? await import('./decisions/entry') : {}) as typeof import('./decisions/entry');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
});

function draw(node: React.ReactNode) {
  if (!root) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
  }
  act(() => root!.render(node));
}

describe.skipIf(!hasDom)('the Inbox window\'s page marks', () => {
  test('<html> and <body> carry data-pn-inbox while any .pn-inbox is in the page: the tour\'s layer going leaves the window\'s', () => {
    const page = () => [document.documentElement.hasAttribute('data-pn-inbox'), document.body.hasAttribute('data-pn-inbox')];
    draw(
      <>
        <div ref={markInboxPage} className="pn-inbox" />
        <div ref={markInboxPage} className="pn-inbox ib-tour-layer" />
      </>,
    );
    expect(page()).toEqual([true, true]);
    draw(<div ref={markInboxPage} className="pn-inbox" />);
    expect(page()).toEqual([true, true]);
    draw(null);
    expect(page()).toEqual([false, false]);
  });

  test('the decision pill marks the .pn-inbox it is in, and the mark goes with it', () => {
    const inbox = () => document.querySelector('.pn-inbox')!;
    draw(
      <div className="pn-inbox">
        <DecisionPill left={3} onResume={() => {}} />
      </div>,
    );
    expect(document.querySelector('.ib-dm-pill')).not.toBeNull();
    expect(inbox().hasAttribute('data-ib-dm-pill')).toBe(true);
    draw(<div className="pn-inbox" />);
    expect(inbox().hasAttribute('data-ib-dm-pill')).toBe(false);
  });
});
