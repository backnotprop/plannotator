/** DOM-gated (DOM_TESTS=1, tests/dom-test-list.txt). */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RenderedMarkdown } from './RenderedMarkdown';
import { InlineImageTagsContext, type ImageResolver } from './ImageResolverContext';

const hasDom = typeof document !== 'undefined';

const A = 'https://github.com/user-attachments/assets/aaaa';
const B = 'https://github.com/user-attachments/assets/bbbb';
const ELSEWHERE = 'https://example.com/x.png';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const served = (src: string) => `${GIF}#${encodeURIComponent(src)}`;

const BADGE = 'https://badge.invalid/ci-passing.svg';
const resolveImage: ImageResolver = (src) =>
  src.startsWith('https://github.com/user-attachments/')
    ? { kind: 'src', src: served(src) }
    : src === BADGE
      ? null
      : { kind: 'unavailable', title: 'Not shown' };

const BODY = [
  '| Before | After |',
  '| --- | --- |',
  `| <img width="560" alt="Before shot" src="${A}" /> | <img width="560" height="280" alt="After shot" src="${B}"> |`,
  '',
  `<details><summary>Dark</summary>\n\n<img alt="Dark shot" src="${A}">\n\n</details>`,
  '',
  `Elsewhere: <img alt="Other host" src="${ELSEWHERE}">`,
  '',
  `Badge: <img alt="badge" src="${BADGE}">`,
].join('\n');

describe.if(hasDom)('<img> tags in text with InlineImageTagsContext (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
  });

  async function render(tags: boolean): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <InlineImageTagsContext.Provider value={tags}>
          <RenderedMarkdown markdown={BODY} resolveImage={resolveImage} />
        </InlineImageTagsContext.Provider>,
      );
    });
    return host;
  }

  test('pictures in one table row render side by side with their sizes; one under a <details> summary too; a host the resolver refuses is a chip, one it has no say on loads as written', async () => {
    const page = await render(true);
    const row = page.querySelector('tbody tr')!;
    const inRow = [...row.querySelectorAll('img')];
    expect(inRow.map((img) => img.getAttribute('data-image-src'))).toEqual([A, B]);
    expect(inRow.map((img) => img.getAttribute('src'))).toEqual([served(A), served(B)]);
    expect(inRow.map((img) => [img.getAttribute('width'), img.getAttribute('height')])).toEqual([['560', null], ['560', '280']]);
    expect(row.textContent).not.toContain('src=');

    expect(page.querySelector('img[alt="Dark shot"]')?.getAttribute('src')).toBe(served(A));

    expect(page.querySelector(`img[src="${ELSEWHERE}"]`)).toBeNull();
    expect([...page.querySelectorAll('[data-image-unavailable]')].map((chip) => chip.textContent)).toContain('Other host');
    // The resolver has no say: as written, as `![badge](…)` would load.
    expect(page.querySelector('img[alt="badge"]')?.getAttribute('src')).toBe(BADGE);
  });

  test('without the context a tag in a line stays text, as before', async () => {
    const page = await render(false);
    expect(page.querySelector('tbody tr img')).toBeNull();
    expect(page.querySelector('tbody tr')!.textContent).toContain('Before shot');
  });
});
