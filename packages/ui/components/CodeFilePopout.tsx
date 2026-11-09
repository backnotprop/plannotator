import React, { useState, useEffect, useId, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { File, type LineAnnotation } from '@pierre/diffs/react';
import type { SelectedLineRange as PierreSelectedLineRange, LineEventBaseProps } from '@pierre/diffs';
import { normalizeBrowserPath } from '@plannotator/core/browser-paths';
import { basenameFromPath } from '@plannotator/core/source-save';
import { PopoutDialog } from './PopoutDialog';
import { isCommentSubmitKey } from '../utils/commentSubmitKey';
import { useConfigValue } from '../config/useConfig';
import { extendThemeSwitch, useTheme } from './ThemeProvider';
import { CommentPopover, type CommentExtraAction } from './CommentPopover';
import { ImageThumbnail } from './ImageThumbnail';
import type { CodeAnnotation, ImageAttachment } from '../types';
import { copyTextToClipboard } from '../utils/clipboard';
import { scrollCodeLineIntoView, whenCodeLineRendered } from '../utils/codeLineScroll';
import { hashDraftScope } from '../utils/draftScopeHash';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

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
  line?: number;
  lineEnd?: number;
  /** Changes on every open, so reopening the same file:line scrolls to it again. */
  revealKey?: number;
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
  /** A host's control in the header, before the line count (Shape's "open in"). */
  headerAction?: React.ReactNode;
}

