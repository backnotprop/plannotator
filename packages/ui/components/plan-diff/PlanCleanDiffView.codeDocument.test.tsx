/**
 * The version diff of a config or data file (`codeDocument`): each chunk is
 * the file's own monospace text, so a TOML comment is not a heading and a
 * YAML list item is not a bullet, and a modified block word-diffs the raw
 * text. Without the prop the chunks parse as markdown, as before.
 *
 * DOM-gated (DOM_TESTS=1), listed in tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanCleanDiffView } from './PlanCleanDiffView';
import { computePlanDiff } from '../../utils/planDiffEngine';
import type { Annotation } from '../../types';
import { __setCodeHighlightModuleForTests } from '../../utils/codeHighlight';

/**
 * A stand-in for Shiki (`@pierre/diffs`): digits in green, every other
 * stretch grey, tokens that rebuild each line byte for byte.
 */
const NUMBER_COLOR = '#00ff00';
const fakeHighlighter = {
  getSharedHighlighter: () => Promise.resolve(undefined),
  getHighlighterIfLoaded: () => ({
    codeToTokens: (code: string) => ({
      tokens: code.split('\n').map((line) =>
        [...line.matchAll(/\d+|\D+/g)].map((m) => ({ content: m[0], color: /\d/.test(m[0]) ? NUMBER_COLOR : '#cccccc' })),
      ),
    }),
  }),
} as unknown as Parameters<typeof __setCodeHighlightModuleForTests>[0];

const hasDom = typeof document !== 'undefined';

const OLD = [
  '# Config for the notes-api service (version 1): one file per environment,',
  '# each key named after its variable (`server.port` is `NOTES_SERVER_PORT`).',
  '',
  '[server]',
  'port = 8080',
  '',
  '- not a list item',
  '',
].join('\n');
const NEW = OLD
  .replace('(version 1)', '(version 2)')
  .replace('port = 8080', 'port = 8000')
  .concat('# Metrics are scraped on their own port.\n[metrics]\n');

