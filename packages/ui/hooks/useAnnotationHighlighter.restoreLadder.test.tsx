import { describe, expect, test } from 'bun:test';
import React, { useRef, useImperativeHandle, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// Same lazy-import dance as useAnnotationHighlighter.test.tsx: the hook pulls
// in a UMD bundle that reads `window` at module-eval time.
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
const parser = hasDom ? await import('../utils/parser') : null;
const blockRenderer = hasDom ? await import('../components/BlockRenderer') : null;

/**
 * The document, as markdown. The harness renders it with the app's own parser
 * and BlockRenderer, so the DOM under test is the DOM the app produces — the
 * point of the whole exercise is that restore agrees with the real renderer,
 * and a hand-written approximation of it here would be the same mistake one
 * level up.
 */
const DOCUMENT = [
  '**Install** now',
  '',
  'Setup `bun`',
  '',
  '[Deployment](./s.md) guide',
  '',
  'Part 1 --- end',
  '',
  'Plain unmarked sentence',
  '',
  '| 영역 | 변경 |',
  '| --- | --- |',
  '| config 표면 분기 | `config.ts` — `ENABLED_SURFACES=mcp` 파싱, `JIRA_*` 요구를 Slack 활성 시로 한정 |',
  '',
  '- `tests/config.test.ts` — `ENABLED_SURFACES=mcp`가 Slack 토큰 없이 config 로드 성공',
  '',
  '1. first step',
  '2. second step',
  // CommonMark renumbers a run, so this renders as "3." — the numeral the
  // reader sees is nowhere in the source, and the source's "5." is nowhere in
  // the DOM. Only treating the numeral as chrome reconciles the two.
  '5. WP1~WP7 구현 → 기존 서버에 배포하여 **동작 불변 확인**',
].join('\n');

const Harness = forwardRef<{ apply: (a: Annotation[]) => void }, {}>((_props, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode: 'comment',
  });
  useImperativeHandle(ref, () => ({ apply: hook.applyAnnotations }), [hook.applyAnnotations]);

  const BlockRenderer = blockRenderer!.BlockRenderer;
  const { parseMarkdownToBlocks, groupBlocks, computeListIndices } = parser!;

  // Exactly Viewer's own render path, list grouping included — an ordered item
  // gets its numeral from the group, which is the context a quoted fragment
  // does not have.
  return (
    <div ref={containerRef}>
      {groupBlocks(parseMarkdownToBlocks(DOCUMENT)).map((group) =>
        group.type === 'list-group'
          ? (() => {
              const indices = computeListIndices(group.blocks);
              return group.blocks.map((block, i) => (
                <BlockRenderer key={block.id} block={block} orderedIndex={indices[i]} />
              ));
            })()
          : <BlockRenderer key={group.block.id} block={group.block} />,
      )}
      {/* An ambiguous code-file link. Its match-count <sup> is chrome the
          renderer draws from a runtime file lookup this test cannot stage, so
          this one block is written by hand. */}
      <p data-block-id="hand-written">
        See <code>config.ts<sup aria-hidden="true">7</sup></code> now
      </p>
    </div>
  );
});

const annotation = (id: string, originalText: string): Annotation => ({
  id,
  blockId: 'external',
  startOffset: 0,
  endOffset: originalText.length,
  type: AnnotationType.COMMENT,
  text: 'from an external tool',
  originalText,
  createdA: 0,
  source: 'external',
} as unknown as Annotation);

describe('external annotations quoting markdown source still highlight', () => {
  // An agent copies phrases out of `/api/plan`, which serves the markdown
  // SOURCE, while restore searches the RENDERED DOM. Every case below is a
  // faithful source quote; each was once accepted, listed, and silently never
  // highlighted, with a `console.warn` as the only trace.
  test.skipIf(!hasDom)('markup-bearing source quotes resolve to the rendered text', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const ref = React.createRef<{ apply: (a: Annotation[]) => void }>();

    await act(async () => {
      root.render(<Harness ref={ref} />);
    });

    const cases: [string, string][] = [
      ['**Install** now', 'emphasis'],
      ['Setup `bun`', 'code span'],
      ['[Deployment](./s.md)', 'link'],
      ['Part 1 --- end', 'smart punctuation'],
      ['Plain unmarked sentence', 'no markup'],
      ['Install now', 'quote of the rendered text, not the source'],
      [
        '| config 표면 분기 | `config.ts` — `ENABLED_SURFACES=mcp` 파싱, `JIRA_*` 요구를 Slack 활성 시로 한정 |',
        'table row — pipes and cell padding exist only in the source',
      ],
      [
        '- `tests/config.test.ts` — `ENABLED_SURFACES=mcp`가 Slack 토큰 없이 config 로드 성공',
        'bulleted list item — source has `- `, DOM has a • glyph',
      ],
      [
        '5. WP1~WP7 구현 → 기존 서버에 배포하여 **동작 불변 확인**',
        'ordered list item — source numeral 5 renders as 3',
      ],
      ['See `config.ts` now', 'ui-only decoration text'],
      ['Install** now', 'fragment cutting an emphasis span in half'],
    ];

    await act(async () => {
      ref.current!.apply(cases.map(([text], i) => annotation(`ann-${i}`, text)));
    });

    const unhighlighted = cases.filter(
      (_, i) => !host.querySelector(`[data-bind-id="ann-${i}"]`),
    );

    expect(unhighlighted.map(([, label]) => label)).toEqual([]);

    root.unmount();
    host.remove();
  });
});
