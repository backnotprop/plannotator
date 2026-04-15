/**
 * PlanCleanDiffView — Rendered/clean diff mode
 *
 * Shows the new plan content rendered as markdown, with colored left borders
 * indicating what changed. Annotation uses block-level hover (like code block
 * hover in Viewer) — no text selection, no web-highlighter.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import hljs from "highlight.js";
import { parseMarkdownToBlocks, computeListIndices } from "../../utils/parser";
import { ListMarker } from "../ListMarker";
import type { Block, Annotation, EditorMode, ImageAttachment } from "../../types";
import { AnnotationType } from "../../types";
import type {
  PlanDiffBlock,
  InlineDiffToken,
  InlineDiffWrap,
} from "../../utils/planDiffEngine";
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
  /**
   * When true (default), modified blocks that passed the qualification gate
   * render with inline word-level highlights. When false, every modified
   * block falls back to the stacked old-struck / new-green layout — the
   * "Classic" diff view exposed in the mode switcher.
   */
  wordLevel?: boolean;
}

export const PlanCleanDiffView: React.FC<PlanCleanDiffViewProps> = ({
  blocks,
  annotations = [],
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId = null,
  mode = "selection",
  wordLevel = true,
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

  /**
   * Resolve content for a diff block section (handles modified blocks with
   * old/new sides). For inline-diff modified blocks — one clickable target
   * with diffContext 'modified' — we capture BOTH sides in git-diff shape
   * so comments about a struck-through deleted word preserve that word in
   * the exported feedback, instead of sending only the new content.
   */
  const getBlockContent = useCallback((block: PlanDiffBlock, diffContext: Annotation['diffContext']) => {
    if (block.type === 'modified') {
      if (diffContext === 'removed') return block.oldContent || block.content;
      if (
        diffContext === 'modified' &&
        block.oldContent &&
        block.oldContent !== block.content
      ) {
        return `- ${block.oldContent.trimEnd()}\n+ ${block.content.trimEnd()}`;
      }
    }
    return block.content;
  }, []);

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
    } else if (modeRef.current === 'quickLabel') {
      setQuickLabelPicker({ anchorEl: element, block, index, diffContext });
    } else {
      // selection or comment → open the comment popover directly on click
      const content = getBlockContent(block, diffContext);
      setCommentPopover({
        anchorEl: element,
        contextText: content.slice(0, 80),
        block,
        index,
        diffContext,
      });
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
          wordLevel={wordLevel}
          onHover={onAddAnnotation ? (el, diffContext) => handleHover(el, block, index, diffContext) : undefined}
          onLeave={onAddAnnotation ? handleLeave : undefined}
          onClick={onAddAnnotation ? (el, diffContext) => handleBlockClick(block, index, el, diffContext) : undefined}
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
  /** When false, force block-level fallback even if inlineTokens is populated. */
  wordLevel: boolean;
  onHover?: (element: HTMLElement, diffContext: Annotation['diffContext']) => void;
  onLeave?: () => void;
  onClick?: (element: HTMLElement, diffContext: Annotation['diffContext']) => void;
}

const DiffBlockRenderer: React.FC<DiffBlockRendererProps> = ({
  block, index, hoveredIndex, hoveredDiffContext, isBlockAnnotated, wordLevel, onHover, onLeave, onClick,
}) => {
  const hoverProps = (diffContext: Annotation['diffContext']) => onHover ? {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onHover(e.currentTarget, diffContext),
    onMouseLeave: () => onLeave?.(),
    onClick: onClick ? (e: React.MouseEvent<HTMLElement>) => onClick(e.currentTarget, diffContext) : undefined,
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
      // When the engine populated inlineTokens, we render a single in-context
      // block with <ins>/<del> spans inside the structural wrapper. Falls
      // back to the stacked strike-through rendering when tokens are absent
      // (gate rejected: code/table/structural mismatch/inline-code hazard).
      if (wordLevel && block.inlineTokens && block.inlineWrap) {
        return (
          <InlineModifiedBlock
            tokens={block.inlineTokens}
            wrap={block.inlineWrap}
            index={index}
            ringClass={ringClass('modified')}
            hoverProps={hoverProps('modified')}
          />
        );
      }
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

// --- Shared block-rendering style helpers ---
// Kept as module-scope constants so InlineModifiedBlock and SimpleBlockRenderer
// share a single source of truth for heading/paragraph/list-item styling.

const HEADING_STYLE_BY_LEVEL: Record<number, string> = {
  1: "text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight",
  2: "text-xl font-semibold mb-3 mt-8 text-foreground/90",
  3: "text-base font-semibold mb-2 mt-6 text-foreground/80",
};
const HEADING_STYLE_FALLBACK = "text-base font-semibold mb-2 mt-4";
const headingStyleFor = (level: number): string =>
  HEADING_STYLE_BY_LEVEL[level] || HEADING_STYLE_FALLBACK;

const PARAGRAPH_CLASS = "mb-4 leading-relaxed text-foreground/90 text-[15px]";
const LIST_ITEM_ROW_CLASS = "flex gap-3 my-1.5";
const listItemIndentRem = (level: number): string => `${level * 1.25}rem`;
const listItemTextClass = (isCheckbox: boolean, checked?: boolean): string =>
  `text-sm leading-relaxed ${isCheckbox && checked ? "text-muted-foreground line-through" : "text-foreground/90"}`;

// --- Inline word-diff renderer for modified blocks ---

interface InlineModifiedBlockProps {
  tokens: InlineDiffToken[];
  wrap: InlineDiffWrap;
  index: number;
  ringClass: string;
  hoverProps: {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: () => void;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    style?: React.CSSProperties;
  };
}

/**
 * Renders a 'modified' diff block in-context: one structural wrapper
 * (h1-h6, p, or list-item div) containing a single InlineMarkdown parse
 * over a unified string with <ins>/<del> tags wrapping changed tokens.
 * Preserves markdown AST context across token boundaries (bold pairs,
 * links) which per-token rendering would break.
 */
const InlineModifiedBlock: React.FC<InlineModifiedBlockProps> = ({
  tokens,
  wrap,
  index,
  ringClass,
  hoverProps,
}) => {
  const unified = tokens
    .map((t) => {
      if (t.type === "added") return `<ins>${t.value}</ins>`;
      if (t.type === "removed") return `<del>${t.value}</del>`;
      return t.value;
    })
    .join("");

  // Modified blocks rendered inline carry BOTH additions and deletions, so
  // their border/background uses the amber "modified" class — not the green
  // "added" one. Inline <ins>/<del> word highlights render on top unchanged.
  const wrapperBase = `plan-diff-modified transition-shadow ${ringClass}`;
  const { style: hoverStyle, ...hoverRest } = hoverProps;

  if (wrap.type === "heading") {
    const level = wrap.level || 1;
    const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
    return (
      <Tag
        data-diff-block-index={index}
        className={`${headingStyleFor(level)} ${wrapperBase}`}
        style={hoverStyle}
        {...hoverRest}
      >
        <InlineMarkdown text={unified} />
      </Tag>
    );
  }

  if (wrap.type === "list-item") {
    const listLevel = wrap.listLevel || 0;
    const isCheckbox = wrap.checked !== undefined;
    return (
      <div
        data-diff-block-index={index}
        className={`${LIST_ITEM_ROW_CLASS} ${wrapperBase}`}
        style={{ marginLeft: listItemIndentRem(listLevel), ...hoverStyle }}
        {...hoverRest}
      >
        <ListMarker
          level={listLevel}
          ordered={wrap.ordered}
          orderedIndex={wrap.orderedStart ?? 1}
          checked={wrap.checked}
        />
        <span className={listItemTextClass(isCheckbox, wrap.checked)}>
          <InlineMarkdown text={unified} />
        </span>
      </div>
    );
  }

  // paragraph
  return (
    <p
      data-diff-block-index={index}
      className={`${PARAGRAPH_CLASS} ${wrapperBase}`}
      style={hoverStyle}
      {...hoverRest}
    >
      <InlineMarkdown text={unified} />
    </p>
  );
};

// --- Rendering components (unchanged from main) ---

const MarkdownChunk: React.FC<{ content: string }> = ({ content }) => {
  const blocks = React.useMemo(
    () => parseMarkdownToBlocks(content),
    [content]
  );
  // Compute ordered-list display indices across the entire chunk so every
  // list-item gets the right numeral even though we don't group here.
  // Non-list blocks pass through as `null` and act as streak-breaks — same
  // behavior as the main Viewer's per-group counter.
  const orderedIndices = React.useMemo(
    () => computeListIndices(blocks),
    [blocks]
  );

  return (
    <>
      {blocks.map((block, i) => (
        <SimpleBlockRenderer
          key={block.id}
          block={block}
          orderedIndex={orderedIndices[i]}
        />
      ))}
    </>
  );
};

const SimpleBlockRenderer: React.FC<{ block: Block; orderedIndex?: number | null }> = ({ block, orderedIndex }) => {
  switch (block.type) {
    case "heading": {
      const level = block.level || 1;
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      return (
        <Tag className={headingStyleFor(level)}>
          <InlineMarkdown text={block.content} />
        </Tag>
      );
    }

    case "blockquote": {
      // Split on blank-line paragraph breaks so merged `> a\n>\n> b`
      // renders as two <p> children instead of collapsing to one line.
      const paragraphs = block.content.split(/\n\n+/);
      return (
        <blockquote className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic">
          {paragraphs.map((para, i) => (
            <p key={i} className={i > 0 ? "mt-2" : ""}>
              <InlineMarkdown text={para} />
            </p>
          ))}
        </blockquote>
      );
    }

    case "list-item": {
      const listLevel = block.level || 0;
      const isCheckbox = block.checked !== undefined;
      return (
        <div
          className={LIST_ITEM_ROW_CLASS}
          style={{ marginLeft: listItemIndentRem(listLevel) }}
        >
          <ListMarker
            level={listLevel}
            ordered={block.ordered}
            orderedIndex={orderedIndex}
            checked={block.checked}
          />
          <span className={listItemTextClass(isCheckbox, block.checked)}>
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
        <p className={PARAGRAPH_CLASS}>
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

/**
 * Block dangerous link protocols (javascript:, data:, vbscript:, file:) from
 * rendering as clickable anchors in the diff view. Plan content is attacker-
 * influenced (Claude pulls from source comments, READMEs, fetched URLs), so
 * a malicious `[click me](javascript:...)` link embedded in a plan must not
 * render as a live <a>. Mirrors the same guard in Viewer.tsx; returns null
 * for blocked schemes so the caller can render the anchor text as plain
 * text instead of a clickable link.
 */
const DANGEROUS_PROTOCOL = /^\s*(javascript|data|vbscript|file)\s*:/i;
function sanitizeLinkUrl(url: string): string | null {
  if (DANGEROUS_PROTOCOL.test(url)) return null;
  return url;
}

const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  let previousChar = "";

  while (remaining.length > 0) {
    // Plan-diff word markers: <ins>...</ins> and <del>...</del>. These are
    // emitted by PlanCleanDiffView's modified-block renderer when the
    // diff engine populates `inlineTokens`. Content is recursively parsed
    // so inline formatting inside a diff token (e.g., **bold** on an
    // added word) still renders.
    let match = remaining.match(/^<(ins|del)>([\s\S]+?)<\/\1>/);
    if (match) {
      const tag = match[1] as "ins" | "del";
      const className =
        tag === "ins" ? "plan-diff-word-added" : "plan-diff-word-removed";
      if (tag === "ins") {
        parts.push(
          <ins key={key++} className={className}>
            <InlineMarkdown text={match[2]} />
          </ins>
        );
      } else {
        parts.push(
          <del key={key++} className={className}>
            <InlineMarkdown text={match[2]} />
          </del>
        );
      }
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Bold: **text** ([\s\S]+? allows matching across hard line breaks)
    match = remaining.match(/^\*\*([\s\S]+?)\*\*/);
    if (match) {
      parts.push(
        <strong key={key++} className="font-semibold">
          <InlineMarkdown text={match[1]} />
        </strong>
      );
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Italic: *text* or _text_ (avoid intraword underscores)
    match = remaining.match(/^\*([\s\S]+?)\*/);
    if (match) {
      parts.push(<em key={key++}><InlineMarkdown text={match[1]} /></em>);
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    match = !/\w/.test(previousChar)
      ? remaining.match(/^_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)/)
      : null;
    if (match) {
      parts.push(<em key={key++}><InlineMarkdown text={match[1]} /></em>);
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
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
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      // Recursively parse the anchor text so <ins>/<del> diff tags (and
      // other inline markdown) inside the link render correctly instead of
      // showing up as literal HTML tag text. Sanitize the href: dangerous
      // schemes (javascript:, data:, vbscript:, file:) are rendered as
      // plain text instead of a live anchor to block XSS via plan content.
      const safeHref = sanitizeLinkUrl(match[2]);
      if (safeHref === null) {
        parts.push(
          <span key={key++}>
            <InlineMarkdown text={match[1]} />
          </span>
        );
      } else {
        parts.push(
          <a
            key={key++}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            <InlineMarkdown text={match[1]} />
          </a>
        );
      }
      remaining = remaining.slice(match[0].length);
      previousChar = match[0][match[0].length - 1] || previousChar;
      continue;
    }

    // Hard line break: two+ trailing spaces + newline, or backslash + newline
    match = remaining.match(/ {2,}\n|\\\n/);
    if (match && match.index !== undefined) {
      const before = remaining.slice(0, match.index);
      if (before) {
        parts.push(<InlineMarkdown key={key++} text={before} />);
      }
      parts.push(<br key={key++} />);
      remaining = remaining.slice(match.index + match[0].length);
      previousChar = "\n";
      continue;
    }

    // Include '<' so the loop re-enters when an <ins>/<del> tag is next,
    // rather than swallowing it as plain text.
    const nextSpecial = remaining.slice(1).search(/[\*_`\[!<]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      previousChar = remaining[remaining.length - 1] || previousChar;
      break;
    } else {
      const plainText = remaining.slice(0, nextSpecial + 1);
      parts.push(plainText);
      remaining = remaining.slice(nextSpecial + 1);
      previousChar = plainText[plainText.length - 1] || previousChar;
    }
  }

  return <>{parts}</>;
};
