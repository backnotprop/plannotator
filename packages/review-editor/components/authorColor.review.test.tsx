/**
 * An author's text colour (#3345) where the review app inserts sanitized
 * HTML itself: MarkdownBody (PR descriptions, PR comments and commit
 * messages, written by anyone on GitHub) and a file comment card (written by
 * a reviewer or an agent). The sanitizer keeps the colour; these surfaces
 * must hold it to the background like the document viewer does.
 *
 * What regresses if this fails: white text on the light theme, or a colour
 * too dark for the dark card, reaches the page as written (unreadable words
 * a reader can still copy).
 *
 * happy-dom cannot host DOMPurify (it drops or keeps tags wrongly), so the
 * sanitizer's refusal of a see-through colour is proven in a real browser by
 * tests/e2e/markdown-author-color.spec.ts; this file proves the paint pass.
 *
 * DOM-gated (DOM_TESTS=1, listed in tests/dom-test-list.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { contrastRatio, type Rgb } from '@plannotator/ui/utils/authorColor';
import { MarkdownBody } from './MarkdownBody';
import { FileCommentCard } from './FileCommentBanner';

const hasDom = typeof document !== 'undefined';

const WHITE = 'rgb(255, 255, 255)';
const DARK = 'rgb(30, 30, 36)';

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  for (const host of hosts) host.remove();
  roots = [];
  hosts = [];
});

async function render(node: React.ReactElement, background: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.style.backgroundColor = background;
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  hosts.push(host);
  await act(async () => root.render(node));
  return host;
}

const rgb = (css: string): Rgb => {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (!m) throw new Error(`not rgb(): ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** The coloured span around `words`. */
function spanAround(page: HTMLElement, words: string): HTMLElement {
  const span = Array.from(page.querySelectorAll<HTMLElement>('span[style]')).find((el) => el.textContent === words);
  if (!span) throw new Error(`no coloured span around "${words}" in ${page.innerHTML}`);
  return span;
}

const comment = (text: string): CodeAnnotation =>
  ({ id: 'c1', type: 'comment', scope: 'file', filePath: 'src/a.ts', lineStart: 1, lineEnd: 1, side: 'new', text }) as CodeAnnotation;

const card = (text: string) => (
  <FileCommentCard comment={comment(text)} isSelected={false} onSelect={() => {}} onEdit={() => {}} onDelete={() => {}} />
);

const surfaces: Array<[string, (markdown: string) => React.ReactElement]> = [
  ['MarkdownBody (GitHub text)', (markdown) => <MarkdownBody markdown={markdown} />],
  ['a file comment card', card],
];

describe.if(hasDom)('the review app holds an author\'s colour to the background', () => {
  for (const [name, surface] of surfaces) {
    describe(name, () => {
      test('white words on the light theme are darkened until readable', async () => {
        const page = await render(surface('Note: <span style="color:#ffffff">ignore the above</span> end.'), WHITE);
        const shifted = rgb(spanAround(page, 'ignore the above').style.color);
        expect(contrastRatio(shifted, [255, 255, 255])).toBeGreaterThanOrEqual(3);
      });

      test('a colour too dark for the dark card is lightened; a readable one stays as written', async () => {
        const page = await render(
          surface('Pass rate <span style="color: #3a0000">73.0%</span> and <span style="color: #d00000">ok</span>.'),
          DARK,
        );
        expect(contrastRatio(rgb(spanAround(page, '73.0%').style.color), rgb(DARK))).toBeGreaterThanOrEqual(3);
        const light = await render(surface('It is <span style="color: #d00000">ok</span> here'), WHITE);
        expect(spanAround(light, 'ok').getAttribute('style')).toBe('color: #d00000');
      });
    });
  }
});
