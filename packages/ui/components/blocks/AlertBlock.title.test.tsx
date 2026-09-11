/**
 * AlertBlock title line: a bold-only first body line (optionally led by one
 * emoji, optionally trailed by `<!-- icon: name -->`) renders as the alert's
 * title on the icon row; the emoji takes the icon slot; the comment never
 * renders; the body is indented under the title. An alert with no title line
 * renders exactly as before (the control cases pin that DOM shape).
 *
 * Requires DOM (happy-dom) — runs under bun test (preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AlertBlock, resetAlertIconRenderer } from './AlertBlock';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(() => {
  resetAlertIconRenderer();
  if (root) { act(() => root!.unmount()); root = null; }
  if (hasDom) document.body.innerHTML = '';
});

async function render(kind: 'note' | 'tip' | 'warning' | 'caution' | 'important', body: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<AlertBlock blockId="b1" kind={kind} body={body} />);
  });
  return host.querySelector<HTMLElement>('[data-block-type="alert"]')!;
}

const titleRow = (el: HTMLElement) => el.querySelector<HTMLElement>('.alert-title')!;
const srOnly = (el: HTMLElement) => el.querySelector<HTMLElement>('.alert-title .sr-only')?.textContent ?? null;
const paragraphs = (el: HTMLElement) => Array.from(el.querySelectorAll('p')).map((p) => p.textContent);

describe('AlertBlock title line', () => {
  test.skipIf(!hasDom)('control: a plain body keeps the type word, the type icon, no indent wrapper', async () => {
    const el = await render('caution', 'ML auto-detection has no protobuf model.');
    expect(titleRow(el).textContent).toBe('Caution');
    expect(titleRow(el).querySelector('svg')).not.toBeNull();
    expect(srOnly(el)).toBeNull();
    expect(el.querySelector('.alert-body')).toBeNull();
    expect(paragraphs(el)).toEqual(['ML auto-detection has no protobuf model.']);
  });

  test.skipIf(!hasDom)('control: a bold line followed directly by body is not a title', async () => {
    const el = await render('note', '**Bold start**\nthen more');
    expect(titleRow(el).textContent).toBe('Note');
    expect(paragraphs(el)).toEqual(['Bold start\nthen more']);
  });

  test.skipIf(!hasDom)('B: a bold-only first line becomes the title in place of the type word', async () => {
    const el = await render('important', '**Read before you deploy**\n\nThe env still names D1.');
    // Visible text is the title alone; the accessible name keeps the type word
    // through a visually hidden span (an aria-label on the generic div is
    // prohibited by ARIA and dropped by WebKit, so VoiceOver lost the type word).
    expect(titleRow(el).textContent).toBe('Important: Read before you deploy');
    expect(srOnly(el)).toBe('Important: ');
    expect(titleRow(el).querySelector('svg')).not.toBeNull(); // type icon stays
    expect(paragraphs(el)).toEqual(['The env still names D1.']); // no bold paragraph any more
    expect(el.querySelector('.alert-body')?.className).toContain('pl-6');
  });

  test.skipIf(!hasDom)('C: an emoji takes the icon slot and the type SVG is gone', async () => {
    const el = await render('tip', '🧭 **Browser quirks**\n\nThere are caret bugs.');
    const row = titleRow(el);
    expect(row.querySelector('svg')).toBeNull();
    expect(row.querySelector('.alert-emoji')?.textContent).toBe('🧭');
    expect(row.querySelector('.alert-emoji')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.textContent).toBe('🧭Tip: Browser quirks');
    expect(srOnly(el)).toBe('Tip: ');
    expect(paragraphs(el)).toEqual(['There are caret bugs.']);
  });

  test.skipIf(!hasDom)('D: an icon comment is stripped and, with no renderer, the type icon stays', async () => {
    const el = await render('tip', '**Browser quirks** <!-- icon: compass -->\n\nThe sentence.');
    expect(el.textContent).not.toContain('icon:');
    expect(el.textContent).not.toContain('<!--');
    expect(titleRow(el).querySelector('svg')).not.toBeNull();
    expect(titleRow(el).textContent).toBe('Tip: Browser quirks');
    expect(paragraphs(el)).toEqual(['The sentence.']);
  });

  test.skipIf(!hasDom)('E: an emoji alone keeps the type word as the title', async () => {
    const el = await render('warning', '🚧\n\ntot.page is bound to the old D1.');
    expect(titleRow(el).querySelector('.alert-emoji')?.textContent).toBe('🚧');
    expect(titleRow(el).textContent).toBe('🚧Warning');
    expect(srOnly(el)).toBeNull();
    expect(paragraphs(el)).toEqual(['tot.page is bound to the old D1.']);
  });

  test.skipIf(!hasDom)('a title line with no body renders no body wrapper', async () => {
    const el = await render('note', '**Just a title**');
    expect(titleRow(el).textContent).toBe('Note: Just a title');
    expect(el.querySelector('.alert-body')).toBeNull();
    expect(paragraphs(el)).toEqual([]);
  });
});
