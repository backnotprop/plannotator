/**
 * The line a local code review shows once its agent is gone and its server
 * is quitting (ReviewEndedBar).
 *
 * What regresses if this fails: the person cannot take their comments
 * elsewhere (Copy feedback missing, or copying something other than what
 * Send would have sent), or a review with no comments claims some were saved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewEndedBar } from './ReviewEndedBar';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
const hosts: HTMLElement[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const host of hosts.splice(0)) host.remove();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return document.querySelector('[data-review-ended]') as HTMLElement;
}

describe('ReviewEndedBar', () => {
  test.skipIf(!hasDom)('with comments: Copy feedback copies what Send would have sent', async () => {
    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    try {
      const bar = await render(<ReviewEndedBar commentCount={2} copyText={() => '## app.ts\nWhy 2?'} />);
      expect(bar.getAttribute('role')).toBe('status');
      const copy = bar.querySelector('button')!;
      await act(async () => {
        copy.click();
        await Promise.resolve();
      });
      expect(written).toEqual(['## app.ts\nWhy 2?']);
      expect(copy.textContent).toBe('Copied');
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test.skipIf(!hasDom)('with no comments: no Copy and no claim that comments were saved', async () => {
    const withComments = await render(<ReviewEndedBar commentCount={1} copyText={() => 'x'} />);
    const savedLine = withComments.textContent!;
    await act(async () => root?.unmount());
    root = null;
    const bar = await render(<ReviewEndedBar commentCount={0} copyText={() => ''} />);
    expect(bar.querySelector('button')).toBeNull();
    expect(savedLine.startsWith(bar.textContent!)).toBe(true);
    expect(bar.textContent!.length).toBeLessThan(savedLine.length);
  });
});
