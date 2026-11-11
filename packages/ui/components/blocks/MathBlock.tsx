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

  // The wrapper (class names, data-* anchors, aria-label) is identical in both branches: block
  // targeting and math-annotation restore key on these attributes, so a placeholder must be
  // addressable exactly like the typeset block.
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
