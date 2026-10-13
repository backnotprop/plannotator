import React, { createContext, useContext, useMemo } from 'react';
import type { Block } from '../../types';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../../utils/parser';
import { isQuestionDirectiveKind } from '@plannotator/core/question-block';
import { InlineMarkdown } from '../InlineMarkdown';
import { Callout } from './Callout';
// BlockRenderer renders this, and this renders the quote's inner blocks with
// BlockRenderer: a cycle that only meets at render time, after both modules
// have loaded (the QuestionContext precedent).
import { BlockRenderer } from '../BlockRenderer';

/** The quote's look. Shared by both render paths so they cannot drift. */
export const BLOCKQUOTE_CLASS_NAME = 'border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic';

/**
 * Spacing and tone for a quote whose content has block structure. A
 * stylesheet rather than Tailwind arbitrary variants for the reason
 * QuestionContext gives: no new utilities in every bundle that scans
 * `packages/ui/components`, and a host gets the rules without Tailwind setup.
 * Unlayered, so it outranks the inner renderers' own margins (a code block's
 * `my-5`, a nested quote's `my-4`): children sit flush with the bar's ends
 * and half a line apart, like the paragraphs of a prose quote.
 */
const QUOTE_BODY_CSS = `
.pn-quote-body > * { margin-top: 0; margin-bottom: 0; }
.pn-quote-body > * + * { margin-top: 0.5rem; }
.pn-quote-body pre, .pn-quote-body table { font-style: normal; }
.pn-quote-body [data-quote-list] span { color: inherit; }
`;

/** The quote's inner markdown, split the way the document is split. */
export const parseQuoteBody = (content: string): Block[] =>
  parseMarkdownToBlocks(content, { frontmatter: false });

/**
 * Whether a quote's inner blocks are only paragraphs. Such a quote renders
 * exactly as quotes always have (one `<p>` per paragraph, nothing else); any
 * other block (a code fence, a list, a nested quote, a table, a heading…)
 * takes the structured path.
 */
export const isProseQuote = (inner: readonly Block[]): boolean =>
  inner.every((block) => block.type === 'paragraph');

/**
 * How deep quotes may nest before the rest renders as text. Each level is a
 * component and a parse of its own, so `>>>>…` thousands deep (a third-party
 * PR comment can hold anything) would otherwise overflow the stack and
 * unmount the tree. GitHub stops drawing distinct levels long before this.
 */
export const MAX_QUOTE_DEPTH = 12;

/** The number of quotes around the one rendering (0 at the top). */
const QuoteDepthContext = createContext(0);

export interface BlockquoteBlockProps {
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  repoHost?: string;
  onNavigateAnchor?: (hash: string) => void;
}

/**
 * A (non-alert) blockquote: one `<blockquote>` with one bar, carrying the
 * block's id, whatever its content holds.
 *
 * The inner blocks belong to the quote. They render through the document's
 * own renderers but carry no `data-block-id`, so a selection, a pinpoint, a
 * restore or an export inside them resolves to the quote block (the
 * QuestionContext rule). A `:::question` written inside a quote is not a
 * question block (`findQuestionBlocks` agrees): it renders as a callout.
 */
export const BlockquoteBlock: React.FC<BlockquoteBlockProps> = ({ block, ...inlineProps }) => {
  const depth = useContext(QuoteDepthContext);
  // Past the cap the content is not parsed again: it renders as prose text,
  // its remaining `>` markers included.
  const atCap = depth + 1 >= MAX_QUOTE_DEPTH;
  const inner = useMemo(() => (atCap ? [] : parseQuoteBody(block.content)), [atCap, block.content]);

  if (atCap || isProseQuote(inner)) {
    // The prose quote, unchanged: split on blank-line paragraph breaks so
    // `> a\n>\n> b` renders as two <p> children. Lines are trimmed as the
    // parser used to trim them, so the text is what it always was.
    const paragraphs = block.content
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .split(/\n\n+/);
    return (
      <blockquote className={BLOCKQUOTE_CLASS_NAME} data-block-id={block.id}>
        {paragraphs.map((para, i) => (
          <p key={i} className={i > 0 ? 'mt-2' : ''}>
            <InlineMarkdown text={para} {...inlineProps} />
          </p>
        ))}
      </blockquote>
    );
  }

  return (
    <blockquote className={`${BLOCKQUOTE_CLASS_NAME} pn-quote-body`} data-block-id={block.id}>
      {/* React hoists this into <head> once for every quote. */}
      <style href="plannotator-quote-body" precedence="default">{QUOTE_BODY_CSS}</style>
      <QuoteDepthContext.Provider value={depth + 1}>
        <QuoteBody inner={inner} {...inlineProps} />
      </QuoteDepthContext.Provider>
    </blockquote>
  );
};

/** Ids leave after grouping (grouping keys on them); undefined makes the
 *  renderers omit `data-block-id`. */
const anonymous = (block: Block): Block => ({ ...block, id: undefined as unknown as string });

const QuoteBody: React.FC<Omit<BlockquoteBlockProps, 'block'> & { inner: Block[] }> = ({ inner, ...inlineProps }) => (
  <>
    {groupBlocks(inner).map((group, i) => {
      if (group.type === 'list-group') {
        const indices = computeListIndices(group.blocks);
        return (
          <div key={`l-${i}`} data-quote-list="">
            {group.blocks.map((block, j) => (
              <BlockRenderer key={j} block={anonymous(block)} orderedIndex={indices[j]} {...inlineProps} />
            ))}
          </div>
        );
      }
      const block = group.block;
      if (block.type === 'paragraph') {
        // The prose quote's paragraph, so text reads the same with or
        // without a fence beside it.
        return (
          <p key={`b-${i}`}>
            <InlineMarkdown text={block.content} {...inlineProps} />
          </p>
        );
      }
      if (block.type === 'directive' && isQuestionDirectiveKind(block.directiveKind)) {
        const kind = block.directiveKind || 'note';
        return (
          <Callout
            key={`b-${i}`}
            blockId={undefined as unknown as string}
            kind={kind}
            body={block.content}
            containerClassName={`directive directive-${kind} my-4 px-4 py-3 rounded-md border`}
            blockType="directive"
            kindAttribute={kind}
            {...inlineProps}
          />
        );
      }
      return <BlockRenderer key={`b-${i}`} block={anonymous(block)} {...inlineProps} />;
    })}
  </>
);
