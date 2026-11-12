import React, { useMemo } from 'react';
import type { Block } from '../../types';
import { normalizeMathTex, renderMathToHtml } from '../../utils/math';
import { useMathRenderer } from '../../hooks/useMathRenderer';

export { normalizeMathTex, renderMathToHtml };

type MathBlockProps = {
  block: Block;
};

export const MathBlock: React.FC<MathBlockProps> = ({ block }) => {
  const tex = normalizeMathTex(block.content);
  const renderer = useMathRenderer();
  const html = useMemo(() => renderMathToHtml(tex, true, renderer), [tex, renderer]);

  if (html === null) {
    return (
      <div
        className="math-block math-annotatable my-5 overflow-x-auto py-2 text-foreground"
        data-block-id={block.id}
        data-block-type="math"
        data-math-tex={tex}
        data-math-display="true"
        aria-label={tex}
      >
        {tex}
      </div>
    );
  }

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
