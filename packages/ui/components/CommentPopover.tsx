import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ImageAttachment } from '../types';
import { AttachmentsButton } from './AttachmentsButton';
import { submitHint } from '../utils/platform';
import { useDraggable } from '../hooks/useDraggable';

interface CommentPopoverProps {
  /** Element to anchor the popover near (re-reads position on scroll) */
  anchorEl?: HTMLElement;
  /** Static viewport rect to anchor near when no stable DOM element exists */
  anchorRect?: DOMRect;
  /** Truncated selected text shown in header, or empty for global */
  contextText: string;
  /** Whether this is a global comment */
  isGlobal: boolean;
  /** Pre-filled text (for type-to-comment) */
  initialText?: string;
  /** Called on submit with comment text and optional images */
  onSubmit: (text: string, images?: ImageAttachment[]) => void;
  /** Called when popover is closed/cancelled */
  onClose: () => void;
  /** Opt-in: persist text + images across close/reopen, keyed by this string. Cleared on submit. */
  draftKey?: string;
}

const MAX_POPOVER_WIDTH = 384;
const GAP = 8;

// Module-level draft store: survives popover unmount so reopening the same key restores in-progress text.
const draftStore = new Map<string, { text: string; images: ImageAttachment[] }>();

/** Mirrors the latest text + images into `draftStore[draftKey]` so they outlive popover unmount. No-op without a key. */
function useCommentDraftSync(draftKey: string | undefined, text: string, images: ImageAttachment[]) {
  useEffect(() => {
    if (!draftKey) return;
    if (text.trim() || images.length > 0) {
      draftStore.set(draftKey, { text, images });
    } else {
      draftStore.delete(draftKey);
    }
  }, [draftKey, text, images]);
}

function computePosition(anchorRect: DOMRect): { top: number; left: number; flipAbove: boolean; width: number } {
  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const flipAbove = spaceBelow < 280;
  const width = Math.min(MAX_POPOVER_WIDTH, window.innerWidth - 32);

  const top = flipAbove
    ? anchorRect.top - GAP
    : anchorRect.bottom + GAP;

  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - width - 16));

  return { top, left, flipAbove, width };
}

export const CommentPopover: React.FC<CommentPopoverProps> = ({
  anchorEl,
  anchorRect,
  contextText,
  isGlobal,
  initialText = '',
  onSubmit,
  onClose,
  draftKey,
}) => {
  const [mode, setMode] = useState<'popover' | 'dialog'>('popover');
  const initialDraft = draftKey ? draftStore.get(draftKey) : undefined;
  const [text, setText] = useState(initialDraft?.text ?? initialText);
  const [images, setImages] = useState<ImageAttachment[]>(initialDraft?.images ?? []);
  const [position, setPosition] = useState<{ top: number; left: number; flipAbove: boolean; width: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { dragPosition, dragHandleProps, wasDragged, reset: resetDrag } = useDraggable(popoverRef);

  useCommentDraftSync(draftKey, text, images);

  // Reset drag when anchor changes (new annotation) or mode switches
  useEffect(() => { resetDrag(); }, [anchorEl, anchorRect, resetDrag]);
  useEffect(() => { if (mode === 'popover') resetDrag(); }, [mode, resetDrag]);

  // Track anchor position on scroll/resize (popover mode only, not after user drag)
  useEffect(() => {
    if (mode !== 'popover' || wasDragged) return;

    const update = () => {
      const rect = anchorEl?.getBoundingClientRect() ?? anchorRect;
      if (rect) setPosition(computePosition(rect));
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl, anchorRect, mode, wasDragged]);

  // Focus textarea on mount and mode changes
  useEffect(() => {
    const id = setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    }, 0);
    return () => clearTimeout(id);
  }, [mode]);

  // Click-outside for popover mode
  useEffect(() => {
    if (mode !== 'popover') return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      // Don't close if clicking inside a child portal (AttachmentsButton, ImageAnnotator, etc.)
      const el = target as HTMLElement;
      if (el.closest?.('[data-popover-layer]')) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [mode, onClose]);

  const handleSubmit = useCallback(() => {
    if (text.trim() || images.length > 0) {
      if (draftKey) draftStore.delete(draftKey);
      onSubmit(text, images.length > 0 ? images : undefined);
    }
  }, [text, images, onSubmit, draftKey]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (mode === 'dialog') {
        setMode('popover');
      } else {
        onClose();
      }
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const headerLabel = isGlobal
    ? 'Global Comment'
    : contextText
      ? `"${contextText.length > 50 ? contextText.slice(0, 50) + '...' : contextText}"`
      : 'Comment';

  const canSubmit = text.trim().length > 0 || images.length > 0;

  if (mode === 'dialog') {
    return createPortal(
      <div data-comment-popover="true" className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />

        {/* Dialog card */}
        <div
          ref={popoverRef}
          className="relative w-full max-w-xl bg-popover border border-border rounded-xl shadow-2xl flex flex-col"
          style={{
            animation: 'comment-dialog-in 0.15s ease-out',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <style>{`
            @keyframes comment-dialog-in {
              from { opacity: 0; transform: scale(0.95); }
              to { opacity: 1; transform: scale(1); }
            }
          `}</style>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <span className="text-xs text-muted-foreground truncate max-w-[400px]">
              {headerLabel}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMode('popover')}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Collapse"
              >
                <CollapseIcon />
              </button>
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {/* Textarea */}
          <div className="px-4 py-3 flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
              className="w-full bg-transparent text-sm placeholder:text-muted-foreground resize-none focus:outline-none min-h-48 max-h-96 px-1 py-0.5"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border/50">
            <div className="flex items-center gap-2">
              <AttachmentsButton
                images={images}
                onAdd={(img) => setImages((prev) => [...prev, img])}
                onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
                variant="inline"
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-foreground">{submitHint}</span>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {isGlobal ? 'Add' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Popover mode
  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      data-comment-popover="true"
      className="fixed z-[100] bg-popover border border-border rounded-xl shadow-2xl flex flex-col"
      style={dragPosition
        ? { top: dragPosition.top, left: dragPosition.left, width: position.width }
        : {
            top: position.top,
            left: position.left,
            width: position.width,
            ...(position.flipAbove ? { transform: 'translateY(-100%)' } : {}),
            animation: position.flipAbove
              ? 'comment-popover-in-above 0.15s ease-out'
              : 'comment-popover-in 0.15s ease-out',
          }
      }
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes comment-popover-in {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes comment-popover-in-above {
          from { opacity: 0; transform: translateY(-100%) translateY(8px); }
          to { opacity: 1; transform: translateY(-100%); }
        }
      `}</style>

      {/* Header (draggable) */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50" {...dragHandleProps}>
        <span className="text-xs text-muted-foreground truncate max-w-[260px]">
          {headerLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('dialog')}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Expand"
          >
            <ExpandIcon />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* Textarea */}
      <div className="px-3 py-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
          className="w-full bg-transparent text-sm placeholder:text-muted-foreground resize-none focus:outline-none max-h-64 min-h-[4.5rem] px-1 py-0.5"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/50">
        <div className="flex items-center gap-2">
          <AttachmentsButton
            images={images}
            onAdd={(img) => setImages((prev) => [...prev, img])}
            onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
            variant="inline"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground">{submitHint}</span>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {isGlobal ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// Icons

const ExpandIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
  </svg>
);

const CollapseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);
