import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagesBrowser } from './MessagesBrowser';
import { resetStorageBackend, setStorageBackend } from '../../utils/storage';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetStorageBackend();
});

test.skipIf(typeof document === 'undefined')('reverses messages, preserves newest marker and selection, and remembers the order', async () => {
  const stored = new Map<string, string>();
  setStorageBackend({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  });
  const messages = [
    { messageId: 'new', text: 'Newest answer' },
    { messageId: 'old', text: 'Earlier answer' },
  ];
  let selected = '';
  host = document.createElement('div');
  document.body.append(host);
  const mount = async () => {
    root = createRoot(host!);
    await act(async () => root!.render(<MessagesBrowser messages={messages}
      selectedMessageId="old" onSelect={id => { selected = id; }}
      annotationCounts={new Map([['new', 2]])} />));
  };
  const rows = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('button')).filter(b => b.textContent?.includes('answer'));
  await mount();
  expect(rows().map(b => b.textContent?.includes('Newest'))).toEqual([true, false]);
  // The order control's accessible name is an intentional action label.
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Reverse message order"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  expect(rows().map(b => b.textContent?.includes('Newest'))).toEqual([false, true]);
  expect(rows()[0].textContent).not.toContain('★');
  expect(rows()[1].textContent).toContain('★');
  expect(rows()[1].querySelector('[title="2 annotations"]')).not.toBeNull();
  await act(async () => rows()[0].click());
  expect(selected).toBe('old');
  expect(messages.map(m => m.messageId)).toEqual(['new', 'old']);
  await act(async () => root!.unmount());
  root = null;
  await mount();
  expect(rows()[0].textContent).toContain('Earlier');
  await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Reverse message order"]')!.click());
  expect(rows()[0].textContent).toContain('Newest');
});
