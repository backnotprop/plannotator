import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffTypePicker } from './DiffTypePicker';

const hasDom = typeof document !== 'undefined';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

const OPTIONS = [
  { id: 'since-base', label: 'All changes since origin/main' },
  { id: 'uncommitted', label: 'Uncommitted changes' },
];

describe.if(hasDom)('DiffTypePicker since-base label (DOM)', () => {
  test('renders the since-base label from the live active base', async () => {
    const el = await mount(
      <DiffTypePicker
        options={OPTIONS}
        activeDiffType="since-base"
        onSelect={() => {}}
        hasBasePicker
        activeBase="feature/part-1"
      />,
    );
    expect(el.textContent).toContain('All changes since feature/part-1');
    expect(el.textContent).not.toContain('origin/main');
  });

  test('shortens a SHA base for display', async () => {
    const el = await mount(
      <DiffTypePicker
        options={OPTIONS}
        activeDiffType="since-base"
        onSelect={() => {}}
        hasBasePicker
        activeBase="4f2a9c1d4f2a9c1d4f2a9c1d4f2a9c1d4f2a9c1d"
      />,
    );
    expect(el.textContent).toContain('All changes since 4f2a9c1');
  });

  test('falls back to the baked label without a base picker or live base', async () => {
    const el = await mount(
      <DiffTypePicker
        options={OPTIONS}
        activeDiffType="since-base"
        onSelect={() => {}}
        hasBasePicker={false}
      />,
    );
    expect(el.textContent).toContain('All changes since origin/main');
  });
});
