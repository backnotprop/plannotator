/**
 * A code file opened from a document on Windows arrives as `C:\repo\src\big.ts`.
 * The popout names it by its last segments (`src/big.ts`), as it does a POSIX
 * path; split on `/` alone, the whole drive path filled the header.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('CodeFilePopout header', () => {
  test('a Windows path shows the parent folder and file name', async () => {
    const { CodeFilePopout } = await import('./CodeFilePopout');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <CodeFilePopout open onClose={() => {}} filepath={'C:\\repo\\src\\big.ts'} contents="const x = 1;" />,
    ));
    const text = document.body.textContent ?? '';
    expect(text).toContain('src/big.ts');
    expect(text).not.toContain('C:\\repo');
  });
});
