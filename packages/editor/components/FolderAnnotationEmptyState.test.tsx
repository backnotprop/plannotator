import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { FolderAnnotationEmptyState } from './FolderAnnotationEmptyState';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('folder annotation empty state', () => {
  test('preserves the incumbent desktop sidebar instruction', () => {
    const html = renderToStaticMarkup(
      <FolderAnnotationEmptyState compactTouchLayout={false} onChooseFile={() => {}} />,
    );

    expect(html).toContain('Pick a markdown or HTML file from the sidebar to begin.');
    expect(html).not.toContain('Choose a file</button>');
  });

  test.skipIf(!hasDom)('makes the hidden mobile file journey directly actionable', async () => {
    const onChooseFile = mock(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <FolderAnnotationEmptyState compactTouchLayout onChooseFile={onChooseFile} />,
      );
    });

    const choose = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Choose a file');
    expect(choose?.getAttribute('data-pn-touch-target')).toBe('true');
    await act(async () => choose?.click());
    expect(onChooseFile).toHaveBeenCalledTimes(1);
  });
});
