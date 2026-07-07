import React, { useMemo } from 'react';
import katex from 'katex';
import type { Block } from '../../types';

type MathBlockProps = {
  block: Block;
};

export const normalizeMathTex = (tex: string): string => tex.trim();

export const renderMathToHtml = (tex: string, displayMode: boolean): string => (
  katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: 'warn',
    trust: false,
    output: 'html',
  })
);

export const MathBlock: React.FC<MathBlockProps> = ({ block }) => {
  const tex = normalizeMathTex(block.content);
  const html = useMemo(() => renderMathToHtml(tex, true), [tex]);

  return (
    <div
      className="math-block math-annotatable my-5 overflow-x-auto py-2 text-foreground"
      data-block-id={block.id}
      data-block-type="math"
      data-math-tex={tex}
      data-math-display="true"
      aria-label={tex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
