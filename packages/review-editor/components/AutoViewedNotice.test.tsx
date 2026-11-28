import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';
import { useAutoViewedNotice } from '../hooks/useAutoViewedNotice';
import { AutoViewedNotice } from './AutoViewedNotice';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let show: (() => void) | null = null;
let clock = 0;
const realFetch = globalThis.fetch;
const before = hasDom ? configStore.get('reviewAutoViewed') : true;

function Harness({ fileKey }: { fileKey: number }) {
  const notice = useAutoViewedNotice({ blocked: false, fileKey, now: () => clock });
  show = notice.show;
  return <AutoViewedNotice notice={notice.notice} onTurnOff={notice.turnOff} />;
}

async function render(fileKey: number) {
  await act(async () => root!.render(<Harness fileKey={fileKey} />));
}

beforeEach(() => {
  const values = new Map<string, string>();
  setStorageBackend({ getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: (k) => { values.delete(k); } });
  globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  configStore.set('reviewAutoViewed', before);
  globalThis.fetch = realFetch;
  resetStorageBackend();
});

describe.if(hasDom)('auto-viewed notice, inline and once', () => {
  test('shows in the list once, survives the file change that marked it, keeps Turn off, and clears on a later file change', async () => {
    clock = 0;
    configStore.set('reviewAutoViewed', true);
    await render(1);
    await act(async () => show!());
    const line = host!.querySelector('[data-auto-viewed-notice]')!;
    expect(line.getAttribute('data-auto-viewed-notice')).toBe('intro');
    expect(document.querySelector('[data-sonner-toast]')).toBeNull();

    await render(2);
    expect(host!.querySelector('[data-auto-viewed-notice]')).not.toBeNull();
    clock += 5000;
    await render(3);
    expect(host!.querySelector('[data-auto-viewed-notice]')).toBeNull();
    await act(async () => show!());
    expect(host!.querySelector('[data-auto-viewed-notice]')).toBeNull();
  });

  test('Turn off switches the setting off and says how to turn it back on', async () => {
    configStore.set('reviewAutoViewed', true);
    await render(1);
    await act(async () => show!());
    const button = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Turn off')!;
    await act(async () => button.click());
    expect(configStore.get('reviewAutoViewed')).toBe(false);
    expect(host!.querySelector('[data-auto-viewed-notice]')!.getAttribute('data-auto-viewed-notice')).toBe('off');
  });
});
