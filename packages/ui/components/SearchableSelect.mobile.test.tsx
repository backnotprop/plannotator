import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SearchableSelect } from './SearchableSelect';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

function pointerMatchMedia(coarse: boolean): typeof window.matchMedia {
  return (query: string): MediaQueryList => ({
    matches: coarse && query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
}

async function mountPicker(coarse: boolean): Promise<HTMLButtonElement> {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = pointerMatchMedia(coarse);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <SearchableSelect
        items={[{ id: 'one', label: 'One' }]}
        onSelect={() => {}}
        filterFn={(item, query) => item.label.toLowerCase().includes(query.toLowerCase())}
        renderItem={(item) => item.label}
        renderTrigger={() => <button type="button">Choose item</button>}
      />,
    );
  });
  const trigger = host.querySelector<HTMLButtonElement>('button');
  if (!trigger) throw new Error('SearchableSelect trigger did not render');
  trigger.focus();
  await act(async () => trigger.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return trigger;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  }
});

describe('SearchableSelect mobile focus policy', () => {
  test.skipIf(!hasDom)('opens passive coarse-pointer pickers without focusing the search field', async () => {
    const trigger = await mountPicker(true);
    const input = document.querySelector<HTMLInputElement>('[data-pn-mobile-editable]');

    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test.skipIf(!hasDom)('preserves immediate keyboard search on fine pointers', async () => {
    await mountPicker(false);
    const input = document.querySelector<HTMLInputElement>('[data-pn-mobile-editable]');

    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });
});
