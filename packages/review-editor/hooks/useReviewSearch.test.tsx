import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  shouldHandleReviewSearchShortcut,
  useReviewSearch,
  type UseReviewSearchResult,
} from './useReviewSearch';

const hasDom = typeof document !== 'undefined';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseReviewSearchResult | null = null;

function Harness() {
  const search = useReviewSearch({
    files: [],
    activeFilePath: null,
  });
  latest = search;

  return (
    <input
      ref={search.searchInputRef}
      value={search.searchQuery}
      onChange={event => search.handleSearchInputChange(event.target.value)}
    />
  );
}

async function mountHarness(): Promise<HTMLInputElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(<Harness />);
  });

  const input = host.querySelector('input');
  if (!input) throw new Error('search input did not render');
  return input;
}

async function openSearch(): Promise<void> {
  await act(async () => {
    latest!.openSearch();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

function fakeElement(tagName: string, isContentEditable = false): HTMLElement {
  return { tagName, isContentEditable } as HTMLElement;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  host = null;
  root = null;
  latest = null;
});

describe('useReviewSearch', () => {
  test('handles shortcuts outside editable controls and inside the review search input', () => {
    const searchInput = fakeElement('INPUT') as HTMLInputElement;

    expect(shouldHandleReviewSearchShortcut(searchInput, searchInput)).toBe(true);
    expect(shouldHandleReviewSearchShortcut(fakeElement('INPUT'), searchInput)).toBe(false);
    expect(shouldHandleReviewSearchShortcut(fakeElement('TEXTAREA'), searchInput)).toBe(false);
    expect(shouldHandleReviewSearchShortcut(fakeElement('DIV', true), searchInput)).toBe(false);
    expect(shouldHandleReviewSearchShortcut(fakeElement('DIV'), searchInput)).toBe(true);
  });

  test.skipIf(!hasDom)('selects the existing query whenever search is opened again', async () => {
    const input = await mountHarness();

    await act(async () => {
      latest!.handleSearchInputChange('firstFunction');
    });

    input.blur();
    input.setSelectionRange(input.value.length, input.value.length);
    await openSearch();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    input.setSelectionRange(input.value.length, input.value.length);
    await openSearch();

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
