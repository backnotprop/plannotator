/**
 * PlanCleanDiffView — Rendered/clean diff mode
 *
 * Shows the new plan content rendered as markdown, with colored left borders
 * indicating what changed. Annotation uses block-level hover (like code block
 * hover in Viewer) — no text selection, no web-highlighter.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import hljs from "highlight.js";
import { parseMarkdownToBlocks } from "../../utils/parser";
import type { Block, Annotation, EditorMode, ImageAttachment } from "../../types";
import { AnnotationType } from "../../types";
import type { PlanDiffBlock } from "../../utils/planDiffEngine";
import type { QuickLabel } from "../../utils/quickLabels";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { CommentPopover } from "../CommentPopover";
import { FloatingQuickLabelPicker } from "../FloatingQuickLabelPicker";
import { getIdentity } from "../../utils/identity";

interface PlanCleanDiffViewProps {
  blocks: PlanDiffBlock[];
  annotations?: Annotation[];
  onAddAnnotation?: (ann: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId?: string | null;
  mode?: EditorMode;
}

export const PlanCleanDiffView: React.FC<PlanCleanDiffViewProps> = ({
  blocks,
  annotations = [],
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId = null,
  mode = "selection",
}) => {
  const modeRef = useRef<EditorMode>(mode);
  const onAddAnnotationRef = useRef(onAddAnnotation);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hoveredBlock, setHoveredBlock] = useState<{
    element: HTMLElement;
    block: PlanDiffBlock;
    index: number;
    diffContext: Annotation['diffContext'];
  } | null>(null);
  const [isExiting, setIsExiting] = useState(false);

  const [commentPopover, setCommentPopover] = useState<{
    anchorEl: HTMLElement;
    contextText: string;
    initialText?: string;
    block: PlanDiffBlock;
    index: number;
    diffContext: Annotation['diffContext'];
  } | null>(null);

  const [quickLabelPicker, setQuickLabelPicker] = useState<{
    anchorEl: HTMLElement;
    block: PlanDiffBlock;
    index: number;
    diffContext: Annotation['diffContext'];
  } | null>(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { onAddAnnotationRef.current = onAddAnnotation; }, [onAddAnnotation]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  // Scroll to selected annotation's diff block
  // Only depends on selectedAnnotationId — annotations ref is read but not a trigger
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  useEffect(() => {
    if (!selectedAnnotationId) return;

    const ann = annotationsRef.current.find(a => a.id === selectedAnnotationId);
    if (!ann?.blockId?.startsWith('diff-block-')) return;

    const idx = ann.blockId.replace('diff-block-', '');
    const el = document.querySelector(`[data-diff-block-index="${idx}"]`);
    if (!el) return;

    el.classList.add('annotation-highlight', 'focused');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const timer = setTimeout(() => {
      el.classList.remove('annotation-highlight', 'focused');
    }, 2000);
    return () => clearTimeout(timer);
  }, [selectedAnnotationId]);

  // Build set of annotated block IDs for highlight rings
  const annotatedBlockIds = React.useMemo(() => {
    const set = new Set<string>();
    annotations.forEach(ann => {
      if (ann.diffContext && ann.blockId) {
        set.add(ann.blockId);
      }
    });
    return set;
  }, [annotations]);

  /** Resolve content for a diff block section (handles modified blocks with old/new sides) */
  const getBlockContent = useCallback((block: PlanDiffBlock, diffContext: Annotation['diffContext']) =>
    block.type === 'modified' && diffContext === 'removed'
      ? block.oldContent || block.content
      : block.content
  , []);

  const createDiffAnnotation = useCallback((
    block: PlanDiffBlock,
    index: number,
    diffContext: Annotation['diffContext'],
    type: AnnotationType,
    text?: string,
    images?: ImageAttachment[],
    isQuickLabel?: boolean,
    quickLabelTip?: string,
  ) => {
    const content = getBlockContent(block, diffContext);
    const now = Date.now();

    const newAnnotation: Annotation = {
      id: `diff-${now}-${index}`,
      blockId: `diff-block-${index}`,
      startOffset: 0,
      endOffset: content.length,
      type,
      text,
      originalText: content,
      createdA: now,
      author: getIdentity(),
      images,
      diffContext,
      ...(isQuickLabel ? { isQuickLabel: true } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
    };

    onAddAnnotationRef.current?.(newAnnotation);
  }, [getBlockContent]);

  // Hover handlers
  const handleHover = useCallback((element: HTMLElement, block: PlanDiffBlock, index: number, diffContext: Annotation['diffContext']) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsExiting(false);
    if (!commentPopover && !quickLabelPicker) {
      setHoveredBlock({ element, block, index, diffContext });
    }
  }, [commentPopover, quickLabelPicker]);

  const handleLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsExiting(true);
      exitTimerRef.current = setTimeout(() => {
        setHoveredBlock(null);
        setIsExiting(false);
        exitTimerRef.current = null;
      }, 150);
    }, 100);
  }, []);

  // Toolbar handlers
  const handleAnnotate = (type: AnnotationType) => {
    if (!hoveredBlock) return;
    createDiffAnnotation(hoveredBlock.block, hoveredBlock.index, hoveredBlock.diffContext, type);
    setHoveredBlock(null);
    setIsExiting(false);
  };

  const handleQuickLabel = (label: QuickLabel) => {
    if (!hoveredBlock) return;
    createDiffAnnotation(
      hoveredBlock.block, hoveredBlock.index, hoveredBlock.diffContext,
      AnnotationType.COMMENT, `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    setHoveredBlock(null);
    setIsExiting(false);
  };

  const handleToolbarClose = () => {
    setHoveredBlock(null);
    setIsExiting(false);
  };

  const handleRequestComment = (initialChar?: string) => {
    if (!hoveredBlock) return;
    const content = getBlockContent(hoveredBlock.block, hoveredBlock.diffContext);
    setCommentPopover({
      anchorEl: hoveredBlock.element,
      contextText: content.slice(0, 80),
      initialText: initialChar,
      block: hoveredBlock.block,
      index: hoveredBlock.index,
      diffContext: hoveredBlock.diffContext,
    });
    setHoveredBlock(null);
  };

  const handleCommentSubmit = (text: string, images?: ImageAttachment[]) => {
    if (!commentPopover) return;
    createDiffAnnotation(
      commentPopover.block, commentPopover.index, commentPopover.diffContext,
      AnnotationType.COMMENT, text, images
    );
    setCommentPopover(null);
  };

  const handleCommentClose = useCallback(() => {
    setCommentPopover(null);
  }, []);

  const handleFloatingQuickLabel = useCallback((label: QuickLabel) => {
    if (!quickLabelPicker) return;
    createDiffAnnotation(
      quickLabelPicker.block, quickLabelPicker.index, quickLabelPicker.diffContext,
      AnnotationType.COMMENT, `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    setQuickLabelPicker(null);
  }, [quickLabelPicker, createDiffAnnotation]);

  const handleQuickLabelPickerDismiss = useCallback(() => {
    setQuickLabelPicker(null);
  }, []);

  // Mode-aware click on hovered block
  const handleBlockClick = useCallback((block: PlanDiffBlock, index: number, element: HTMLElement, diffContext: Annotation['diffContext']) => {
    if (modeRef.current === 'redline') {
      createDiffAnnotation(block, index, diffContext, AnnotationType.DELETION);
    } else if (modeRef.current === 'comment') {
      const content = getBlockContent(block, diffContext);
      setCommentPopover({
        anchorEl: element,
        contextText: content.slice(0, 80),
        block,
        index,
        diffContext,
      });
    } else if (modeRef.current === 'quickLabel') {
      setQuickLabelPicker({ anchorEl: element, block, index, diffContext });
    }
  }, [createDiffAnnotation, getBlockContent]);

  // Check if a block index has been annotated (for highlight ring)
  const isBlockAnnotated = (index: number) => annotatedBlockIds.has(`diff-block-${index}`);

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => (
        <DiffBlockRenderer
          key={index}
          block={block}
          index={index}
          hoveredIndex={hoveredBlock?.index ?? null}
          hoveredDiffContext={hoveredBlock?.diffContext}
          isBlockAnnotated={isBlockAnnotated}
          onHover={onAddAnnotation ? (el, diffContext) => handleHover(el, block, index, diffContext) : undefined}
          onLeave={onAddAnnotation ? handleLeave : undefined}
          onClick={onAddAnnotation && mode !== 'selection' ? (el, diffContext) => handleBlockClick(block, index, el, diffContext) : undefined}
        />
      ))}

      {/* Block hover toolbar (selection mode) */}
      {hoveredBlock && !commentPopover && !quickLabelPicker && (
        <AnnotationToolbar
          element={hoveredBlock.element}
          positionMode="top-right"
          onAnnotate={handleAnnotate}
          onClose={handleToolbarClose}
          onRequestComment={handleRequestComment}
          onQuickLabel={handleQuickLabel}
          isExiting={isExiting}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
              hoverTimeoutRef.current = null;
            }
            setIsExiting(false);
          }}
          onMouseLeave={handleLeave}
        />
      )}

      {/* Comment popover */}
      {commentPopover && (
        <CommentPopover
          anchorEl={commentPopover.anchorEl}
          contextText={commentPopover.contextText}
          isGlobal={false}
          initialText={commentPopover.initialText}
          onSubmit={handleCommentSubmit}
          onClose={handleCommentClose}
        />
      )}

      {/* Quick label picker */}
      {quickLabelPicker && (
        <FloatingQuickLabelPicker
          anchorEl={quickLabelPicker.anchorEl}
          onSelect={handleFloatingQuickLabel}
          onDismiss={handleQuickLabelPickerDismiss}
        />
      )}
    </div>
  );
};

