import { afterEach, describe, expect, test } from 'bun:test';
import type { SemanticTarget } from './blockTargeting';

const hasDom = typeof document !== 'undefined';
const navigationModule = hasDom ? await import('./vimNavigation') : null;
const targetingModule = hasDom ? await import('./blockTargeting') : null;

function navigation() {
  if (!navigationModule) throw new Error('DOM test environment is not registered');
  return navigationModule;
}

function targeting() {
  if (!targetingModule) throw new Error('DOM test environment is not registered');
  return targetingModule;
}

function createDocumentFixture(): HTMLElement {
  const container = document.createElement('article');
  container.innerHTML = [
    '<li data-block-id="intro"><span class="select-none">1.</span>',
    '<div>Alpha <strong>bravo</strong> 👩🏽‍💻.</div></li>',
    '<div data-block-id="matrix"><table>',
    '<thead><tr><th>A1</th><th>A2</th></tr></thead>',
    '<tbody><tr><td>B1</td><td>B2</td></tr><tr><td>C1</td><td>C2</td></tr></tbody>',
    '</table></div>',
    '<div data-block-id="code"><pre><code class="pn-code">const answer = 42;</code></pre></div>',
    '<p data-block-id="outro">Charlie delta</p>',
  ].join('');
  document.body.appendChild(container);
  return container;
}

function targetByKey(
  targets: readonly SemanticTarget[],
  key: string,
) {
  const target = targets.find((candidate) => candidate.key === key);
  if (!target) throw new Error(`Missing Pinpoint target ${key}`);
  return target;
}

