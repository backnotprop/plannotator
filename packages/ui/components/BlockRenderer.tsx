import React from "react";
import { Block } from "../types";
import { InlineMarkdown } from "./InlineMarkdown";
import { ListMarker } from "./ListMarker";
import { CodeBlock } from "./blocks/CodeBlock";
import { HtmlBlock } from "./blocks/HtmlBlock";
import { Callout } from "./blocks/Callout";
import { AlertBlock } from "./blocks/AlertBlock";
import { TableBlock } from "./blocks/TableBlock";

export const BlockRenderer: React.FC<{
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
  orderedIndex?: number | null;
  githubRepo?: string;
  headingAnchorId?: string;
  onNavigateAnchor?: (hash: string) => void;
}> = ({ block, onOpenLinkedDoc, imageBaseDir, onImageClick, onToggleCheckbox, checkboxOverrides, orderedIndex, githubRepo, headingAnchorId, onNavigateAnchor }) => {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level || 1}` as React.ElementType;
      const styles = {
        1: 'text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight',
        2: 'text-xl font-semibold mb-3 mt-8 text-foreground/90',
        3: 'text-base font-semibold mb-2 mt-6 text-foreground/80',
      }[block.level || 1] || 'text-base font-semibold mb-2 mt-4';
      return (
        <Tag
          id={headingAnchorId}
          className={styles}
          data-block-id={block.id}
          data-block-type="heading"
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} onNavigateAnchor={onNavigateAnchor} />
        </Tag>
      );
    }

    case 'blockquote': {
      if (block.alertKind) {
        return (
          <AlertBlock
            blockId={block.id}
            kind={block.alertKind}
            body={block.content}
            onOpenLinkedDoc={onOpenLinkedDoc}
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            githubRepo={githubRepo}
            onNavigateAnchor={onNavigateAnchor}
          />
        );
      }
      // Content may span multiple merged `>` lines. Split on blank-line
      // paragraph breaks so `> a\n>\n> b` renders as two <p> children.
      const paragraphs = block.content.split(/\n\n+/);
      return (
        <blockquote
          className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic"
          data-block-id={block.id}
        >
          {paragraphs.map((para, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : ''}>
              <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={para} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} onNavigateAnchor={onNavigateAnchor} />
            </p>
          ))}
        </blockquote>
      );
    }

    case 'list-item': {
      const indent = (block.level || 0) * 1.25; // 1.25rem per level
      const isCheckbox = block.checked !== undefined;
      const isChecked = checkboxOverrides?.has(block.id)
        ? checkboxOverrides.get(block.id)!
        : block.checked;
      const isInteractive = isCheckbox && !!onToggleCheckbox;
      return (
        <div
          className="flex items-start gap-3 my-1.5"
          data-block-id={block.id}
          style={{ marginLeft: `${indent}rem` }}
        >
          <ListMarker
            level={block.level || 0}
            ordered={block.ordered}
            orderedIndex={orderedIndex}
            checked={isChecked}
            interactive={isInteractive}
            onToggle={isInteractive ? () => onToggleCheckbox!(block.id, !isChecked) : undefined}
          />
          <span className={`text-sm leading-relaxed ${isCheckbox && isChecked ? 'text-muted-foreground line-through' : 'text-foreground/90'}`}>
            <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} onNavigateAnchor={onNavigateAnchor} />
          </span>
        </div>
      );
    }

    case 'code':
      return <CodeBlock block={block} onHover={() => {}} onLeave={() => {}} isHovered={false} />;

    case 'table':
      return (
        <TableBlock
          block={block}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          onOpenLinkedDoc={onOpenLinkedDoc}
          githubRepo={githubRepo}
          onNavigateAnchor={onNavigateAnchor}
        />
      );

    case 'hr':
      return <hr className="border-border/30 my-8" data-block-id={block.id} />;

    case 'html':
      return <HtmlBlock block={block} imageBaseDir={imageBaseDir} onOpenLinkedDoc={onOpenLinkedDoc} onNavigateAnchor={onNavigateAnchor} />;

    case 'directive': {
      const kind = block.directiveKind || 'note';
      return (
        <Callout
          blockId={block.id}
          kind={kind}
          body={block.content}
          containerClassName={`directive directive-${kind} my-4 px-4 py-3 rounded-md border`}
          blockType="directive"
          kindAttribute={kind}
          onOpenLinkedDoc={onOpenLinkedDoc}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          githubRepo={githubRepo}
          onNavigateAnchor={onNavigateAnchor}
        />
      );
    }

    default:
      return (
        <p
          className="mb-4 leading-relaxed text-foreground/90 text-[15px]"
          data-block-id={block.id}
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} onNavigateAnchor={onNavigateAnchor} />
        </p>
      );
  }
};