// --- DiffBlockRenderer with hover support ---

interface DiffBlockRendererProps {
  block: PlanDiffBlock;
  index: number;
  hoveredIndex: number | null;
  hoveredDiffContext?: Annotation['diffContext'];
  isBlockAnnotated: (index: number) => boolean;
  onHover?: (element: HTMLElement, diffContext: Annotation['diffContext']) => void;
  onLeave?: () => void;
  onClick?: (element: HTMLElement, diffContext: Annotation['diffContext']) => void;
}

const DiffBlockRenderer: React.FC<DiffBlockRendererProps> = ({
  block, index, hoveredIndex, hoveredDiffContext, isBlockAnnotated, onHover, onLeave, onClick,
}) => {
  const hoverProps = (diffContext: Annotation['diffContext']) => onHover ? {
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => onHover(e.currentTarget, diffContext),
    onMouseLeave: () => onLeave?.(),
    onClick: onClick ? (e: React.MouseEvent<HTMLDivElement>) => onClick(e.currentTarget, diffContext) : undefined,
    style: { cursor: 'pointer' } as React.CSSProperties,
  } : {};

  const isHovered = (diffContext: Annotation['diffContext']) =>
    hoveredIndex === index && hoveredDiffContext === diffContext;

  const ringClass = (diffContext: Annotation['diffContext']) => {
    if (isHovered(diffContext)) return 'ring-1 ring-primary/30 rounded';
    if (isBlockAnnotated(index)) return 'ring-2 ring-accent rounded outline-offset-2';
    return '';
  };

  switch (block.type) {
    case "unchanged":
      return (
        <div className="plan-diff-unchanged opacity-60 hover:opacity-100 transition-opacity">
          <MarkdownChunk content={block.content} />
        </div>
      );

    case "added":
      return (
        <div
          className={`plan-diff-added transition-shadow ${ringClass('added')}`}
          data-diff-block-index={index}
          {...hoverProps('added')}
        >
          <MarkdownChunk content={block.content} />
        </div>
      );

    case "removed":
      return (
        <div
          className={`plan-diff-removed line-through decoration-destructive/30 opacity-70 transition-shadow ${ringClass('removed')}`}
          data-diff-block-index={index}
          {...hoverProps('removed')}
        >
          <MarkdownChunk content={block.content} />
        </div>
      );

    case "modified":
      return (
        <div data-diff-block-index={index}>
          <div
            className={`plan-diff-removed line-through decoration-destructive/30 opacity-60 transition-shadow ${ringClass('removed')}`}
            {...hoverProps('removed')}
          >
            <MarkdownChunk content={block.oldContent!} />
          </div>
          <div
            className={`plan-diff-added transition-shadow ${ringClass('modified')}`}
            {...hoverProps('modified')}
          >
            <MarkdownChunk content={block.content} />
          </div>
        </div>
      );

    default:
      return null;
  }
};

