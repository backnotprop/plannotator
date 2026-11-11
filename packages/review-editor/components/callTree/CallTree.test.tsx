/**
 * DOM-gated behavior of the Call tree component.
 *
 * Regressions guarded:
 *  - Dillon Mulroy's source preview (#2322) not opening on a row's file:line,
 *    or showing the new side for a removed call;
 *  - Enter commenting instead of opening (owner's decision 3, 2026-11-10), or
 *    C not commenting; a row comment not landing on its file line with the
 *    Call flow target the Paths cards attach;
 *  - arrow keys leaking to the file tree's window handler (switching files)
 *    or not moving / folding;
 *  - a folded branch without its count, Changes only keeping unchanged rows,
 *    bands on every row of a new subtree, a repeat expanded again.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { callTreeFromEntry, type CallTreeDoc, type CallTreeNode } from '@plannotator/shared/call-tree';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import { CallTree } from './CallTree';
import { createCallFlowNodeSourceLoader } from '../../hooks/useCallFlowNodeSource';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function n(key: string, label: string, line: number, children: CallTreeNode[] = [], status: CallTreeNode['status'] = 'same', file = 'src/note.ts'): CallTreeNode {
  return { key, label, status, file, line, children };
}

const doc: CallTreeDoc = callTreeFromEntry({
  entry: 'onBeforeCreate',
  tree: n('root', 'onBeforeCreate(next)', 5, [
    n('size', 'getLabelSize(shape)', 6, [
      n('measure', 'textMeasure.measureHtml(html)', 7, [
        n('rect', 'elm.getBoundingClientRect()', 8, [], 'removed', 'src/text.ts'),
        n('parley', 'parley.layout(html, opts)', 8, [
          n('inner', 'parley.shape()', 3, [], 'added', 'src/parley.ts'),
        ], 'added', 'src/text.ts'),
      ]),
    ]),
    n('theme', 'util.getTheme()', 9, [n('a', 'a()', 2, [], 'same', 'src/theme.ts'), n('b', 'b()', 3, [], 'same', 'src/theme.ts')]),
  ]),
}, 0);

const numbered = (side: string) => Array.from({ length: 12 }, (_, i) => `${side} line ${i + 1}`).join('\n');
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

function row(label: string): HTMLElement {
  const found = [...host!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.textContent?.includes(label));
  if (!found) throw new Error(`no row ${label}`);
  return found;
}

function tree(): HTMLElement {
  return host!.querySelector<HTMLElement>('[role="tree"]')!;
}

async function key(keyName: string) {
  await act(async () => {
    tree().dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('CallTree rows', () => {
  test.skipIf(!hasDom)('bands only where a call\'s own line changed; folds unchanged branches with a count', async () => {
    await mount(<CallTree doc={doc} onOpen={() => {}} />);
    expect(row('elm.getBoundingClientRect()').className).toContain('call-tree-band-removed');
    expect(row('parley.layout').className).toContain('call-tree-band-added');
    // Under a new call: a dot, not another band.
    expect(row('parley.shape()').className).not.toContain('call-tree-band');
    expect(row('parley.shape()').querySelector('.call-tree-dot-added')).not.toBeNull();
    // An unchanged branch is folded and says how many calls it holds.
    expect(row('util.getTheme()').getAttribute('aria-expanded')).toBe('false');
    expect(row('util.getTheme()').textContent).toContain('2 calls');
    // Same-file rows show only :line; a move into another file shows dir/file:line.
    expect(row('getLabelSize').querySelector('.call-tree-location')?.textContent).toBe(':6');
    expect(row('elm.getBoundingClientRect()').querySelector('.call-tree-location')?.textContent).toBe('src/text.ts:8');
  });

  test.skipIf(!hasDom)('Changes only drops unchanged branches and keeps the root', async () => {
    await mount(<CallTree doc={doc} onOpen={() => {}} />);
    const filter = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Changes only')!;
    await act(async () => filter.click());
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    const labels = [...host!.querySelectorAll('[role="treeitem"]')].map((r) => r.querySelector('.call-tree-label')?.textContent);
    expect(labels.some((label) => label?.includes('getTheme'))).toBe(false);
    expect(labels[0]).toContain('onBeforeCreate');
  });

  test.skipIf(!hasDom)('a repeated call is marked "↑ above" and not expanded again', async () => {
    const body = () => [n('x', 'x()', 30, [], 'added'), n('y', 'y()', 31)];
    const repeated = callTreeFromEntry({
      entry: 'e',
      tree: n('e', 'e()', 1, [n('s1', 'shared()', 2, body()), n('s2', 'shared()', 3, body())]),
    }, 0);
    await mount(<CallTree doc={repeated} onOpen={() => {}} />);
    const rows = [...host!.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((r) => r.textContent?.includes('shared()'));
    expect(rows.map((r) => r.textContent?.includes('↑ above'))).toEqual([false, true]);
    expect(host!.querySelectorAll('[role="treeitem"]')).toHaveLength(1 + 2 + 2);
  });

  test.skipIf(!hasDom)('agent-written words carry the pencil; analysis words do not', async () => {
    const withNotes = callTreeFromEntry({
      entry: 'e',
      tree: { ...n('e', 'e()', 1, [{ ...n('c', 'if richText is empty', 2), kind: 'branch', provenance: 'agent', notes: [{ text: 'cached per shape', provenance: 'agent' }] }]) },
    }, 0);
    await mount(<CallTree doc={withNotes} onOpen={() => {}} />);
    expect(row('if richText').querySelectorAll('.call-tree-pencil')).toHaveLength(2);
    expect(row('e()').querySelector('.call-tree-pencil')).toBeNull();
  });

  test.skipIf(!hasDom)('a caller trail shows when the root is not the entry', async () => {
    await mount(<CallTree doc={{ ...doc, trail: ['main', 'boot'] }} onOpen={() => {}} />);
    expect(host!.querySelector('.call-tree-trail')?.textContent).toBe('from main › boot');
  });
});

describe('CallTree keyboard', () => {
  test.skipIf(!hasDom)('arrows move and fold inside the tree and never reach the window', async () => {
    let leaked = 0;
    const onWindowKey = () => { leaked += 1; };
    window.addEventListener('keydown', onWindowKey);
    try {
      await mount(<CallTree doc={doc} onOpen={() => {}} />);
      expect(row('onBeforeCreate').getAttribute('aria-selected')).toBe('true');
      await key('ArrowDown');
      expect(row('getLabelSize').getAttribute('aria-selected')).toBe('true');
      // ← folds an open row, then moves to the caller.
      await key('ArrowLeft');
      expect(row('getLabelSize').getAttribute('aria-expanded')).toBe('false');
      expect(host!.textContent).not.toContain('measureHtml');
      await key('ArrowRight');
      expect(row('getLabelSize').getAttribute('aria-expanded')).toBe('true');
      await key('ArrowRight');
      expect(row('measureHtml').getAttribute('aria-selected')).toBe('true');
      await key('ArrowLeft');
      await key('ArrowLeft');
      expect(row('getLabelSize').getAttribute('aria-selected')).toBe('true');
      await key('ArrowUp');
      expect(row('onBeforeCreate').getAttribute('aria-selected')).toBe('true');
      expect(leaked).toBe(0);
      expect(tree().getAttribute('aria-activedescendant')).toBe(row('onBeforeCreate').id);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  test.skipIf(!hasDom)('Enter opens the current row\'s line; a click opens too', async () => {
    const opened: string[] = [];
    await mount(<CallTree doc={doc} onOpen={(node) => opened.push(node.key)} />);
    await key('ArrowDown');
    await key('Enter');
    expect(opened).toEqual(['size']);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
    await act(async () => row('elm.getBoundingClientRect()').click());
    expect(opened).toEqual(['size', 'rect']);
  });

  test.skipIf(!hasDom)('a row that cannot open does not open on Enter or click', async () => {
    const opened: string[] = [];
    await mount(<CallTree doc={doc} onOpen={(node) => opened.push(node.key)} canOpen={(node) => node.key !== 'root'} />);
    await key('Enter');
    await act(async () => row('onBeforeCreate').click());
    expect(opened).toEqual([]);
  });

  test.skipIf(!hasDom)('C comments on the row; the comment carries its file line and Call flow target', async () => {
    const submissions: Array<{ targets: readonly CallFlowAnnotationTarget[]; text: string }> = [];
    const opened: string[] = [];
    await mount(
      <CallTree
        doc={doc}
        onOpen={(node) => opened.push(node.key)}
        onAnnotateTargets={(targets, text) => { submissions.push({ targets: [...targets], text }); return true; }}
      />,
    );
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowDown');
    expect(row('elm.getBoundingClientRect()').getAttribute('aria-selected')).toBe('true');
    await key('c');
    const popover = document.querySelector('[data-comment-popover="true"]');
    expect(popover).not.toBeNull();
    expect(opened).toEqual([]);
    const textarea = popover!.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
      setter?.call(textarea, 'Why measure in wasm?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true }));
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.text).toBe('Why measure in wasm?');
    // A removed call lands on the old side of its own line, like a Paths card comment.
    expect(submissions[0]!.targets[0]).toMatchObject({
      filePath: 'src/text.ts', lineStart: 8, lineEnd: 8, side: 'old', entry: 'onBeforeCreate', label: 'elm.getBoundingClientRect()',
    });
    expect(submissions[0]!.targets[0]!.treePath).toBe('onBeforeCreate:0/size:0/measure:0/rect:0');
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
  });

  test.skipIf(!hasDom)('Escape goes back only when the host gave a way back', async () => {
    let backs = 0;
    await mount(<CallTree doc={doc} onOpen={() => {}} onBack={() => { backs += 1; }} />);
    await key('Escape');
    expect(backs).toBe(1);
  });
});

describe('CallTree source preview (#2322)', () => {
  test.skipIf(!hasDom)('hovering a row\'s file:line previews the old side of a removed call, after the dwell', async () => {
    const calls: string[] = [];
    const loader = createCallFlowNodeSourceLoader({
      files: [{ path: 'src/text.ts' }],
      reviewBase: 'main',
      snapshotId: 'snap-1',
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ oldContent: numbered('old'), newContent: numbered('new') }), { status: 200 });
      }) as typeof fetch,
    });
    await mount(<CallTree doc={doc} onOpen={() => {}} loadNodeSource={loader} />);
    const location = row('elm.getBoundingClientRect()').querySelector<HTMLElement>('.call-tree-location')!;
    await act(async () => {
      location.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(calls).toHaveLength(0);
    await act(async () => { await wait(250); });
    const preview = document.querySelector('[data-code-snippet-preview="src/text.ts"]');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('[data-target-line="true"]')?.textContent).toContain('old line 8');
    expect(preview!.textContent).toContain('old line 5');
    expect(preview!.textContent).not.toContain('new line');
    expect(calls[0]).toContain('snapshot=snap-1');
  });
});
