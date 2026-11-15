import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFiletypeFromFileName } from '@pierre/diffs';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';
import { InlineAnnotation } from './InlineAnnotation';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const metadata: DiffAnnotationMetadata = {
  annotationId: 'suggestion-1',
  type: 'suggestion',
  text: 'Return early.',
  suggestedCode: 'return null;',
};

async function suggestionCode(filePath: string): Promise<HTMLElement | null> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <InlineAnnotation metadata={metadata} filePath={filePath} onSelect={() => {}} onEdit={() => {}} onDelete={() => {}} />,
    );
  });
  return host.querySelector<HTMLElement>('.suggestion-block-code code');
}

// A suggestion sits beside the diff of its file, so it must be coloured with the grammar the diff uses.
describe('a suggestion in the diff', () => {
  for (const [filePath, grammar] of [
    ['src/main.zig', 'zig'],
    ['lib/app.ex', 'elixir'],
    ['src/Foo.m', 'objective-c'],
    ['src/App.tsx', 'tsx'],
  ] as const) {
    test.skipIf(!hasDom)(`in ${filePath} is coloured as ${grammar}, the diff's grammar`, async () => {
      const code = await suggestionCode(filePath);
      expect(code?.className).toBe(`language-${grammar}`);
      expect(getFiletypeFromFileName(filePath)).toBe(grammar);
    });
  }

  test.skipIf(!hasDom)('in a file the diff shows plain stays plain', async () => {
    const code = await suggestionCode('notes.txt');
    expect(code?.className).toBe('');
    expect(code?.textContent).toBe('return null;');
  });
});
