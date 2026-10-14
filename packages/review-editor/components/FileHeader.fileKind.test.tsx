/** DOM coverage for the flask a test file's diff header carries. */
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

describe.if(hasDom)('FileHeader file kind', () => {
  const patch = '@@ -1 +1 @@\n-a\n+b\n';

  test('a test file shows the flask, named for screen readers', async () => {
    const el = await mount(<FileHeader filePath="src/a.test.ts" patch={patch} isTest />);
    const flask = el.querySelector('[data-file-kind-icon="test"]');
    expect(flask).not.toBeNull();
    expect(flask!.getAttribute('aria-label')).toBe('Test file');
  });

  test('other files show no kind icon', async () => {
    const el = await mount(<FileHeader filePath="src/a.ts" patch={patch} />);
    expect(el.querySelector('[data-file-kind-icon]')).toBeNull();
  });
});
