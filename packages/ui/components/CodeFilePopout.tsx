import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { File, type LineAnnotation } from '@pierre/diffs/react';
import type { SelectedLineRange as PierreSelectedLineRange, LineEventBaseProps } from '@pierre/diffs';
import { PopoutDialog } from './PopoutDialog';
import { useTheme } from './ThemeProvider';
import { CommentPopover } from './CommentPopover';
import { ImageThumbnail } from './ImageThumbnail';
import type { CodeAnnotation, ImageAttachment } from '../types';

export interface CodeFileAnnotationInput {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  images?: ImageAttachment[];
  originalCode: string;
}

interface CodeFilePopoutProps {
  open: boolean;
  onClose: () => void;
  filepath: string;
  contents: string;
  prerenderedHTML?: string;
  error?: string;
  requestedPath?: string;
  annotations?: CodeAnnotation[];
  selectedAnnotationId?: string | null;
  onAddAnnotation?: (annotation: CodeFileAnnotationInput) => void;
  onEditAnnotation?: (id: string, updates: Partial<CodeAnnotation>) => void;
  onDeleteAnnotation?: (id: string) => void;
  onSelectAnnotation?: (id: string | null) => void;
  container?: HTMLElement | null;
}

interface PendingComment {
  range: { start: number; end: number };
  contextText: string;
  originalCode: string;
  anchorEl?: HTMLElement;
  anchorRect?: DOMRect;
}

const gutterButtonStyle: React.CSSProperties = {
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1lh',
  height: '1lh',
  fontSize: 'var(--diffs-font-size, 13px)',
  lineHeight: 'var(--diffs-line-height, 20px)',
  border: 'none',
  borderRadius: 4,
  backgroundColor: 'var(--diffs-modified-base)',
  color: 'var(--diffs-bg)',
  cursor: 'pointer',
  position: 'relative',
  zIndex: 4,
  padding: 0,
  marginRight: 'calc(1ch - 1lh)',
};

function getThemeColors(): { bg: string; fg: string } {
  try {
    const styles = getComputedStyle(document.documentElement);
    return {
      bg: styles.getPropertyValue('--background').trim(),
      fg: styles.getPropertyValue('--foreground').trim(),
    };
  } catch {
    return { bg: '', fg: '' };
  }
}

function buildPierreCSS(mode: 'dark' | 'light', bg: string, fg: string): string {
  if (!bg || !fg) return '';
  return `
    :host {
      color-scheme: ${mode};
      height: 100% !important;
    }
    :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
      --diffs-bg: ${bg} !important;
      --diffs-fg: ${fg} !important;
      --diffs-dark-bg: ${bg};
      --diffs-light-bg: ${bg};
      --diffs-dark: ${fg};
      --diffs-light: ${fg};
    }
    pre, code { background-color: ${bg} !important; }
    [data-column-number] { background-color: ${bg} !important; }
    [data-file] { height: 100% !important; }
    [data-code] { height: 100% !important; overflow-y: auto !important; }
    [data-line] { cursor: pointer; }
  `;
}

function getLineSlice(contents: string, start: number, end: number): string {
  return contents
    .split('\n')
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join('\n');
}

function lineLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function getLineNumberFromSelectionNode(node: Node | null): number | null {
  let current: Node | null = node;
  if (current?.nodeType === Node.TEXT_NODE) current = current.parentNode;

  while (current) {
    if (current instanceof HTMLElement) {
      const line = current.closest('[data-line]')?.getAttribute('data-line');
      if (line) {
        const parsed = Number(line);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }
    current = current.parentNode;
  }

  return null;
}

function getPierreSelection(root: HTMLElement | null): Selection | null {
  const shadowRoot = root?.querySelector('diffs-container')?.shadowRoot;
  const shadowSelection = (shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null)
    ?.getSelection?.();
  return shadowSelection && !shadowSelection.isCollapsed
    ? shadowSelection
    : window.getSelection();
}

const CodeInlineAnnotation: React.FC<{
  annotation: CodeAnnotation;
  isSelected: boolean;
  onSelect?: (id: string | null) => void;
  onEdit?: (id: string, updates: Partial<CodeAnnotation>) => void;
  onDelete?: (id: string) => void;
}> = ({ annotation, isSelected, onSelect, onEdit, onDelete }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(annotation.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isEditing) setEditText(annotation.text ?? '');
  }, [annotation.text, isEditing]);

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [isEditing]);

  const save = () => {
    onEdit?.(annotation.id, { text: editText });
    setIsEditing(false);
  };

  return (
    <div
      data-code-annotation-id={annotation.id}
      onClick={() => onSelect?.(annotation.id)}
      className={`group my-2 mx-3 rounded-lg border px-3 py-2 text-xs shadow-sm cursor-pointer transition-colors ${
        isSelected ? 'border-primary/50' : 'border-border hover:border-border/80'
      }`}
      style={{
        backgroundColor: isSelected ? 'color-mix(in oklab, var(--primary) 12%, var(--popover))' : 'var(--popover)',
        color: 'var(--foreground)',
        opacity: 1,
      }}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold text-primary">Comment</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono normal-case text-foreground">
          {lineLabel(annotation.lineStart, annotation.lineEnd)}
        </span>
        {annotation.author && <span className="truncate normal-case">by {annotation.author}</span>}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {onEdit && !isEditing && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Edit comment"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(annotation.id);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Delete comment"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {isEditing ? (
        <div className="mt-2 space-y-2">
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setIsEditing(false);
                setEditText(annotation.text ?? '');
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
            rows={Math.min(editText.split('\n').length + 1, 8)}
            className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                save();
              }}
              className="rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90"
            >
              Save
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(false);
                setEditText(annotation.text ?? '');
              }}
              className="rounded bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        annotation.text && (
          <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-primary/50 pl-2 text-foreground/90">
            {annotation.text}
          </div>
        )
      )}

      {annotation.images && annotation.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {annotation.images.map((img) => (
            <div key={img.path} className="text-center">
              <ImageThumbnail path={img.path} size="sm" showRemove={false} />
              <div className="max-w-[3rem] truncate text-[9px] text-muted-foreground" title={img.name}>
                {img.name}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const CodeFilePopout: React.FC<CodeFilePopoutProps> = ({
  open,
  onClose,
  filepath,
  contents,
  prerenderedHTML,
  error,
  requestedPath,
  annotations = [],
  selectedAnnotationId,
  onAddAnnotation,
  onEditAnnotation,
  onDeleteAnnotation,
  onSelectAnnotation,
  container,
}) => {
  const { resolvedMode } = useTheme();
  const mode = resolvedMode ?? 'dark';
  const colors = getThemeColors();
  const [pierreTheme, setPierreTheme] = useState(() => ({
    type: mode as 'dark' | 'light',
    css: buildPierreCSS(mode, colors.bg, colors.fg),
  }));
  const [copied, setCopied] = useState(false);
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const lastPointerRectRef = useRef<DOMRect | null>(null);
  const suppressLineClickUntilRef = useRef(0);

  useEffect(() => {
    requestAnimationFrame(() => {
      const c = getThemeColors();
      setPierreTheme({
        type: mode,
        css: buildPierreCSS(mode, c.bg, c.fg),
      });
    });
  }, [mode]);

  useEffect(() => {
    setPendingComment(null);
  }, [filepath]);

  const displayName = filepath.split('/').pop() || filepath;
  const relativePath = filepath.replace(/.*\/(?=.*\/)/, '');
  const lineCount = useMemo(() => contents.split('\n').length, [contents]);
  const selectedCodeAnnotation = useMemo(
    () => annotations.find((ann) => ann.id === selectedAnnotationId),
    [annotations, selectedAnnotationId],
  );

  // TODO: add token-level annotation support (charStart/charEnd) — for now only line-scope
  const lineAnnotations = useMemo((): LineAnnotation<CodeAnnotation>[] => {
    return annotations
      .filter((ann) => (ann.scope ?? 'line') === 'line')
      .map((ann) => ({
        lineNumber: ann.lineEnd,
        metadata: ann,
      }));
  }, [annotations]);

  const selectedLines = useMemo((): PierreSelectedLineRange | null => {
    if (pendingComment) {
      return { start: pendingComment.range.start, end: pendingComment.range.end };
    }
    if (selectedCodeAnnotation) {
      return { start: selectedCodeAnnotation.lineStart, end: selectedCodeAnnotation.lineEnd };
    }
    return null;
  }, [pendingComment, selectedCodeAnnotation]);
  const effectivePrerenderedHTML = lineAnnotations.length === 0 ? prerenderedHTML : undefined;

  useEffect(() => {
    if (!selectedAnnotationId || !fileAreaRef.current) return;
    const timer = setTimeout(() => {
      fileAreaRef.current
        ?.querySelector(`[data-code-annotation-id="${selectedAnnotationId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedAnnotationId, filepath]);

  const openCommentForRange = useCallback((
    range: { start: number; end: number },
    anchorEl?: HTMLElement,
    anchorRect?: DOMRect,
  ) => {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setPendingComment({
      range: { start, end },
      anchorEl,
      anchorRect: anchorRect ?? anchorEl?.getBoundingClientRect() ?? lastPointerRectRef.current ?? undefined,
      contextText: `${relativePath} ${lineLabel(start, end)}`,
      originalCode: getLineSlice(contents, start, end),
    });
  }, [contents, relativePath]);

  const openCommentForBrowserSelection = useCallback(() => {
    if (!onAddAnnotation) return;

    const selection = getPierreSelection(fileAreaRef.current);
    const selectedText = selection?.toString();
    if (!selection || selection.isCollapsed || !selectedText?.trim()) return;

    const anchorLine = getLineNumberFromSelectionNode(selection.anchorNode);
    const focusLine = getLineNumberFromSelectionNode(selection.focusNode);
    if (anchorLine == null || focusLine == null) return;

    openCommentForRange(
      { start: anchorLine, end: focusLine },
      undefined,
      lastPointerRectRef.current
        ?? (selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : undefined),
    );
    selection.removeAllRanges();
  }, [onAddAnnotation, openCommentForRange]);

  const renderAnnotation = useCallback((annotation: LineAnnotation<CodeAnnotation>) => {
    if (!annotation.metadata) return null;
    return (
      <CodeInlineAnnotation
        annotation={annotation.metadata}
        isSelected={selectedAnnotationId === annotation.metadata.id}
        onSelect={onSelectAnnotation}
        onEdit={onEditAnnotation}
        onDelete={onDeleteAnnotation}
      />
    );
  }, [onDeleteAnnotation, onEditAnnotation, onSelectAnnotation, selectedAnnotationId]);

  const renderGutterUtility = useCallback((getHoveredLine: () => { lineNumber: number } | undefined) => {
    return (
      <button
        type="button"
        style={gutterButtonStyle}
        title="Add code comment"
        onMouseEnter={(e) => {
          e.currentTarget.style.filter = 'brightness(1.2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.filter = '';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const line = getHoveredLine();
          if (!line) return;
          openCommentForRange({ start: line.lineNumber, end: line.lineNumber }, e.currentTarget);
        }}
      >
        +
      </button>
    );
  }, [openCommentForRange]);

  const handleLineSelectionEnd = useCallback((range: PierreSelectedLineRange | null) => {
    if (!onAddAnnotation) return;
    if (!range) return;
    if (range.start !== range.end) {
      suppressLineClickUntilRef.current = Date.now() + 300;
    }
    openCommentForRange({ start: range.start, end: range.end }, undefined, lastPointerRectRef.current ?? undefined);
  }, [onAddAnnotation, openCommentForRange]);

  const handleLineClick = useCallback((props: LineEventBaseProps & { event: PointerEvent }) => {
    if (!onAddAnnotation) return;
    if (Date.now() < suppressLineClickUntilRef.current) return;
    openCommentForRange(
      { start: props.lineNumber, end: props.lineNumber },
      undefined,
      props.lineElement.getBoundingClientRect(),
    );
  }, [onAddAnnotation, openCommentForRange]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (error) {
    // The server's error string distinguishes "File not found", "Ambiguous
    // path '…'", and other failures (e.g. permission). Earlier this dialog
    // hardcoded "File not found in repo" regardless of cause, which was
    // misleading when an optimistic-link click hit an ambiguous response
    // before validation completed.
    const isNotFound = /^file not found/i.test(error);
    return (
      <PopoutDialog
        open={open}
        onClose={onClose}
        title={requestedPath ?? displayName}
        container={container}
        className="w-[min(520px,calc(100vw-4rem))]"
      >
        <div className="flex flex-col gap-2 px-5 py-6 text-sm">
          <div className="font-medium text-foreground">{error}</div>
          <code className="text-xs font-mono text-muted-foreground break-all">
            {requestedPath ?? filepath}
          </code>
          {isNotFound && (
            <p className="text-xs text-muted-foreground mt-1">
              The path was referenced in the document but no matching file was found
              in this project. It may describe a planned/future file.
            </p>
          )}
        </div>
      </PopoutDialog>
    );
  }

  return (
    <PopoutDialog
      open={open}
      onClose={onClose}
      title={displayName}
      container={container}
      className="w-[calc(100vw-4rem)] max-w-[min(calc(100vw-4rem),1500px)] h-[calc(100vh-4rem)]"
    >
      <div className="flex items-center gap-3 px-5 pt-4 pb-3 pr-12">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-4 h-4 flex-shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <span className="text-sm font-medium text-foreground truncate" title={filepath}>
            {relativePath}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {lineCount} lines
          </span>
          <button
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy file contents'}
            className={`p-1.5 rounded-md transition-colors ${
              copied ? 'text-success' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {copied ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="border-t border-border/30" />
      <div
        ref={fileAreaRef}
        className="flex-1 min-h-0"
        onPointerMove={(e) => {
          lastPointerRectRef.current = new DOMRect(e.clientX, e.clientY, 0, 0);
        }}
        onMouseUp={() => {
          requestAnimationFrame(openCommentForBrowserSelection);
        }}
      >
        <File
          key={filepath}
          file={{ name: displayName, contents }}
          prerenderedHTML={effectivePrerenderedHTML}
          className="h-full"
          lineAnnotations={lineAnnotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
          style={{
            '--diffs-dark-bg': colors.bg,
            '--diffs-light-bg': colors.bg,
            '--diffs-dark': colors.fg,
            '--diffs-light': colors.fg,
          } as React.CSSProperties}
          options={{
            themeType: pierreTheme.type,
            unsafeCSS: pierreTheme.css,
            overflow: 'scroll',
            disableFileHeader: true,
            enableLineSelection: true,
            enableGutterUtility: !!onAddAnnotation,
            lineHoverHighlight: onAddAnnotation ? 'line' : 'disabled',
            onLineClick: handleLineClick,
            onLineSelectionEnd: handleLineSelectionEnd,
          }}
        />
      </div>
      {pendingComment && onAddAnnotation && (
        <CommentPopover
          anchorEl={pendingComment.anchorEl}
          anchorRect={pendingComment.anchorRect}
          contextText={pendingComment.contextText}
          isGlobal={false}
          onSubmit={(text, images) => {
            onAddAnnotation({
              filePath: filepath,
              lineStart: pendingComment.range.start,
              lineEnd: pendingComment.range.end,
              text,
              images,
              originalCode: pendingComment.originalCode,
            });
            setPendingComment(null);
          }}
          onClose={() => setPendingComment(null)}
        />
      )}
    </PopoutDialog>
  );
};
