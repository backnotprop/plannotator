/**
 * The hover card's body is an issue or PR description: text anyone who can
 * write on the repo controls. No link in it may open without the card's
 * "Open · Cancel" confirm.
 *
 * Failure to catch: a link the renderer writes after the card stripped its
 * links (raw HTML lands in HtmlBlock's passive effect, after the card's layout
 * effect) keeping its `href` and `target=_blank`, so a click, a middle click,
 * a Cmd/Ctrl-click, Enter or the context menu opens it with no confirm.
 *
 * Run with DOM_TESTS=1.
 */
import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { RefCardView } from './RefHoverCard';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const TARGET: ForgeRef = { platform: 'github', host: 'github.com', owner: 'acme', repo: 'widgets', number: 12, kind: 'pull' };

const BODY = [
  'A markdown [mdlink](https://evil.example/md) here.',
  '',
  '<p>raw <a href="https://evil.example/raw" target="_blank">rawlink</a></p>',
  '',
  '<details open><summary>More</summary><a href="https://evil.example/details">detlink</a></details>',
].join('\n');

function result(body: string): ForgeRefCardResult {
  return {
    ok: true,
    fetchedAt: 0,
    data: {
      platform: 'github',
      kind: 'pull',
      repo: 'acme/widgets',
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      title: 'Ship it',
      state: 'open',
      author: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      closedAt: null,
      labels: [],
      assignees: [],
      comments: 0,
      body,
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };
}

async function mount(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<RefCardView target={TARGET} href="https://github.com/acme/widgets/pull/12" result={result(BODY)} />);
  });
  // Let any passive effect and observer callback run.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return container;
}

function link(c: HTMLElement, text: string): HTMLElement {
  const a = [...c.querySelectorAll('[data-ref-card-scroll] a')].find((el) => el.textContent === text);
  if (!a) throw new Error(`no link "${text}"`);
  return a as HTMLElement;
}

const confirmText = (c: HTMLElement) => c.querySelector('[data-ref-card-confirm]')?.textContent ?? null;

async function cancel(c: HTMLElement) {
  const btn = [...c.querySelectorAll('[data-ref-card-confirm] button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement | undefined;
  await act(async () => btn?.click());
}

describe.if(hasDom)('ref card body links', () => {
  test('raw-HTML and <details> links are drawn with no href or target, like markdown links', async () => {
    const c = await mount();
    for (const text of ['mdlink', 'rawlink', 'detlink']) {
      const a = link(c, text);
      expect(a.hasAttribute('href')).toBe(false);
      expect(a.hasAttribute('target')).toBe(false);
      expect(a.getAttribute('data-ref-card-href')).toStartWith('https://evil.example/');
    }
  });

  const gestures: [string, (a: HTMLElement) => Event][] = [
    ['a plain click', () => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })],
    ['a middle click', () => new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })],
    ['a Ctrl-click', () => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })],
    ['a Cmd-click', () => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true })],
    ['Enter', () => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })],
  ];

  for (const [name, make] of gestures) {
    test(`${name} on a raw-HTML or <details> link shows the confirm and never navigates`, async () => {
      const c = await mount();
      for (const [text, url] of [
        ['rawlink', 'https://evil.example/raw'],
        ['detlink', 'https://evil.example/details'],
      ] as const) {
        const a = link(c, text);
        // A listener on the link itself (the renderer's, or the browser's default) must not see it.
        let reachedLink = false;
        const onLink = () => {
          reachedLink = true;
        };
        a.addEventListener(make(a).type, onLink);
        const event = make(a);
        await act(async () => {
          a.dispatchEvent(event);
        });
        a.removeEventListener(event.type, onLink);
        expect(event.defaultPrevented).toBe(true);
        expect(reachedLink).toBe(false);
        expect(confirmText(c)).toContain(url);
        await cancel(c);
        expect(confirmText(c)).toBeNull();
      }
    });
  }

  test('the confirm shows a long deceptive host whole, and gives a screen reader the whole URL', async () => {
    const host = 'github.com.acme.widgets.pull.12.' + 'a'.repeat(60) + '.evil.example';
    const url = `https://${host}/acme/widgets/pull/12/${'x'.repeat(80)}/files?tab=checks`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const body = `[looks fine](${url})`;
    await act(async () => {
      root?.render(<RefCardView target={TARGET} href="https://github.com/acme/widgets/pull/12" result={result(body)} />);
    });
    const c = container;
    await act(async () => {
      link(c, 'looks fine').click();
    });
    const shown = c.querySelector('[data-ref-card-confirm-url]') as HTMLElement;
    expect(c.querySelector('[data-ref-card-confirm-host]')?.textContent).toBe(host);
    // The row never truncates the host away.
    expect(shown.querySelector('.truncate')).toBeNull();
    // The path is cut in the middle, the host is not.
    const path = c.querySelector('[data-ref-card-confirm-path]')?.textContent ?? '';
    expect(path).toContain('…');
    expect(path).toStartWith('/acme/widgets');
    expect(path).toEndWith('?tab=checks');
    // A screen reader gets the URL whole; the shortened parts are hidden from it.
    expect(shown.querySelector('.sr-only')?.textContent).toBe(url);
    expect(shown.querySelector('[aria-hidden="true"]')?.textContent).not.toBe(url);
    expect(c.querySelector('[data-ref-card-confirm] a')?.getAttribute('href')).toBe(url);
  });

  test('a link written into the body later is neutralized too, and still caught before that', async () => {
    const c = await mount();
    const body = c.querySelector('[data-ref-card-scroll] .html-block') as HTMLElement;
    const late = document.createElement('a');
    late.href = 'https://evil.example/late';
    late.target = '_blank';
    late.textContent = 'latelink';
    body.appendChild(late);
    // Before the observer ran: the capture listener still catches it.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      late.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(confirmText(c)).toContain('https://evil.example/late');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(late.hasAttribute('href')).toBe(false);
    expect(late.hasAttribute('target')).toBe(false);
  });
});
