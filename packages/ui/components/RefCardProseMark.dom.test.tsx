/**
 * The prose renderer marks the refs written in the text (click to pin, `utils/refCardClick`), and only those; with
 * click to pin on, a ref whose URL is the page itself says it opens a dialog. The card's comment count picks its form
 * again once the page's fonts load.
 *
 * What regresses: a `#12`, an `owner/repo#12`, a bare pasted PR URL or an `<https://…>` autolink left unmarked (a
 * click no longer opens its card); a labelled link, a permalink or any other link marked (a click stops following
 * it); a ref that tells a screen reader nothing; the count's form measured before the fonts loaded and never again.
 *
 * Run with DOM_TESTS=1.
 */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { InlineMarkdown } from './InlineMarkdown';
import { RefCardView } from './RefHoverCard';
import { setRefCardTransport } from '../utils/refCard';
import { REF_CARD_PROSE_ATTR, setRefCardClick } from '../utils/refCardClick';

const hasDom = typeof document !== 'undefined';
const PR = 'https://github.com/acme/widgets/pull/12';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(node));
  return host;
}

beforeEach(() => {
  if (!hasDom) return;
  setRefCardTransport(async () => null);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  setRefCardTransport(null);
  setRefCardClick(false);
});

const marked = (el: Element) => [...el.querySelectorAll('a')].filter((a) => a.hasAttribute(REF_CARD_PROSE_ATTR)).map((a) => a.textContent);

describe.if(hasDom)('the prose renderer marks refs written in the text', () => {
  const text = `See #12, other/lib#7, ${PR}, <https://github.com/acme/widgets/issues/5>, [the picker](${PR}) and https://example.com/x.`;

  test('a #12, an owner/repo#12, a bare URL and an autolink are marked; a labelled link is not', async () => {
    const el = await render(<InlineMarkdown text={text} githubRepo="acme/widgets" />);
    expect(marked(el)).toEqual(['#12', 'other/lib#7', PR, 'https://github.com/acme/widgets/issues/5', 'https://example.com/x']);
    // Click to pin off (the default): the mark alone, nothing told to a screen reader.
    expect(el.querySelector('[aria-haspopup]')).toBeNull();
  });

  test('click to pin on: a ref to the page itself says it opens a dialog; a permalink or another site does not', async () => {
    setRefCardClick(true);
    const el = await render(<InlineMarkdown text={`${text} ${PR}#discussion_r1 ${PR}/files`} githubRepo="acme/widgets" />);
    const popup = [...el.querySelectorAll('a[aria-haspopup="dialog"]')].map((a) => a.textContent);
    expect(popup).toEqual(['#12', 'other/lib#7', PR, 'https://github.com/acme/widgets/issues/5']);
    for (const a of el.querySelectorAll('a[aria-haspopup]')) expect(a.getAttribute('aria-expanded')).toBe('false');
  });
});

describe.if(hasDom)('the comment count', () => {
  const result: ForgeRefCardResult = {
    ok: true,
    fetchedAt: 0,
    data: {
      platform: 'github',
      kind: 'pull',
      repo: 'acme/widgets',
      number: 12,
      url: PR,
      title: 'Pull 12',
      state: 'open',
      author: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      closedAt: null,
      labels: [],
      assignees: [],
      comments: 3,
      body: '',
      bodyCut: false,
      lastComment: null,
      linked: [],
    },
  };

  test('picks its form again once the fonts load', async () => {
    // The words measure wide until the page's font is in (a fallback font's widths), narrow after.
    let fontsIn = false;
    let loaded: () => void = () => {};
    const ready = new Promise<void>((resolve) => (loaded = resolve));
    const proto = HTMLElement.prototype;
    const offset = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
    const client = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    const fonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => (fontsIn ? 80 : 400) });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    try {
      const el = await render(<RefCardView target={{ platform: 'github', host: 'github.com', owner: 'acme', repo: 'widgets', number: 12, kind: 'pull' }} href={PR} result={result} />);
      const form = () => el.querySelector('[data-ref-card-count]')?.getAttribute('data-ref-card-count-form');
      expect(form()).toBe('short');
      fontsIn = true;
      await act(async () => {
        loaded();
        await ready;
      });
      expect(form()).toBe('full');
    } finally {
      if (offset) Object.defineProperty(proto, 'offsetWidth', offset);
      else delete (proto as { offsetWidth?: number }).offsetWidth;
      if (client) Object.defineProperty(proto, 'clientWidth', client);
      else delete (proto as { clientWidth?: number }).clientWidth;
      if (fonts) Object.defineProperty(document, 'fonts', fonts);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });
});