// --- Rendering components (unchanged from main) ---

const MarkdownChunk: React.FC<{ content: string }> = ({ content }) => {
  const blocks = React.useMemo(
    () => parseMarkdownToBlocks(content),
    [content]
  );

  return (
    <>
      {blocks.map((block) => (
        <SimpleBlockRenderer key={block.id} block={block} />
      ))}
    </>
  );
};

const SimpleBlockRenderer: React.FC<{ block: Block }> = ({ block }) => {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level || 1}` as keyof React.JSX.IntrinsicElements;
      const styles =
        {
          1: "text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight",
          2: "text-xl font-semibold mb-3 mt-8 text-foreground/90",
          3: "text-base font-semibold mb-2 mt-6 text-foreground/80",
        }[block.level || 1] || "text-base font-semibold mb-2 mt-4";

      return (
        <Tag className={styles}>
          <InlineMarkdown text={block.content} />
        </Tag>
      );
    }

    case "blockquote":
      return (
        <blockquote className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic">
          <InlineMarkdown text={block.content} />
        </blockquote>
      );

    case "list-item": {
      const indent = (block.level || 0) * 1.25;
      const isCheckbox = block.checked !== undefined;
      return (
        <div
          className="flex gap-3 my-1.5"
          style={{ marginLeft: `${indent}rem` }}
        >
          <span className="select-none shrink-0 flex items-center">
            {isCheckbox ? (
              block.checked ? (
                <svg
                  className="w-4 h-4 text-success"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4 text-muted-foreground/50"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )
            ) : (
              <span className="text-primary/60">
                {(block.level || 0) === 0
                  ? "\u2022"
                  : (block.level || 0) === 1
                    ? "\u25E6"
                    : "\u25AA"}
              </span>
            )}
          </span>
          <span
            className={`text-sm leading-relaxed ${isCheckbox && block.checked ? "text-muted-foreground line-through" : "text-foreground/90"}`}
          >
            <InlineMarkdown text={block.content} />
          </span>
        </div>
      );
    }

    case "code":
      return <SimpleCodeBlock block={block} />;

    case "hr":
      return <hr className="border-border/30 my-8" />;

    case "table": {
      const lines = block.content.split('\n').filter(line => line.trim());
      if (lines.length === 0) return null;
      const parseRow = (line: string): string[] =>
        line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
      const headers = parseRow(lines[0]);
      const rows: string[][] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^[\|\-:\s]+$/.test(line)) continue;
        rows.push(parseRow(line));
      }
      return (
        <div className="my-4 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {headers.map((header, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30">
                    <InlineMarkdown text={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                      <InlineMarkdown text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    default:
      return (
        <p className="mb-4 leading-relaxed text-foreground/90 text-[15px]">
          <InlineMarkdown text={block.content} />
        </p>
      );
  }
};

const SimpleCodeBlock: React.FC<{ block: Block }> = ({ block }) => {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.removeAttribute("data-highlighted");
      codeRef.current.className = `hljs font-mono${block.language ? ` language-${block.language}` : ""}`;
      hljs.highlightElement(codeRef.current);
    }
  }, [block.content, block.language]);

  return (
    <div className="relative group my-5">
      <pre className="bg-muted/50 border border-border/30 rounded-lg overflow-x-auto">
        <code
          ref={codeRef}
          className={`hljs font-mono${block.language ? ` language-${block.language}` : ""}`}
        >
          {block.content}
        </code>
      </pre>
      {block.language && (
        <span className="absolute top-2 right-2 text-[9px] font-mono text-muted-foreground/50">
          {block.language}
        </span>
      )}
    </div>
  );
};

const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      parts.push(
        <strong key={key++} className="font-semibold">
          <InlineMarkdown text={match[1]} />
        </strong>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^\*(.+?)\*/);
    if (match) {
      parts.push(<em key={key++}><InlineMarkdown text={match[1]} /></em>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono"
        >
          {match[1]}
        </code>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      parts.push(
        <a
          key={key++}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {match[1]}
        </a>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    const nextSpecial = remaining.slice(1).search(/[*`[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else {
      parts.push(remaining.slice(0, nextSpecial + 1));
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  return <>{parts}</>;
};
