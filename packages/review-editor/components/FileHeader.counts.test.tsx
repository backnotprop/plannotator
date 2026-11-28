/** DOM coverage for the +/− counts a file's diff header shows. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('FileHeader counts', () => {
  test('a removed `---` rule and an added `+++` line count, the file headers do not', async () => {
    const patch = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,3 @@',
      ' # Notes',
      '----',
      '+++ added',
      ' end',
      '',
    ].join('\n');
    const el = await mount(<FileHeader filePath="notes.md" patch={patch} />);
    expect(el.querySelector('[data-file-header-counts]')?.textContent).toBe('+1−1');
  });
});
