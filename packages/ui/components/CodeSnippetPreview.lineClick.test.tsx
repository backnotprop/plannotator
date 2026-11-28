import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CodeSnippetPreview } from './CodeSnippetPreview';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const contents = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('CodeSnippetPreview line clicks', () => {
  test.skipIf(!hasDom)('with onLineClick a row answers its own line number', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const clicked: number[] = [];
    await mount(<CodeSnippetPreview anchorEl={anchor} contents={contents} filepath="src/a.txt" line={4} lineEnd={6} contextLines={2} onLineClick={(line) => clicked.push(line)} />);
    const row = document.querySelector<HTMLTableRowElement>('[data-snippet-line="5"]')!;
    expect(row.className).toContain('cursor-pointer');
    await act(async () => row.click());
    const edge = document.querySelector<HTMLTableRowElement>('[data-snippet-line="2"]')!;
    await act(async () => edge.click());
    expect(clicked).toEqual([5, 2]);
  });

  test.skipIf(!hasDom)('without onLineClick rows stay read-only', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    await mount(<CodeSnippetPreview anchorEl={anchor} contents={contents} filepath="src/a.txt" line={4} />);
    const row = document.querySelector<HTMLTableRowElement>('[data-snippet-line="4"]')!;
    expect(row.className).not.toContain('cursor-pointer');
    expect(row.onclick).toBeNull();
  });
});
