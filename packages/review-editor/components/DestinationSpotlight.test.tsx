import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DestinationSpotlight } from './DestinationSpotlight';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness() {
  const targetRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={(node) => {
          targetRef.current = node;
          if (node) {
            node.getBoundingClientRect = () => ({
              x: 320,
              y: 12,
              top: 12,
              right: 378,
              bottom: 56,
              left: 320,
              width: 58,
              height: 44,
              toJSON: () => ({}),
            });
          }
        }}
      >
        GitHub
      </button>
      <DestinationSpotlight
        targetRef={targetRef}
        platformLabel="GitHub"
        mrLabel="PR"
        compactTouchLayout
        onDismiss={() => {}}
      />
    </>
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('DestinationSpotlight', () => {
  test.skipIf(!hasDom)('uses a concise visible-viewport surface on compact touch layouts', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Harness />));

    expect(document.querySelector('.pn-visible-viewport-overlay')).not.toBeNull();
    expect(document.body.textContent).toContain('Choose where reviews go');
    expect(document.body.textContent).not.toContain('double-tap');
    const gotIt = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Got it');
    expect(gotIt?.hasAttribute('data-pn-touch-target')).toBe(true);
  });
});