interface PendingComment {
  range: { start: number; end: number };
  contextText: string;
  originalCode: string;
  /** The composer's kept-draft key: this file (its path and a hash of its contents) and these lines. */
  draftKey: string;
  anchorEl?: HTMLElement;
  anchorRect?: DOMRect;
  /** The words it opens with: a comment the host kept and put back (`reopenComment`). */
  initialText?: string;
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
    [data-code] { height: 100% !important; overflow-y: auto !important; align-content: start; }
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
  plain?: boolean;
  /** In a fold (`commentMarkers="bubble"`), where an X would read as "close": delete is a bin. */
  inFold?: boolean;
  /** In a fold: a Hide control beside edit and delete folds the comments back. */
  onHide?: () => void;
  /** An edit the host kept and put back (`CodeFileViewProps.reopenEdit`): for this card, its edit box opens holding those words. */
  reopenEdit?: { id: string; text: string } | null;
}> = ({ annotation, isSelected, onSelect, onEdit, onDelete, plain = false, inFold = false, onHide, reopenEdit }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(annotation.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const reopenedRef = useRef<{ id: string; text: string } | null>(null);
  const caretAtEndRef = useRef(false);

  useEffect(() => {
    if (!isEditing) setEditText(annotation.text ?? '');
  }, [annotation.text, isEditing]);

  // Each put-back edit opens once, on its own card.
  useEffect(() => {
    if (!reopenEdit || !onEdit || reopenEdit.id !== annotation.id || reopenedRef.current === reopenEdit) return;
    reopenedRef.current = reopenEdit;
    caretAtEndRef.current = true;
    setEditText(reopenEdit.text);
    setIsEditing(true);
  }, [annotation.id, onEdit, reopenEdit]);

  useEffect(() => {
    if (isEditing) {
      const area = textareaRef.current;
      area?.focus();
      // Words put back: the caret after them (selecting them would let one key replace them all).
      if (caretAtEndRef.current && area) area.setSelectionRange(area.value.length, area.value.length);
      else area?.select();
      caretAtEndRef.current = false;
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
      className={plain
        ? `group my-2 mx-3 rounded-lg border px-3 py-2.5 font-sans text-[length:var(--ib-fs-13,13px)] leading-normal cursor-pointer shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_10px_rgb(0_0_0/0.04)] ${
            isSelected ? 'border-primary/60' : 'border-border hover:border-muted-foreground/50'
          }`
        : `group my-2 mx-3 rounded-lg border px-3 py-2 text-xs shadow-sm cursor-pointer transition-colors ${
            isSelected ? 'border-primary/50' : 'border-border hover:border-border/80'
          }`}
      style={{
        backgroundColor: isSelected ? 'color-mix(in oklab, var(--primary) 12%, var(--popover))' : 'var(--popover)',
        color: 'var(--foreground)',
        opacity: 1,
      }}
    >
      <div className={`flex items-center gap-2 text-muted-foreground ${plain ? 'text-[length:var(--ib-fs-11,11px)]' : 'text-[10px] uppercase tracking-wide'}`}>
        <span className={plain ? 'font-medium text-foreground/80' : 'font-semibold text-primary'}>Comment</span>
        <span className={plain ? 'tabular-nums' : 'rounded bg-muted px-1.5 py-0.5 font-mono normal-case text-foreground'}>
          {lineLabel(annotation.lineStart, annotation.lineEnd)}
        </span>
        {annotation.author && <span className="truncate normal-case">by <bdi>{annotation.author}</bdi></span>}
        {annotation.outsideDiff && (
          <span
            className="rounded px-1.5 py-0.5 normal-case font-medium"
            style={{ background: 'color-mix(in oklab, var(--warning) 18%, transparent)', color: 'var(--warning)' }}
            data-code-annotation-outside-diff=""
            title="A comment on lines outside the diff"
          >
            not in the diff
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
              aria-label="Delete comment"
            >
              {inFold ? (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3" />
                </svg>
              ) : (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </button>
          )}
        </div>
        {onHide && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHide();
            }}
            className="-my-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Hide comment"
            aria-label="Hide comment"
            data-code-comment-hide=""
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 15l6-6 6 6" />
            </svg>
          </button>
        )}
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
              } else if (isCommentSubmitKey(e, enterSavesComment)) {
                e.preventDefault();
                save();
              }
            }}
            rows={Math.min(editText.split('\n').length + 1, 8)}
            className={`w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 ${plain ? 'text-[length:var(--ib-fs-13,13px)]' : 'text-xs'}`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                save();
              }}
              className={`rounded bg-primary px-2 py-1 font-medium text-primary-foreground hover:opacity-90 ${plain ? 'text-[length:var(--ib-fs-12,12px)]' : 'text-[10px]'}`}
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
              className={`rounded bg-muted px-2 py-1 font-medium text-muted-foreground hover:bg-muted/80 ${plain ? 'text-[length:var(--ib-fs-12,12px)]' : 'text-[10px]'}`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        annotation.text && (
          <div className={`mt-1.5 whitespace-pre-wrap text-foreground/90 ${plain ? '[overflow-wrap:anywhere]' : 'border-l-2 border-primary/50 pl-2'}`}>
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

/** Whether an event started inside a comment fold (across Pierre's shadow root). */
function isInFold(event: Event): boolean {
  return event.composedPath().some((el) => el instanceof HTMLElement && el.hasAttribute('data-code-comment-fold'));
}

/** How long a fold takes to open or close. */
const FOLD_MS = 220;

/** The fold's motion: a strong ease-out, so it answers the click at once and settles softly. Inline, because the
 *  theme's global `*` transition (unlayered) wins over a Tailwind transition utility. */
const FOLD_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const FOLD_TRANSITION = `height ${FOLD_MS}ms ${FOLD_EASE}, opacity 180ms ${FOLD_EASE}`;

/**
 * Which lines' folds are open. Kept outside React state on purpose: a change of
 * CodeFileView's state redraws Pierre's whole shadow DOM (a new `file` object
 * each render), which re-slots every annotation and cuts the fold's animation
 * short. Only the folds subscribe, so a click moves just the one fold.
 */
interface FoldStore {
  isOpen: (line: number) => boolean;
  set: (next: ReadonlySet<number>) => void;
  get: () => ReadonlySet<number>;
  subscribe: (listener: () => void) => () => void;
}

function createFoldStore(): FoldStore {
  let open: ReadonlySet<number> = new Set();
  const listeners = new Set<() => void>();
  return {
    isOpen: (line) => open.has(line),
    get: () => open,
    set: (next) => {
      open = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One line's saved comments behind a bubble (`commentMarkers="bubble"`): the
 * bubble sits in the gutter beside the line's number, and a click opens the
 * comments in a row under the line, pushing the lines below down, never over
 * them. Drawn in Pierre's annotation row for the line; the row is kept as tall
 * as the fold (FOLD_ROW_CSS) and the fold animates its own height.
 */
const CodeCommentFold: React.FC<{
  line: number;
  annotations: CodeAnnotation[];
  store: FoldStore;
  onToggle: (line: number) => void;
  selectedAnnotationId?: string | null;
  onSelect?: (id: string | null) => void;
  onEdit?: (id: string, updates: Partial<CodeAnnotation>) => void;
  onDelete?: (id: string) => void;
  /** Before the line's last comment goes (the fold goes with it): where keyboard focus lands instead. */
  onLastDelete?: (line: number) => void;
  plain: boolean;
  /** An edit put back (`CodeFileViewProps.reopenEdit`), for whichever of this line's cards it names. */
  reopenEdit?: { id: string; text: string } | null;
}> = ({ line, annotations, store, onToggle, selectedAnnotationId, onSelect, onEdit, onDelete, onLastDelete, plain, reopenEdit }) => {
  const open = useSyncExternalStore(store.subscribe, () => store.isOpen(line), () => store.isOpen(line));
  const innerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const revealId = useId();
  const [height, setHeight] = useState(0);
  // No motion on the first frame: a fold that mounts open (a comment chosen in
  // the panel, a link to it) is simply there.
  const [animate, setAnimate] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  // The height eases only while the fold opens or closes; open and still, it follows the card at once (an edit's
  // textarea growing never lags behind a clip).
  const [moving, setMoving] = useState(false);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    setMoving(true);
  }
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setMoving(false), FOLD_MS + 60);
    return () => clearTimeout(timer);
  }, [moving, open]);
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    setHeight(inner.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(inner.offsetHeight));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const count = annotations.length;
  const where = annotations.length === 1 && annotations[0].lineStart !== annotations[0].lineEnd
    ? lineLabel(annotations[0].lineStart, annotations[0].lineEnd)
    : `line ${line}`;
  const toggle = () => onToggle(line);
  // Hide and a delete sit in the part that folds away (inert once closed): keyboard focus goes to the bubble, not to
  // the page.
  const hide = () => {
    toggle();
    bubbleRef.current?.focus({ preventScroll: true });
  };
  const remove = onDelete
    ? (id: string) => {
        if (annotations.length > 1) bubbleRef.current?.focus({ preventScroll: true });
        else onLastDelete?.(line);
        onDelete(id);
      }
    : undefined;
  return (
    <div className="relative" data-code-comment-fold={line}>
      <button
        ref={bubbleRef}
        type="button"
        data-code-comment-bubble={line}
        aria-expanded={open}
        aria-controls={revealId}
        aria-label={`${count === 1 ? 'Comment' : `${count} comments`} on ${where}`}
        title={open ? 'Hide comment' : count === 1 ? 'Show comment' : `Show ${count} comments`}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        // A phone's finger needs 44 px: the drawing keeps its size and an invisible 44 × 44 area takes the tap, inside
        // the gutter's room left of the numbers (FOLD_GUTTER_CSS), so a number's tap still chooses its line.
        className={`absolute z-[5] flex items-center justify-center gap-0.5 rounded-md px-1 font-sans text-[length:var(--ib-fs-10,10px)] font-semibold tabular-nums leading-none transition-colors duration-150 before:absolute before:content-[''] [@media(pointer:coarse)]:before:-inset-y-[13px] [@media(pointer:coarse)]:before:-left-1 [@media(pointer:coarse)]:before:-right-5 ${
          open
            ? 'bg-primary text-primary-foreground'
            : 'bg-primary/15 text-primary hover:bg-primary/25'
        }`}
        style={{
          // Line `line`'s band (the row this fold draws in starts right under it), at the gutter's left edge.
          bottom: 'calc(100% + (var(--diffs-line-height, 20px) - 18px) / 2)',
          left: 'calc(var(--diffs-column-number-width, 40px) * -1 + 4px)',
          height: 18,
          minWidth: 20,
        }}
      >
        <svg className="h-3 w-3 flex-none" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M5 4h14a2 2 0 012 2v9a2 2 0 01-2 2h-7l-4.5 3.6A.5.5 0 016.7 20.2V17H5a2 2 0 01-2-2V6a2 2 0 012-2z" />
        </svg>
        {count > 1 && <span>{count}</span>}
      </button>
      <div
        id={revealId}
        data-code-comment-reveal=""
        data-open={open ? '' : undefined}
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
        className="overflow-clip"
        style={{ height: open ? height : 0, opacity: open ? 1 : 0, transition: moving && animate && !reducedMotion ? FOLD_TRANSITION : 'none' }}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === 'height') setMoving(false);
        }}
      >
        <div ref={innerRef} className="flow-root">
          {annotations.map((annotation, index) => (
            <CodeInlineAnnotation
              key={annotation.id}
              annotation={annotation}
              isSelected={selectedAnnotationId === annotation.id}
              onSelect={onSelect}
              onEdit={onEdit}
              onDelete={remove}
              plain={plain}
              reopenEdit={reopenEdit}
              inFold
              // One Hide per fold, on its first card.
              onHide={index === 0 ? hide : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

/**
 * `commentMarkers="bubble"`'s rules inside the file's shadow root. In a pane of
 * fixed height Pierre's grid gives an annotation row no height of its own (the
 * card then covers the next lines); `height: max-content` keeps the row exactly
 * as tall as its fold. The row paints above the gutter (a grid item's z-index
 * makes its own layer) so the bubble can sit there, and the line numbers make
 * room for it (and for its 44 px tap area on a phone) whenever the file can
 * have comments, so the code never shifts when the first comment comes or the
 * last one goes.
 */
const FOLD_ROW_CSS = `
    [data-line-annotation] { height: max-content; z-index: 4; }
`;
const FOLD_GUTTER_CSS = `
    [data-column-number] { padding-left: calc(2ch + 20px); }
    @media (pointer: coarse) { [data-column-number] { padding-left: calc(2ch + 30px); } }
`;

export interface CodeFileViewProps {
  filepath: string;
  contents: string;
  line?: number;
  lineEnd?: number;
  /** Changes on every open, so reopening the same file:line scrolls to it again. */
  revealKey?: number;
  prerenderedHTML?: string;
  annotations?: CodeAnnotation[];
  selectedAnnotationId?: string | null;
  onAddAnnotation?: (annotation: CodeFileAnnotationInput) => void;
  /** Opt-in: an Ask action in the line composer, beside Save (Shape's "Ask"). Absent → Save only, as always. */
  onAskAnnotation?: (annotation: CodeFileAnnotationInput) => void;
  /** Opt-in: the line composer's labels (Shape: "Change it" / "Ask"). Absent → "Save" / "Ask AI". */
  commentSubmitLabel?: string;
  commentAskLabel?: string;
  /** The comment box's third action (Shape's Show me): these lines, and the words typed. */
  commentExtraAction?: (lines: { filePath: string; lineStart: number; lineEnd: number; originalCode: string }) => CommentExtraAction | undefined;
  onEditAnnotation?: (id: string, updates: Partial<CodeAnnotation>) => void;
  onDeleteAnnotation?: (id: string) => void;
  onSelectAnnotation?: (id: string | null) => void;
  /** Whether the comment composer offers image attachments. Default true (the popout's behavior). */
  allowImages?: boolean;
  /** The file area's class. Default: fills the rest of a flex column. */
  className?: string;
  /** The highlighting language, instead of Pierre's inference from the name (`'text'`: no highlighting, for a very large file). */
  lang?: string;
  /** Long lines: `'scroll'` sideways (the default) or `'wrap'` onto the next row, for a minified file. */
  overflow?: 'scroll' | 'wrap';
  /** CSS added inside the file's shadow root after the theme (a host's line
   *  marks, e.g. code review's change bars on `[data-column-number="12"]`). */
  extraCss?: string;
  /** Scroll this line to the middle and mark it, once per `token` (a jump to
   *  a definition, a reference or a line). */
  revealLine?: { line: number; token: number };
  /** Opt-in (the Inbox's file panes): `'vertical'` scrolls to a referenced or revealed line up and down only, never
   *  sliding a long row sideways, even in a short file (`scrollCodeLineIntoView`). Absent: exactly as before. */
  lineScroll?: 'vertical';
  /** Opt-in (the Inbox's file panes): `'plain'` draws a saved comment's card with its words as plain text (no
   *  left bar, which reads as a quote) and a sentence-case "Comment" label. Absent: exactly as before. */
  commentCard?: 'plain';
  /** Opt-in (the Inbox's file panes): `'bubble'` folds each line's saved comments behind a bubble in the gutter of
   *  the comment's last line (one bubble per line, with a count when there are several). A click on the bubble
   *  opens them in a row under the line, pushing the lines below down (never over the code), with a short
   *  ease-out (none under reduced motion); a second click, or the card's Hide, folds them. Choosing a comment
   *  (`selectedAnnotationId`) opens its fold. Absent: every comment is drawn open under its line, as before. */
  commentMarkers?: 'bubble';
  /** The token under the pointer (`enter` / `leave`) and the last one clicked
   *  (`click`): a host's "go to definition" looks there. Turning it on wraps
   *  the file's tokens (Pierre's token transformer). */
  onTokenTarget?: (kind: 'enter' | 'leave' | 'click', target: CodeFileTokenTarget) => void;
  /** Cmd/Ctrl-click (or Alt-click) on a token: a host's references. */
  onTokenNavigate?: (target: CodeFileTokenTarget) => void;
  /**
   * Opt-in: a line comment being written that the host kept (its file
   * closed) and puts back. Each new object opens the line composer once on
   * those lines, holding those words, when Pierre has drawn the first line.
   * Nothing is saved until the person saves. Absent: nothing changes.
   */
  reopenComment?: { lineStart: number; lineEnd: number; text: string } | null;
  /**
   * Opt-in: an edit of a saved comment that the host kept and puts back. Each
   * new object opens that inline comment's edit box once, holding those
   * words (not saved). Absent: nothing changes.
   */
  reopenEdit?: { id: string; text: string } | null;
  /**
   * Opt-in: told which lines the line comment being written is on as its
   * composer opens, and null as it closes, so a host can keep its words
   * (read from the box) if the view is taken away. Absent: nothing changes.
   */
  onComposerLines?: (lines: { lineStart: number; lineEnd: number; originalCode: string } | null) => void;
}

/** A token of a file drawn by `CodeFileView` (Pierre's token event, file mode). */
export interface CodeFileTokenTarget {
  tokenText: string;
  tokenElement: HTMLElement;
  lineNumber: number;
  lineCharStart: number;
}

/**
 * One code file drawn by Pierre's `File`, with line and range comments: the
 * gutter `+`, a click on a line, a dragged range or a text selection opens
 * the comment composer, and saved comments render inline under their lines.
 * The body of `CodeFilePopout`, usable on its own (the Inbox's file pane).
 */
export const CodeFileView: React.FC<CodeFileViewProps> = ({
  filepath,
  contents,
  line,
  lineEnd,
  revealKey,
  prerenderedHTML,
  annotations = [],
  selectedAnnotationId,
  onAddAnnotation,
  onAskAnnotation,
  commentSubmitLabel,
  commentAskLabel,
  commentExtraAction,
  onEditAnnotation,
  onDeleteAnnotation,
  onSelectAnnotation,
  allowImages = true,
  className = 'flex-1 min-h-0',
  lang,
  overflow = 'scroll',
  extraCss,
  revealLine,
  lineScroll,
  commentCard,
  commentMarkers,
  onTokenTarget,
  onTokenNavigate,
  reopenComment,
  reopenEdit,
  onComposerLines,
}) => {
  const { resolvedMode } = useTheme();
  const mode = resolvedMode ?? 'dark';
  const colors = getThemeColors();
  const [pierreTheme, setPierreTheme] = useState(() => ({
    type: mode as 'dark' | 'light',
    css: buildPierreCSS(mode, colors.bg, colors.fg),
  }));
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const onComposerLinesRef = useRef(onComposerLines);
  onComposerLinesRef.current = onComposerLines;
  useEffect(() => {
    onComposerLinesRef.current?.(
      pendingComment
        ? { lineStart: pendingComment.range.start, lineEnd: pendingComment.range.end, originalCode: pendingComment.originalCode }
        : null,
    );
  }, [pendingComment]);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const lastPointerRectRef = useRef<DOMRect | null>(null);
  const suppressLineClickUntilRef = useRef(0);

  useEffect(() => {
    requestAnimationFrame(() => {
      const c = getThemeColors();
      // A frame after a theme switch: keep the switch's no-fade hold over this redraw too.
      extendThemeSwitch();
      setPierreTheme({
        type: mode,
        css: buildPierreCSS(mode, c.bg, c.fg),
      });
    });
  }, [mode]);

  useEffect(() => {
    setPendingComment(null);
  }, [filepath]);

  const displayName = basenameFromPath(filepath);
  const relativePath = normalizeBrowserPath(filepath).replace(/.*\/(?=.*\/)/, '');
  const selectedCodeAnnotation = useMemo(
    () => annotations.find((ann) => ann.id === selectedAnnotationId),
    [annotations, selectedAnnotationId],
  );

  // TODO: add token-level annotation support (charStart/charEnd) — for now only line-scope
  const folds = commentMarkers === 'bubble';
  // Each annotation its own row, as always; in folds, one row per last line.
  const lineAnnotations = useMemo((): LineAnnotation<CodeAnnotation[]>[] => {
    const lineScoped = annotations.filter((ann) => (ann.scope ?? 'line') === 'line');
    if (!folds) return lineScoped.map((ann) => ({ lineNumber: ann.lineEnd, metadata: [ann] }));
    const byLine = new Map<number, CodeAnnotation[]>();
    for (const ann of lineScoped) byLine.set(ann.lineEnd, [...(byLine.get(ann.lineEnd) ?? []), ann]);
    return [...byLine].map(([lineNumber, group]) => ({ lineNumber, metadata: group }));
  }, [annotations, folds]);

  // The lines whose folds are open. Choosing a comment (the panel, a link to it, a save) opens its fold.
  const foldStore = useMemo(createFoldStore, []);
  const openFold = useCallback((lines: number[]) => {
    const prev = foldStore.get();
    if (lines.every((l) => prev.has(l))) return;
    foldStore.set(new Set([...prev, ...lines]));
  }, [foldStore]);
  // Letting go of a folded comment waits for the fold to close; a file switch or unmount cancels it.
  const deselectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDeselect = useCallback(() => {
    if (deselectTimerRef.current != null) clearTimeout(deselectTimerRef.current);
    deselectTimerRef.current = null;
  }, []);
  useEffect(() => {
    foldStore.set(new Set());
    return cancelDeselect;
  }, [filepath, foldStore, cancelDeselect]);
  const selectedFoldLine = folds ? selectedCodeAnnotation?.lineEnd : undefined;
  useEffect(() => {
    if (selectedFoldLine != null) openFold([selectedFoldLine]);
  }, [selectedFoldLine, selectedAnnotationId, openFold]);
  // An edit put back opens its comment's fold, so its edit box is in sight.
  const reopenFoldLine = folds && reopenEdit ? annotations.find((ann) => ann.id === reopenEdit.id)?.lineEnd : undefined;
  useEffect(() => {
    if (reopenFoldLine != null) openFold([reopenFoldLine]);
  }, [reopenFoldLine, reopenEdit, openFold]);
  const selectedFoldLineRef = useRef(selectedFoldLine);
  selectedFoldLineRef.current = selectedFoldLine;
  const onSelectAnnotationRef = useRef(onSelectAnnotation);
  onSelectAnnotationRef.current = onSelectAnnotation;
  const toggleFold = useCallback((foldLine: number) => {
    const next = new Set(foldStore.get());
    if (next.has(foldLine)) {
      next.delete(foldLine);
      // Folding a chosen comment away lets go of it, so its lines lose the mark: after the fold has closed, since
      // the host's redraw redraws Pierre's rows.
      if (selectedFoldLineRef.current === foldLine) {
        cancelDeselect();
        deselectTimerRef.current = setTimeout(() => {
          deselectTimerRef.current = null;
          if (selectedFoldLineRef.current === foldLine && !foldStore.isOpen(foldLine)) onSelectAnnotationRef.current?.(null);
        }, FOLD_MS);
      }
    } else {
      next.add(foldLine);
    }
    foldStore.set(next);
  }, [foldStore, cancelDeselect]);
  // A line's last comment takes its fold and bubble with it: once it is gone, keyboard focus (left on the page by
  // then) moves to the nearest other bubble, or to the file. A delete still in flight, or refused, moves nothing.
  const focusAfterDeleteRef = useRef<number | null>(null);
  const focusAfterLastDelete = useCallback((foldLine: number) => {
    focusAfterDeleteRef.current = foldLine;
  }, []);
  useLayoutEffect(() => {
    const foldLine = focusAfterDeleteRef.current;
    const area = fileAreaRef.current;
    if (foldLine == null || !area) return;
    if (area.querySelector(`[data-code-comment-bubble="${foldLine}"]`)) return;
    focusAfterDeleteRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const bubbles = [...area.querySelectorAll<HTMLElement>('[data-code-comment-bubble]')];
    const next = bubbles.find((el) => Number(el.getAttribute('data-code-comment-bubble')) > foldLine) ?? bubbles[bubbles.length - 1];
    (next ?? area).focus({ preventScroll: true });
  }, [lineAnnotations]);

  // The line a host jumped to stays marked until a comment or a selection
  // takes the mark (or the next jump moves it).
  const [revealedLine, setRevealedLine] = useState<number | null>(null);
  const selectedLines = useMemo((): PierreSelectedLineRange | null => {
    if (pendingComment) {
      return { start: pendingComment.range.start, end: pendingComment.range.end };
    }
    if (selectedCodeAnnotation) {
      return { start: selectedCodeAnnotation.lineStart, end: selectedCodeAnnotation.lineEnd };
    }
    // A jump (Go to Definition, a reference) marks its line until a comment
    // or a selection takes the mark; otherwise the host's line, if any.
    if (revealedLine != null) return { start: revealedLine, end: revealedLine };
    if (line != null) {
      return { start: line, end: lineEnd ?? line };
    }
    return null;
  }, [pendingComment, selectedCodeAnnotation, revealedLine, line, lineEnd]);

  useEffect(() => {
    if (!revealLine) return;
    setRevealedLine(revealLine.line);
    // Pierre renders after mount (and again after highlighting): look for the
    // line for a moment.
    let frame = 0;
    let attempts = 0;
    const find = () => {
      const root = fileAreaRef.current?.querySelector('diffs-container')?.shadowRoot;
      const row = root?.querySelector(`[data-line="${revealLine.line}"]`);
      if (row instanceof HTMLElement && lineScroll === 'vertical') {
        scrollCodeLineIntoView(row);
        return;
      }
      if (row) {
        // Vertically only: scrollIntoView would also scroll a long line sideways.
        let node: Element | null = fileAreaRef.current;
        while (node) {
          if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
            const box = node.getBoundingClientRect();
            const rect = row.getBoundingClientRect();
            node.scrollTop += rect.top - (box.top + box.height / 2) + rect.height / 2;
            return;
          }
          node = node.parentElement;
        }
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        return;
      }
      attempts += 1;
      if (attempts < 120) frame = requestAnimationFrame(find);
    };
    frame = requestAnimationFrame(find);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine?.token, revealLine?.line]);
  // Another file drops the mark (cleanups run before the next jump sets one).
  useEffect(() => () => setRevealedLine(null), [filepath]);
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

  // Bring the referenced line into view once Pierre has drawn it. Runs again
  // only when the file or the line changes; a selected comment scrolls itself.
  const selectedAnnotationIdRef = useRef(selectedAnnotationId);
  selectedAnnotationIdRef.current = selectedAnnotationId;
  const lineCount = useMemo(() => contents.split('\n').length, [contents]);
  useEffect(() => {
    const area = fileAreaRef.current;
    if (line == null || !area || selectedAnnotationIdRef.current) return;
    return whenCodeLineRendered(area, line, (lineEl) => {
      if (lineScroll === 'vertical') scrollCodeLineIntoView(lineEl, { smooth: true });
      else lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, { lineCount });
  }, [line, filepath, lineCount, revealKey]);

  const openCommentForRange = useCallback((
    range: { start: number; end: number },
    anchorEl?: HTMLElement,
    anchorRect?: DOMRect,
    initialText?: string,
  ) => {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    setPendingComment({
      range: { start, end },
      ...(initialText !== undefined ? { initialText } : {}),
      anchorEl,
      anchorRect: anchorRect ?? anchorEl?.getBoundingClientRect() ?? lastPointerRectRef.current ?? undefined,
      contextText: `${relativePath} ${lineLabel(start, end)}`,
      originalCode: getLineSlice(contents, start, end),
      // The path alone is not the file: the Inbox passes a basename, so two
      // threads' `index.ts` would share a draft. The contents hash, taken only
      // when the composer opens, keeps one draft per file and range.
      draftKey: `code-file:${filepath}:${hashDraftScope(contents)}:${start}-${end}`,
    });
  }, [contents, filepath, relativePath]);

  // A comment put back by the host: the composer opens on its lines once the
  // first of them is drawn (each request once).
  const reopenedCommentRef = useRef<CodeFileViewProps['reopenComment']>(null);
  useEffect(() => {
    const area = fileAreaRef.current;
    if (!reopenComment || !area || !onAddAnnotation || reopenedCommentRef.current === reopenComment) return;
    const start = Math.min(reopenComment.lineStart, reopenComment.lineEnd);
    const end = Math.max(reopenComment.lineStart, reopenComment.lineEnd);
    if (start < 1 || end > lineCount) return;
    const request = reopenComment;
    return whenCodeLineRendered(area, start, (lineEl) => {
      reopenedCommentRef.current = request;
      openCommentForRange({ start, end }, undefined, lineEl.getBoundingClientRect(), request.text);
    }, { lineCount });
  }, [reopenComment, onAddAnnotation, openCommentForRange, lineCount]);

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

  const renderAnnotation = useCallback((annotation: LineAnnotation<CodeAnnotation[]>) => {
    const group = annotation.metadata;
    if (!group || group.length === 0) return null;
    if (folds) {
      return (
        <CodeCommentFold
          // Pierre keys its rows by position: a line's own key keeps one line's fold from inheriting another's
          // state when a line above loses its last comment.
          key={annotation.lineNumber}
          line={annotation.lineNumber}
          annotations={group}
          store={foldStore}
          onToggle={toggleFold}
          selectedAnnotationId={selectedAnnotationId}
          onSelect={onSelectAnnotation}
          onEdit={onEditAnnotation}
          onDelete={onDeleteAnnotation}
          onLastDelete={focusAfterLastDelete}
          plain={commentCard === 'plain'}
          reopenEdit={reopenEdit}
        />
      );
    }
    return (
      <CodeInlineAnnotation
        annotation={group[0]}
        isSelected={selectedAnnotationId === group[0].id}
        onSelect={onSelectAnnotation}
        onEdit={onEditAnnotation}
        onDelete={onDeleteAnnotation}
        plain={commentCard === 'plain'}
        reopenEdit={reopenEdit}
      />
    );
  }, [commentCard, folds, foldStore, focusAfterLastDelete, onDeleteAnnotation, onEditAnnotation, onSelectAnnotation, reopenEdit, selectedAnnotationId, toggleFold]);

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

  // Pierre maps a press or a click inside an annotation row to the line above it (a line click, a selection): one in
  // a fold (its bubble, its card) is the fold's, never a new comment on that line.
  const pointerInFoldRef = useRef(false);
  const handleLineSelectionEnd = useCallback((range: PierreSelectedLineRange | null) => {
    if (!onAddAnnotation) return;
    if (!range) return;
    if (pointerInFoldRef.current) return;
    if (range.start !== range.end) {
      suppressLineClickUntilRef.current = Date.now() + 300;
    }
    openCommentForRange({ start: range.start, end: range.end }, undefined, lastPointerRectRef.current ?? undefined);
  }, [onAddAnnotation, openCommentForRange]);

  const tokenTargetOf = (props: { tokenText: string; tokenElement: HTMLElement; lineNumber: number; lineCharStart: number }): CodeFileTokenTarget => ({
    tokenText: props.tokenText,
    tokenElement: props.tokenElement,
    lineNumber: props.lineNumber,
    lineCharStart: props.lineCharStart,
  });
  const tokenOptions = onTokenTarget || onTokenNavigate
    ? {
        useTokenTransformer: true,
        onTokenEnter: (props: CodeFileTokenTarget) => onTokenTarget?.('enter', tokenTargetOf(props)),
        onTokenLeave: (props: CodeFileTokenTarget) => onTokenTarget?.('leave', tokenTargetOf(props)),
        onTokenClick: (props: CodeFileTokenTarget, event: MouseEvent) => {
          const target = tokenTargetOf(props);
          onTokenTarget?.('click', target);
          if (onTokenNavigate && (event.metaKey || event.ctrlKey || event.altKey)) {
            suppressLineClickUntilRef.current = Date.now() + 300;
            onTokenNavigate(target);
          }
        },
      }
    : {};

  const handleLineClick = useCallback((props: LineEventBaseProps & { event: PointerEvent }) => {
    if (!onAddAnnotation) return;
    if (Date.now() < suppressLineClickUntilRef.current) return;
    if (pointerInFoldRef.current || isInFold(props.event)) return;
    openCommentForRange(
      { start: props.lineNumber, end: props.lineNumber },
      undefined,
      props.lineElement.getBoundingClientRect(),
    );
  }, [onAddAnnotation, openCommentForRange]);

  const themeCss = folds
    ? `${pierreTheme.css}${FOLD_ROW_CSS}${onAddAnnotation || lineAnnotations.length > 0 ? FOLD_GUTTER_CSS : ''}`
    : pierreTheme.css;

  return (
    <>
      <div
        ref={fileAreaRef}
        className={className}
        onPointerMove={(e) => {
          lastPointerRectRef.current = new DOMRect(e.clientX, e.clientY, 0, 0);
        }}
        // Where focus lands when the last comment's fold goes (programmatic only, never a Tab stop).
        tabIndex={folds ? -1 : undefined}
        style={folds ? { outline: 'none' } : undefined}
        onPointerDownCapture={folds ? (e) => {
          pointerInFoldRef.current = isInFold(e.nativeEvent);
        } : undefined}
        onMouseUp={() => {
          requestAnimationFrame(openCommentForBrowserSelection);
        }}
      >
        <File
          key={filepath}
          file={lang ? { name: displayName, contents, lang } : { name: displayName, contents }}
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
            unsafeCSS: extraCss ? `${themeCss}\n${extraCss}` : themeCss,
            overflow,
            disableFileHeader: true,
            enableLineSelection: true,
            enableGutterUtility: !!onAddAnnotation,
            lineHoverHighlight: onAddAnnotation ? 'line' : 'disabled',
            onLineClick: handleLineClick,
            onLineSelectionEnd: handleLineSelectionEnd,
            ...tokenOptions,
          }}
        />
      </div>
      {pendingComment && onAddAnnotation && (
        <CommentPopover
          anchorEl={pendingComment.anchorEl}
          anchorRect={pendingComment.anchorRect}
          contextText={pendingComment.contextText}
          isGlobal={false}
          skillReferences
          allowImages={allowImages}
          // The words typed for these lines survive a close (Escape, X) and come back when they are chosen again.
          draftKey={pendingComment.draftKey}
          initialText={pendingComment.initialText}
          onSubmit={(text, images) => {
            // The comment just saved shows where it landed: its line's fold opens (the ones there before stay as
            // they were).
            if (folds) openFold([pendingComment.range.end]);
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
          submitLabel={commentSubmitLabel}
          askAILabel={commentAskLabel}
          extraAction={commentExtraAction?.({ filePath: filepath, lineStart: pendingComment.range.start, lineEnd: pendingComment.range.end, originalCode: pendingComment.originalCode })}
          onAskAI={onAskAnnotation ? (question) => {
            onAskAnnotation({
              filePath: filepath,
              lineStart: pendingComment.range.start,
              lineEnd: pendingComment.range.end,
              text: question,
              originalCode: pendingComment.originalCode,
            });
            setPendingComment(null);
            return true;
          } : undefined}
          askAIContext={onAskAnnotation ? { kind: 'selection', label: pendingComment.contextText, text: pendingComment.originalCode } : undefined}
          onClose={() => setPendingComment(null)}
        />
      )}
    </>
  );
};

export const CodeFilePopout: React.FC<CodeFilePopoutProps> = ({
  open,
  onClose,
  filepath,
  contents,
  line,
  lineEnd,
  revealKey,
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
  headerAction,
}) => {
  const [copied, setCopied] = useState(false);

  const displayName = basenameFromPath(filepath);
  const relativePath = normalizeBrowserPath(filepath).replace(/.*\/(?=.*\/)/, '');
  const lineCount = useMemo(() => contents.split('\n').length, [contents]);

  const handleCopy = async () => {
    if (await copyTextToClipboard(contents)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      console.error('Failed to copy');
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
          {headerAction}
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
      <CodeFileView
        filepath={filepath}
        contents={contents}
        line={line}
        lineEnd={lineEnd}
        revealKey={revealKey}
        prerenderedHTML={prerenderedHTML}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onAddAnnotation={onAddAnnotation}
        onEditAnnotation={onEditAnnotation}
        onDeleteAnnotation={onDeleteAnnotation}
        onSelectAnnotation={onSelectAnnotation}
      />
    </PopoutDialog>
  );
};