describe.if(hasDom)('PlanCleanDiffView with a code document (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(node: React.ReactElement): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => {
      root.render(node);
    });
    return host;
  }

  afterEach(async () => {
    __setCodeHighlightModuleForTests(undefined);
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  const headings = (el: HTMLElement) => el.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const { blocks } = computePlanDiff(OLD, NEW);

  test('Rendered: every chunk is monospace text, comments keep their #, no headings or bullets', async () => {
    const el = await render(<PlanCleanDiffView blocks={blocks} codeDocument={{ language: 'toml' }} />);
    expect(headings(el)).toHaveLength(0);
    expect(el.querySelectorAll('li, [data-list-item]')).toHaveLength(0);
    expect(el.querySelectorAll('pre[data-plan-diff-code]').length).toBeGreaterThan(0);
    // An inline code chip would be a <code> outside the chunks.
    expect([...el.querySelectorAll('code')].every((c) => c.parentElement?.matches('pre[data-plan-diff-code]'))).toBe(true);
    expect(el.textContent).toContain('# each key named after its variable (`server.port` is `NOTES_SERVER_PORT`).');
    expect(el.textContent).toContain('- not a list item');
    expect(el.textContent).toContain('# Metrics are scraped on their own port.');
  });

  test('Rendered: a modified line word-diffs its raw text, the # included', async () => {
    const el = await render(<PlanCleanDiffView blocks={blocks} codeDocument={{ language: 'toml' }} />);
    const modified = [...el.querySelectorAll('.plan-diff-modified')];
    expect(modified.map((m) => m.textContent)).toEqual(
      expect.arrayContaining([
        '# Config for the notes-api service (version 12): one file per environment,',
        'port = 80808000',
      ]),
    );
    const del = [...el.querySelectorAll('del.plan-diff-word-removed')].map((d) => d.textContent);
    const ins = [...el.querySelectorAll('ins.plan-diff-word-added')].map((d) => d.textContent);
    expect(del).toEqual(expect.arrayContaining(['1', '8080']));
    expect(ins).toEqual(expect.arrayContaining(['2', '8000']));
    expect(modified.every((m) => m.querySelector('pre[data-plan-diff-code]'))).toBe(true);
  });

  test('Rendered: a modified block past the inline limit stacks as code, never the markdown word diff', async () => {
    const long = (word: string) => `notes = "${'word '.repeat(1800)}${word}"\n`;
    const big = computePlanDiff(long('old'), long('new')).blocks;
    expect(big.some((b) => b.type === 'modified' && b.inlineTokens)).toBe(true);
    const el = await render(<PlanCleanDiffView blocks={big} codeDocument={{ language: 'toml' }} />);
    expect(el.querySelectorAll('p')).toHaveLength(0);
    expect(el.querySelectorAll('ins, del')).toHaveLength(0);
    expect(el.querySelectorAll('.plan-diff-removed pre[data-plan-diff-code]')).toHaveLength(1);
  });

  test('Classic: old above new, both as code', async () => {
    const el = await render(<PlanCleanDiffView blocks={blocks} codeDocument={{ language: 'toml' }} wordLevel={false} />);
    expect(headings(el)).toHaveLength(0);
    expect(el.querySelectorAll('ins, del')).toHaveLength(0);
    const removed = [...el.querySelectorAll('.plan-diff-removed pre[data-plan-diff-code]')].map((p) => p.textContent);
    expect(removed).toEqual(expect.arrayContaining(['port = 8080']));
  });

  const YAML_OLD = 'spec:\n  template:\n      image: registry/notes-api:1.4.2\n      value: "50"\n';
  const YAML_NEW = 'spec:\n  template:\n      image: registry/notes-api:1.5.0\n      value: "40"\n';

  test('Classic: a removed line strikes its text, not its indentation', async () => {
    const yaml = computePlanDiff(YAML_OLD, YAML_NEW).blocks;
    const el = await render(<PlanCleanDiffView blocks={yaml} codeDocument={{ language: 'yaml' }} wordLevel={false} />);
    const removed = el.querySelector<HTMLElement>('.plan-diff-removed')!;
    // The wrapper's strike would run across the indentation.
    expect(removed.className).not.toContain('line-through');
    const struck = [...removed.querySelectorAll('[data-plan-diff-struck]')].map((s) => s.textContent ?? '');
    expect(struck.length).toBeGreaterThan(0);
    expect(struck.every((t) => !/^[ \t]/.test(t))).toBe(true);
    expect(struck.join('')).toContain('image: registry/notes-api:1.4.2');
    // The indentation is still there, as plain text before the struck part.
    expect(removed.querySelector('pre code')!.textContent).toBe('      image: registry/notes-api:1.4.2\n      value: "50"');
  });

  test('Rendered: changed lines keep their colours under the word-diff marks', async () => {
    __setCodeHighlightModuleForTests(fakeHighlighter);
    const yaml = computePlanDiff(YAML_OLD, YAML_NEW).blocks;
    const el = await render(<PlanCleanDiffView blocks={yaml} codeDocument={{ language: 'yaml' }} />);
    // The grammar attaches asynchronously; the chunks re-render once it has.
    for (let i = 0; i < 20 && !el.querySelector('ins span[style]'); i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const modified = el.querySelector('.plan-diff-modified')!;
    const coloured = (selector: string) =>
      [...modified.querySelectorAll<HTMLElement>(`${selector} span[style]`)].map((s) => [s.textContent, s.getAttribute('style')]);
    expect(coloured('del.plan-diff-word-removed')).toEqual(expect.arrayContaining([['4', 'color:#00ff00'], ['50', 'color:#00ff00']]));
    expect(coloured('ins.plan-diff-word-added')).toEqual(expect.arrayContaining([['5', 'color:#00ff00'], ['40', 'color:#00ff00']]));
    // The words around the marks are coloured too, not plain.
    expect(modified.querySelector('code > span[style]')).not.toBeNull();
  });

  test('the chunks name the language for the highlighter', async () => {
    const el = await render(<PlanCleanDiffView blocks={blocks} codeDocument={{ language: 'toml' }} wordLevel={false} />);
    expect(el.querySelector('pre[data-plan-diff-code] > code.language-toml')).not.toBeNull();
  });

  test('a comment on a changed block quotes the raw lines', async () => {
    const added: Annotation[] = [];
    const el = await render(
      <PlanCleanDiffView
        blocks={blocks}
        codeDocument={{ language: 'toml' }}
        mode="redline"
        onAddAnnotation={(a) => added.push(a)}
      />,
    );
    const target = [...el.querySelectorAll<HTMLElement>('.plan-diff-modified')].find((m) => m.textContent?.includes('port ='))!;
    await act(async () => {
      target.click();
    });
    expect(added).toHaveLength(1);
    // A modified block quotes old and new as `-`/`+` lines, as it does for markdown.
    expect(added[0]!.originalText).toBe('- port = 8080\n+ port = 8000');
    expect(added[0]!.diffContext).toBe('modified');
  });

  test('without codeDocument the same diff parses as markdown (the regression this guards)', async () => {
    const el = await render(<PlanCleanDiffView blocks={blocks} />);
    expect(headings(el).length).toBeGreaterThan(0);
  });
});
