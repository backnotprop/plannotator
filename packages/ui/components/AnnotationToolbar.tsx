import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { AnnotationType } from "../types";
import { createPortal } from "react-dom";
import { useDismissOnOutsideAndEscape } from "../hooks/useDismissOnOutsideAndEscape";
import { type QuickLabel, getQuickLabels } from "../utils/quickLabels";
import { FloatingQuickLabelPicker } from "./FloatingQuickLabelPicker";

type PositionMode = 'center-above' | 'top-right';

const THUMBS_UP_LABEL: QuickLabel = {
  id: 'thumbs-up',
  emoji: '👍',
  text: 'Looks good',
  color: 'green',
};

const isEditableElement = (node: EventTarget | Element | null): boolean => {
  if (!(node instanceof Element)) return false;
  if (node.matches('input, textarea, select, [role="textbox"]')) return true;
  if (node.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  return (node as HTMLElement).isContentEditable;
};

interface AnnotationToolbarProps {
  element: HTMLElement;
  positionMode: PositionMode;
  onAnnotate: (type: AnnotationType) => void;
  onClose: () => void;
  /** Called when user wants to write a comment (opens CommentPopover in parent) */
  onRequestComment?: (initialChar?: string) => void;
  /** Called when a quick label chip is selected */
  onQuickLabel?: (label: QuickLabel) => void;
  /** Text to copy (for text selection, pass source.text) */
  copyText?: string;
  /** Close toolbar when element scrolls out of viewport */
  closeOnScrollOut?: boolean;
  /** Exit animation state */
  isExiting?: boolean;
  /** Hover callbacks for code block behavior */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  element,
  positionMode,
  onAnnotate,
  onClose,
  onRequestComment,
  onQuickLabel,
  copyText,
  closeOnScrollOut = false,
  isExiting = false,
  onMouseEnter,
  onMouseLeave,
}) => {
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQuickLabels, setShowQuickLabels] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const zapButtonRef = useRef<HTMLButtonElement>(null);
  const quickLabels = useMemo(() => getQuickLabels(), []);

  const handleCopy = async () => {
    let textToCopy = copyText;
    if (!textToCopy) {
      const codeEl = element.querySelector('code');
      textToCopy = codeEl?.textContent || element.textContent || '';
    }
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Reset copied state when element changes
  useEffect(() => {
    setCopied(false);
  }, [element]);

  // Update position on scroll/resize
  useEffect(() => {
    const updatePosition = () => {
      const rect = element.getBoundingClientRect();

      if (closeOnScrollOut && (rect.bottom < 0 || rect.top > window.innerHeight)) {
        onClose();
        return;
      }

      if (positionMode === 'center-above') {
        setPosition({
          top: rect.top - 48,
          left: rect.left + rect.width / 2,
        });
      } else {
        setPosition({
          top: rect.top - 40,
          right: window.innerWidth - rect.right,
        });
      }
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [element, positionMode, closeOnScrollOut, onClose]);

  // Type-to-comment + Alt+N / bare digit quick label shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;

      // When picker is open, let FloatingQuickLabelPicker own all keyboard input
      if (showQuickLabels) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }

      // Alt+N applies quick label (picker closed)
      const isDigit = (e.code >= 'Digit1' && e.code <= 'Digit9') || e.code === 'Digit0';
      if (isDigit && !e.ctrlKey && !e.metaKey && e.altKey) {
        e.preventDefault();
        const digit = parseInt(e.code.slice(5), 10);
        const index = digit === 0 ? 9 : digit - 1;
        if (index < quickLabels.length) {
          onQuickLabel?.(quickLabels[index]);
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Tab" || e.key === "Enter") return;
      if (e.key.length !== 1) return;

      onRequestComment?.(e.key);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onRequestComment, onQuickLabel, quickLabels, showQuickLabels]);

  useDismissOnOutsideAndEscape({
    enabled: !showQuickLabels,
    ref: toolbarRef,
    onDismiss: onClose,
  });

  if (!position) return null;

  const handleTypeSelect = (type: AnnotationType) => {
    if (type === AnnotationType.DELETION) {
      onAnnotate(type);
    } else {
      onRequestComment?.();
    }
  };

  const isCentered = position.left !== undefined;
  const translateX = isCentered ? ' translateX(-50%)' : '';

  const style: React.CSSProperties = {
    top: position.top,
    ...(isCentered
      ? { left: position.left, transform: 'translateX(-50%)' }
      : { right: position.right }),
    animation: isExiting
      ? 'annotation-toolbar-out 0.15s ease-in forwards'
      : 'annotation-toolbar-in 0.15s ease-out',
  };

  return createPortal(
    <div
      ref={toolbarRef}
      className="annotation-toolbar fixed z-[100] bg-popover border border-border rounded-lg shadow-2xl"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <style>{`
        @keyframes annotation-toolbar-in {
          from { opacity: 0; transform: translateY(12px)${translateX}; }
          to { opacity: 1; transform: translateY(0)${translateX}; }
        }
        @keyframes annotation-toolbar-out {
          from { opacity: 1; transform: translateY(0)${translateX}; }
          to { opacity: 0; transform: translateY(8px)${translateX}; }
        }
      `}</style>
      <div className="flex items-center p-1 gap-0.5">
        <ToolbarButton
          onClick={handleCopy}
          icon={copied ? <CheckIcon /> : <CopyIcon />}
          label={copied ? "Copied!" : "Copy"}
          className={copied ? "text-success" : "text-muted-foreground hover:bg-muted hover:text-foreground"}
        />
        <div className="w-px h-5 bg-border mx-0.5" />
        <ToolbarButton
          onClick={() => handleTypeSelect(AnnotationType.DELETION)}
          icon={<TrashIcon />}
          label="Delete"
          className="text-destructive hover:bg-destructive/10"
        />
        <ToolbarButton
          onClick={() => handleTypeSelect(AnnotationType.COMMENT)}
          icon={<CommentIcon />}
          label="Comment"
          className="text-accent hover:bg-accent/10"
        />
        {onQuickLabel && (
          <>
            <ToolbarButton
              ref={zapButtonRef}
              onClick={() => setShowQuickLabels(prev => !prev)}
              icon={<ZapIcon />}
              label="Quick label"
              className={showQuickLabels ? "text-amber-500 bg-amber-500/10" : "text-amber-500 hover:bg-amber-500/10"}
            />
            <ToolbarButton
              onClick={() => onQuickLabel(THUMBS_UP_LABEL)}
              icon={<span className="block w-4 h-4 text-sm leading-4 text-center">👍</span>}
              label="Looks good"
              className="hover:bg-green-500/10"
            />
            {showQuickLabels && zapButtonRef.current && (
              <FloatingQuickLabelPicker
                anchorEl={zapButtonRef.current}
                onSelect={(label) => {
                  setShowQuickLabels(false);
                  onQuickLabel(label);
                }}
                onDismiss={() => setShowQuickLabels(false)}
              />
            )}
          </>
        )}
        <div className="w-px h-5 bg-border mx-0.5" />
        <ToolbarButton
          onClick={onClose}
          icon={<CloseIcon />}
          label="Cancel"
          className="text-muted-foreground hover:bg-muted"
        />
      </div>
    </div>,
    document.body
  );
};

// Icons
const CopyIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const CommentIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
  </svg>
);

const ZapIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const ToolbarButton = React.forwardRef<HTMLButtonElement, {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  className: string;
}>(({ onClick, icon, label, className }, ref) => (
  <button
    ref={ref}
    onClick={onClick}
    title={label}
    className={`p-1.5 rounded-md transition-colors ${className}`}
  >
    {icon}
  </button>
));
