import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { OpenInAppButton } from './OpenInAppButton';
import { AppIcon } from './icons/AppIcon';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let host: HTMLElement | null = null;
let root: Root | null = null;
let posts: Array<Record<string, unknown>> = [];

const JETBRAINS = [
  ['intellij-idea', 'IntelliJ IDEA', 'jetbrains-ij'],
  ['webstorm', 'WebStorm', 'jetbrains-ws'],
  ['pycharm', 'PyCharm', 'jetbrains-pc'],
  ['goland', 'GoLand', 'jetbrains-go'],
  ['rider', 'Rider', 'jetbrains-rd'],
  ['phpstorm', 'PhpStorm', 'jetbrains-ps'],
  ['rubymine', 'RubyMine', 'jetbrains-rm'],
  ['clion', 'CLion', 'jetbrains-cl'],
  ['rustrover', 'RustRover', 'jetbrains-rr'],
] as const;

async function mount(node: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function primary(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('button[aria-label="Open in WebStorm"]');
  if (!button) throw new Error('Expected the WebStorm open-in button');
  return button;
}

describe('OpenInAppButton line', () => {
  beforeEach(() => {
    posts = [];
    setStorageBackend({ getItem: () => 'webstorm', setItem: () => {}, removeItem: () => {} });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (url: string, init?: RequestInit) => {
        if (url === '/api/open-in' && init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({ ok: true });
        }
        return Response.json({
          available: true,
          apps: [
            { id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' },
            { id: 'webstorm', label: 'WebStorm', kind: 'editor', icon: 'jetbrains-ws' },
          ],
        });
      },
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch });
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('a line function is read at the click and sent with the launch', async () => {
    let picked: number | undefined = 3;
    await mount(<OpenInAppButton filePath="/repo/src/a.ts" line={() => picked} />);
    picked = 57; // the person picked another comment after the render
    await act(async () => primary().click());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ filePath: '/repo/src/a.ts', appId: 'webstorm', line: 57 });
  });

  test.skipIf(!hasDom)('no meaningful line: no line in the body', async () => {
    await mount(
      <div>
        <OpenInAppButton filePath="/repo/src/a.ts" line={() => undefined} />
        <OpenInAppButton filePath="/repo/src/b.ts" line={0} />
      </div>,
    );
    const buttons = host!.querySelectorAll<HTMLButtonElement>('button[aria-label="Open in WebStorm"]');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    expect(posts.map((body) => body.filePath)).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    for (const body of posts) expect('line' in body).toBe(false);
  });
});

describe('JetBrains marks', () => {
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  test.skipIf(!hasDom)('each of the nine IDEs draws its own mark, and none is an image of a logo', async () => {
    await mount(
      <div>
        {JETBRAINS.map(([id, , icon]) => (
          <span key={id} data-id={id}><AppIcon id={icon} /></span>
        ))}
      </div>,
    );
    const marks = JETBRAINS.map(([id]) => host!.querySelector(`[data-id="${id}"] svg`)?.getAttribute('data-app-mark'));
    expect(marks).toEqual(['IJ', 'WS', 'PC', 'GO', 'RD', 'PS', 'RM', 'CL', 'RR']);
    expect(host!.querySelectorAll('img')).toHaveLength(0);
  });
});
