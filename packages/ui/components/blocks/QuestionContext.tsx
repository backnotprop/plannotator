import React, { useMemo } from 'react';
import type { Block } from '../../types';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../../utils/parser';
import { BlockRenderer } from '../BlockRenderer';

const QUESTION_CONTEXT_CSS = `
.question-context > * { margin-top: 0.5rem; margin-bottom: 0.5rem; }
.question-context > :first-child { margin-top: 0; }
.question-context > :last-child { margin-bottom: 0; }
.question-context p, .question-context .text-sm { font-size: 13px; line-height: 1.5; }
/* Context lines stay lines ("Stopped: …" then "Holds up: …"), as the
   authoring guide writes them; the parser keeps them as soft breaks. */
.question-context p { white-space: pre-line; }
.question-context p, .question-context [data-question-context-list] span { color: inherit; }
.question-context h1, .question-context h2, .question-context h3 { margin: 0.75rem 0 0.25rem; font-size: 14px; }
.question-context h3 { font-size: 13.5px; }
`;

/**
 * A question card's context, rendered as the document renders markdown: the same block parser
 * and the same block renderers, so a table, a list, a code fence.
 */
export const QuestionContext: React.FC<{
  id: string;
  markdown: string;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  githubRepo?: string;
  repoHost?: string;
}> = ({ id, markdown, ...inlineProps }) => {
  const groups = useMemo((): Array<{ list: Block[]; indices: (number | null)[] } | { block: Block }> => {
    const anonymous = (block: Block): Block => ({ ...block, id: undefined as unknown as string });
    return groupBlocks(parseMarkdownToBlocks(markdown, { frontmatter: false })).map((group) =>
      group.type === 'list-group'
        ? { list: group.blocks.map(anonymous), indices: computeListIndices(group.blocks) }
        : { block: anonymous(group.block) },
    );
  }, [markdown]);

  return (
    <div
      id={id}
      className="question-context mt-1 text-[13px] leading-normal text-muted-foreground"
      data-question-part="context"
    >
      <style href="plannotator-question-context" precedence="default">{QUESTION_CONTEXT_CSS}</style>
      {groups.map((group, i) =>
        'list' in group ? (
          <div key={`l-${i}`} data-question-context-list="">
            {group.list.map((block, j) => (
              <BlockRenderer key={j} block={block} orderedIndex={group.indices[j]} {...inlineProps} />
            ))}
          </div>
        ) : (
          <BlockRenderer key={`b-${i}`} block={group.block} {...inlineProps} />
        ),
      )}
    </div>
  );
};
