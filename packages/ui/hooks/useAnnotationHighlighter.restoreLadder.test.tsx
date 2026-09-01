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

/**
 * The rendered document. Its DOM text is what the renderer produced —
 * `Install now`, `Setup bun`, `Deployment`, `Part 1 — end` — never the markdown
 * that produced it.
 */
const Harness = forwardRef<{ apply: (a: Annotation[]) => void }, {}>((_props, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode: 'comment',
  });
  useImperativeHandle(ref, () => ({ apply: hook.applyAnnotations }), [hook.applyAnnotations]);

  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">
        <strong>Install</strong> now
      </p>
      <p data-block-id="block-2">
        Setup <code>bun</code>
      </p>
      <p data-block-id="block-3">
        <a href="./s.md">Deployment</a> guide
      </p>
      <p data-block-id="block-4">Part 1 — end</p>
      <p data-block-id="block-5">Plain unmarked sentence</p>
      {/* A markdown table: the row's pipes and cell padding exist only in the
          source. The renderer makes sibling <td>s with no separator text. */}
      <div data-block-id="block-6">
        <table>
          <tbody>
            <tr>
              <td>config 표면 분기</td>
              <td><code>config.ts</code> — <code>ENABLED_SURFACES=mcp</code> 파싱, <code>JIRA_*</code> 요구를 Slack 활성 시로 한정</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* An ambiguous code-file link: the match-count <sup> is UI chrome the
          document does not contain, so restore must not see its text. */}
      <p data-block-id="block-7">
        See <code>config.ts<sup aria-hidden="true">7</sup></code> now
      </p>
    </div>
  );
});

const annotation = (blockId: string, originalText: string): Annotation => ({
  id: `ann-${blockId}`,
  blockId,
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
  // faithful source quote whose rendered form drops the syntax; before the
  // strip rungs each was accepted, listed, and silently never highlighted.
  test.skipIf(!hasDom)('markup-bearing source quotes resolve to the rendered text', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const ref = React.createRef<{ apply: (a: Annotation[]) => void }>();

    await act(async () => {
      root.render(<Harness ref={ref} />);
    });

    const cases: [string, string, string][] = [
      ['block-1', '**Install** now', 'emphasis'],
      ['block-2', 'Setup `bun`', 'code span'],
      ['block-3', '[Deployment](./s.md)', 'link'],
      ['block-4', 'Part 1 --- end', 'smart punctuation (pre-existing rung)'],
      ['block-5', 'Plain unmarked sentence', 'no markup (literal rung)'],
      [
        'block-6',
        '| config 표면 분기 | `config.ts` — `ENABLED_SURFACES=mcp` 파싱, `JIRA_*` 요구를 Slack 활성 시로 한정 |',
        'table row',
      ],
      ['block-7', 'See `config.ts` now', 'ui-only decoration text'],
    ];

    await act(async () => {
      ref.current!.apply(cases.map(([blockId, text]) => annotation(blockId, text)));
    });

    const unhighlighted = cases.filter(
      ([blockId]) => !host.querySelector(`[data-block-id="${blockId}"] .annotation-highlight, [data-block-id="${blockId}"] mark`),
    );

    expect(unhighlighted.map(([, , label]) => label)).toEqual([]);

    root.unmount();
    host.remove();
  });
});