afterEach(() => {
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

describe.if(hasDom)('Vim text navigation', () => {
  test('uses durable block-relative offsets across highlight DOM mutations', () => {
    const { resolveTextPosition, serializeTextPosition } = navigation();
    const container = createDocumentFixture();
    const original = resolveTextPosition(container, { blockId: 'intro', textOffset: 8 });
    expect(original?.node.data).toBe('bravo');
    expect(original?.offset).toBe(2);

    const intro = container.querySelector<HTMLElement>('[data-block-id="intro"]');
    if (!intro) throw new Error('Missing intro block');
    intro.innerHTML = [
      '<span class="select-none">1.</span>',
      '<div>Alpha <mark>bravo</mark> 👩🏽‍💻.</div>',
    ].join('');

    const restored = resolveTextPosition(container, { blockId: 'intro', textOffset: 8 });
    expect(restored?.node.data).toBe('bravo');
    expect(restored?.offset).toBe(2);
    expect(restored && serializeTextPosition(container, restored.node, restored.offset)).toEqual({
      blockId: 'intro',
      textOffset: 8,
    });
  });

  test('serializes an element endpoint after its final child as the text end', () => {
    const { serializeTextPosition } = navigation();
    const container = createDocumentFixture();
    const intro = container.querySelector<HTMLElement>('[data-block-id="intro"] > div');
    if (!intro) throw new Error('Missing intro content');

    expect(serializeTextPosition(
      container,
      intro,
      intro.childNodes.length,
    )).toEqual({
      blockId: 'intro',
      textOffset: 'Alpha bravo 👩🏽‍💻.'.length,
    });
  });

  test('moves by words, grapheme clusters, blocks, and document bounds', () => {
    const { moveTextPosition } = navigation();
    const container = createDocumentFixture();

    expect(moveTextPosition(container, { blockId: 'intro', textOffset: 0 }, 'word-forward'))
      .toEqual({ blockId: 'intro', textOffset: 'Alpha '.length });
    expect(moveTextPosition(
      container,
      { blockId: 'intro', textOffset: 'Alpha bravo '.length },
      'right',
    )).toEqual({
      blockId: 'intro',
      textOffset: 'Alpha bravo 👩🏽‍💻'.length,
    });
    expect(moveTextPosition(container, { blockId: 'intro', textOffset: 0 }, 'block-forward'))
      .toEqual({ blockId: 'matrix', textOffset: 0 });
    expect(moveTextPosition(container, { blockId: 'matrix', textOffset: 0 }, 'document-end'))
      .toEqual({ blockId: 'outro', textOffset: 'Charlie delta'.length });
  });

  test('creates forward ranges even after swapping selection ends', () => {
    const { createRangeBetweenTextPositions } = navigation();
    const container = createDocumentFixture();
    const range = createRangeBetweenTextPositions(
      container,
      { blockId: 'outro', textOffset: 'Charlie'.length },
      { blockId: 'intro', textOffset: 'Alpha '.length },
    );

    expect(range?.toString()).toContain('bravo');
    expect(range?.toString()).toContain('Charlie');
    expect(range?.collapsed).toBe(false);
  });
});

describe.if(hasDom)('canonical semantic target graph', () => {
  test('enumerates semantic targets without list markers or toolbar text', () => {
    const { buildSemanticTargetGraph } = targeting();
    const container = createDocumentFixture();
    const targets = buildSemanticTargetGraph(container).targets;

    expect(targetByKey(targets, 'intro:block').element.textContent).toContain('Alpha');
    expect(targetByKey(targets, 'intro:block').element.textContent).not.toContain('1.');
    expect(targetByKey(targets, 'intro:inline:0').label).toContain('bold');
    expect(targetByKey(targets, 'matrix:table').kind).toBe('table');
    expect(targetByKey(targets, 'matrix:cell:2:1').element.textContent).toBe('C2');
    expect(targetByKey(targets, 'code:code').kind).toBe('code');
  });

  test('uses hierarchy refinement with explicit sibling and block motions', () => {
    const { buildSemanticTargetGraph, moveSemanticTarget } = targeting();
    const container = createDocumentFixture();
    const graph = buildSemanticTargetGraph(container);
    const targets = graph.targets;
    const intro = targetByKey(targets, 'intro:block');
    const inline = moveSemanticTarget(graph, intro, 'child');
    expect(inline.key).toBe('intro:inline:0');
    expect(moveSemanticTarget(graph, inline, 'parent').key).toBe('intro:block');

    const table = targetByKey(targets, 'matrix:table');
    const row = moveSemanticTarget(graph, table, 'child');
    const a1 = moveSemanticTarget(graph, row, 'child');
    expect(row.key).toBe('matrix:row:0');
    expect(a1.key).toBe('matrix:cell:0:0');
    expect(moveSemanticTarget(graph, a1, 'next-sibling').key).toBe('matrix:cell:0:1');
    expect(moveSemanticTarget(graph, row, 'next-sibling').key).toBe('matrix:row:1');
    expect(moveSemanticTarget(graph, a1, 'next-block').key).toBe('code:code');
    expect(moveSemanticTarget(
      graph,
      targetByKey(targets, 'matrix:cell:1:1'),
      'previous-block',
    ).key).toBe('intro:block');
    expect(moveSemanticTarget(graph, a1, 'parent').key).toBe('matrix:row:0');
    expect(moveSemanticTarget(graph, row, 'parent').key).toBe('matrix:table');
  });

  test('j/k and gg/G traverse top-level semantic targets', () => {
    const { buildSemanticTargetGraph, moveSemanticTarget } = targeting();
    const container = createDocumentFixture();
    const graph = buildSemanticTargetGraph(container);
    const targets = graph.targets;
    const intro = targetByKey(targets, 'intro:block');

    expect(moveSemanticTarget(graph, intro, 'next-block').key).toBe('matrix:table');
    expect(moveSemanticTarget(graph, intro, 'last-block').key).toBe('outro:block');
    expect(moveSemanticTarget(
      graph,
      targetByKey(targets, 'outro:block'),
      'first-block',
    ).key).toBe('intro:block');
  });

  test('pointer hit-testing resolves nodes from the keyboard navigation graph', () => {
    const {
      buildSemanticTargetGraph,
      createSemanticTargetRange,
      resolveSemanticTargetAtPoint,
    } = targeting();
    const container = createDocumentFixture();
    const graph = buildSemanticTargetGraph(container);
    const strong = container.querySelector<HTMLElement>('strong');
    const intro = container.querySelector<HTMLElement>('[data-block-id="intro"]');
    if (!strong || !intro) throw new Error('Missing semantic fixture nodes');

    const inlineTarget = resolveSemanticTargetAtPoint(graph, strong);
    expect(inlineTarget?.key).toBe('intro:inline:0');
    expect(resolveSemanticTargetAtPoint(graph, intro)?.key).toBe('intro:block');
    expect(inlineTarget).toBe(graph.byKey.get('intro:inline:0'));
    expect(inlineTarget && createSemanticTargetRange(inlineTarget)?.toString())
      .toBe('bravo');
  });

  test('preserves nested inline hierarchy while exposing top-level inline siblings', () => {
    const { buildSemanticTargetGraph, moveSemanticTarget } = targeting();
    const container = createDocumentFixture();
    const intro = container.querySelector<HTMLElement>('[data-block-id="intro"] > div');
    if (!intro) throw new Error('Missing intro content');
    intro.innerHTML = '<strong>outer <em>inner</em></strong><code>next</code>';

    const graph = buildSemanticTargetGraph(container);
    const block = targetByKey(graph.targets, 'intro:block');
    const strong = moveSemanticTarget(graph, block, 'child');
    const nested = moveSemanticTarget(graph, strong, 'child');
    const sibling = moveSemanticTarget(graph, strong, 'next-sibling');

    expect(strong.element.tagName).toBe('STRONG');
    expect(nested.element.tagName).toBe('EM');
    expect(sibling.element.tagName).toBe('CODE');
  });

  test('resolves semantic bounds to the intended side of adjacent table cells', () => {
    const { buildSemanticTargetGraph } = targeting();
    const {
      createRangeBetweenTextPositions,
      getTextElementBounds,
    } = navigation();
    const container = createDocumentFixture();
    const graph = buildSemanticTargetGraph(container);
    const cell = targetByKey(graph.targets, 'matrix:cell:1:1');
    const bounds = getTextElementBounds(container, cell.element);
    if (!bounds) throw new Error('Missing table-cell text bounds');

    expect(createRangeBetweenTextPositions(container, bounds.start, bounds.end)?.toString())
      .toBe('B2');
  });
});
