import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentActions } from './CommentActions';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('CommentActions', () => {
  test.skipIf(!hasDom)('invokes the learning explanation action when it is available', async () => {
    let explanationRequests = 0;
    host = document.createElement('div');
    document.body.appendChild(host);

    await act(async () => {
      root = createRoot(host!);
      root.render(
        <CommentActions onExplain={() => { explanationRequests += 1; }} />,
      );
    });

    const explainButton = host.querySelector<HTMLButtonElement>('[aria-label="Explain finding"]');
    expect(explainButton).not.toBeNull();

    await act(async () => explainButton?.click());
    expect(explanationRequests).toBe(1);
  });

  test.skipIf(!hasDom)('disables explanation requests while Ask AI is busy', async () => {
    let explanationRequests = 0;
    host = document.createElement('div');
    document.body.appendChild(host);

    await act(async () => {
      root = createRoot(host!);
      root.render(
        <CommentActions
          onExplain={() => { explanationRequests += 1; }}
          explainDisabled
        />,
      );
    });

    const explainButton = host.querySelector<HTMLButtonElement>('[aria-label="Explain finding"]');
    expect(explainButton?.disabled).toBe(true);

    await act(async () => explainButton?.click());
    expect(explanationRequests).toBe(0);
  });
});
