import React, { useMemo } from 'react';
import type { Block } from '../../types';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../../utils/parser';
// BlockRenderer renders QuestionBlock, which renders this: a cycle that only
// meets at render time, after both modules have loaded.
import { BlockRenderer } from '../BlockRenderer';

/**
 * The document renderers at the card's scale and tone. A stylesheet rather
 * than Tailwind arbitrary variants on purpose: those would add utilities to
 * every bundle whose Tailwind scans `packages/ui/components` (the guides.show
 * viewer among them, which never renders a question card), and a host gets
 * these rules without any Tailwind setup. Unlayered, so it outranks the
 * renderers' utility classes.
 */
const QUESTION_CONTEXT_CSS = `
.question-context > * { margin-top: 0.5rem; margin-bottom: 0.5rem; }
.question-context > :first-child { margin-top: 0; }
.question-context > :last-child { margin-bottom: 0; }
.question-context p, .question-context .text-sm { font-size: 13px; line-height: 1.5; }
.question-context p, .question-context [data-question-context-list] span { color: inherit; }
.question-context h1, .question-context h2, .question-context h3 { margin: 0.75rem 0 0.25rem; font-size: 14px; }
.question-context h3 { font-size: 13.5px; }
`;

/**
 * A question card's context, rendered as the document renders markdown: the
 * same block parser and the same block renderers, so a table, a list, a code
 * fence, a quote or an image in the context looks the way it does in the
 * document instead of collapsing into one paragraph.
 *
 * The blocks belong to the card: they carry no `data-block-id` of their own,
 * so a selection or pinpoint inside them resolves to the card (and its
 * `data-question-part="context"` part), never to a block id that also names a
 * real document block. The card sets the scale: muted 13px prose, tight
 * spacing.
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
    // Ids leave after grouping (grouping keys on them); undefined makes the
    // renderers omit `data-block-id`.
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
      {/* React hoists this into <head> once for every card. */}
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
