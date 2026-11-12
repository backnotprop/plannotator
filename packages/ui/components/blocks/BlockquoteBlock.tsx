import React, { createContext, useContext, useMemo } from 'react';
import type { Block } from '../../types';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../../utils/parser';
import { isQuestionDirectiveKind } from '@plannotator/core/question-block';
import { InlineMarkdown } from '../InlineMarkdown';
import { Callout } from './Callout';
import { BlockRenderer } from '../BlockRenderer';

export const BLOCKQUOTE_CLASS_NAME = 'border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic';

const QUOTE_BODY_CSS = `
.pn-quote-body > * { margin-top: 0; margin-bottom: 0; }
.pn-quote-body > * + * { margin-top: 0.5rem; }
.pn-quote-body pre, .pn-quote-body table { font-style: normal; }
.pn-quote-body [data-quote-list] span { color: inherit; }
`;

export const parseQuoteBody = (content: string): Block[] =>
  parseMarkdownToBlocks(content, { frontmatter: false });

export const isProseQuote = (inner: readonly Block[]): boolean =>
  inner.every((block) => block.type === 'paragraph');

export const MAX_QUOTE_DEPTH = 12;

const QuoteDepthContext = createContext(0);

export const useAtQuoteDepthCap = (): boolean => useContext(QuoteDepthContext) + 1 >= MAX_QUOTE_DEPTH;

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

export const BlockquoteBlock: React.FC<BlockquoteBlockProps> = ({ block, ...inlineProps }) => {
  const depth = useContext(QuoteDepthContext);
  const atCap = depth + 1 >= MAX_QUOTE_DEPTH;
  const inner = useMemo(() => (atCap ? [] : parseQuoteBody(block.content)), [atCap, block.content]);

  if (atCap || isProseQuote(inner)) {
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
      <style href="plannotator-quote-body" precedence="default">{QUOTE_BODY_CSS}</style>
      <QuoteDepthContext.Provider value={depth + 1}>
        <QuoteBody inner={inner} {...inlineProps} />
      </QuoteDepthContext.Provider>
    </blockquote>
  );
};

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

export const calloutNeedsBlocks = (inner: readonly Block[]): boolean =>
  inner.some((block) => block.type !== 'paragraph' && block.type !== 'list-item');

export const CalloutBlocks: React.FC<Omit<BlockquoteBlockProps, 'block'> & { inner: Block[]; className?: string }> = ({ inner, className, ...inlineProps }) => {
  const depth = useContext(QuoteDepthContext);
  return (
    <div className={className ? `pn-quote-body ${className}` : 'pn-quote-body'}>
      <style href="plannotator-quote-body" precedence="default">{QUOTE_BODY_CSS}</style>
      <QuoteDepthContext.Provider value={depth + 1}>
        <QuoteBody inner={inner} {...inlineProps} />
      </QuoteDepthContext.Provider>
    </div>
  );
};
