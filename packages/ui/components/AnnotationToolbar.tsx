import React, { useState, useEffect, useRef } from "react";
import { AnnotationType, type ImageAttachment } from "../types";
import { createPortal } from "react-dom";
import { AttachmentsButton } from "./AttachmentsButton";

type PositionMode = 'center-above' | 'top-right';

interface AnnotationToolbarProps {
  element: HTMLElement;
  positionMode: PositionMode;
  onAnnotate: (type: AnnotationType, text?: string, images?: ImageAttachment[]) => void;
  onClose: () => void;
  /** Text to copy (for text selection, pass source.text) */
  copyText?: string;
  /** Close toolbar when element scrolls out of viewport (only in menu step) */
  closeOnScrollOut?: boolean;
  /** Exit animation state */
  isExiting?: boolean;
  /** Hover callbacks for code block behavior */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onLockChange?: (locked: boolean) => void;
  /** Start in input step instead of menu (for comment mode) */
  initialStep?: 'menu' | 'input';
  /** Pre-set annotation type when starting in input step */
  initialType?: AnnotationType;
}

export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  element,
  positionMode,
  onAnnotate,
  onClose,
  copyText,
  closeOnScrollOut = false,
  isExiting = false,
  onMouseEnter,
  onMouseLeave,
  onLockChange,
  initialStep = 'menu',
  initialType,
}) => {
  const [step, setStep] = useState<"menu" | "input">(initialStep);
  const [activeType, setActiveType] = useState<AnnotationType | null>(initialType ?? null);
  const [inputValue, setInputValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleCopy = async () => {
    // Use provided copyText, or fall back to code element / element text
    let textToCopy = copyText;
    if (!textToCopy) {
      const codeEl = element.querySelector('code');
      textToCopy = codeEl?.textContent || element.textContent || '';
    }
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Focus input when entering input step (including on mount with initialStep='input')
  useEffect(() => {
    if (step === "input") {
      // Use setTimeout to ensure DOM is fully ready (portals can have timing issues)
      const timeoutId = setTimeout(() => {
        const input = inputRef.current;
        if (input) {
          input.focus();
          // Move cursor to end (for type-to-comment with pre-populated char)
          input.selectionStart = input.selectionEnd = input.value.length;
        }
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [step, element]); // Also re-run when element changes (new selection)

  // Reset state when element changes
  useEffect(() => {
    setStep(initialStep);
    setActiveType(initialType ?? null);
    setInputValue("");
    setImages([]);
    setCopied(false);
  }, [element, initialStep, initialType]);

  // Notify parent when locked (in input mode)
  useEffect(() => {
    onLockChange?.(step === "input");
  }, [step, onLockChange]);

  // Update position on scroll/resize
  useEffect(() => {
    const updatePosition = () => {
      const rect = element.getBoundingClientRect();

      // Close if scrolled out of viewport (only in menu step if enabled)
      if (closeOnScrollOut && step === "menu" && (rect.bottom < 0 || rect.top > window.innerHeight)) {
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
  }, [element, positionMode, closeOnScrollOut, step, onClose]);

  // Type-to-comment: start typing in menu step → auto-transition to comment input
  useEffect(() => {
    if (step !== "menu") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape closes the toolbar
      if (e.key === "Escape") { onClose(); return; }
      // Ignore if modifier keys are held (except shift for capitals)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Ignore special keys
      if (e.key === "Tab" || e.key === "Enter") return;
      // Only trigger on printable characters (single char keys)
      if (e.key.length !== 1) return;

      // Transition to comment mode with the typed character
      setActiveType(AnnotationType.COMMENT);
      setInputValue(e.key);
      setStep("input");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [step]);

  if (!position) return null;

  const handleTypeSelect = (type: AnnotationType) => {
    if (type === AnnotationType.DELETION) {
      onAnnotate(type);
    } else {
      setActiveType(type);
      setStep("input");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeType && (inputValue.trim() || images.length > 0)) {
      onAnnotate(activeType, inputValue || undefined, images.length > 0 ? images : undefined);
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
      {step === "menu" ? (
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
          <div className="w-px h-5 bg-border mx-0.5" />
          <ToolbarButton
            onClick={onClose}
            icon={<CloseIcon />}
            label="Cancel"
            className="text-muted-foreground hover:bg-muted"
          />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex items-start gap-1.5 p-1.5 pl-3">
          <textarea
            ref={inputRef}
            rows={1}
            className="bg-transparent text-sm min-w-44 max-w-80 max-h-32 placeholder:text-muted-foreground resize-none px-2 py-1.5 focus:outline-none focus:bg-muted/30"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            placeholder="Add a comment..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setStep("menu");
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (inputValue.trim() || images.length > 0) {
                  onAnnotate(activeType!, inputValue || undefined, images.length > 0 ? images : undefined);
                }
              }
            }}
          />
          <AttachmentsButton
            images={images}
            onAdd={(img) => setImages((prev) => [...prev, img])}
            onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
            variant="inline"
          />
          <button
            type="submit"
            disabled={!inputValue.trim() && images.length === 0}
            className="px-[15px] py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity self-stretch"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setStep("menu")}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <CloseIcon small />
          </button>
        </form>
      )}
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

const CloseIcon: React.FC<{ small?: boolean }> = ({ small }) => (
  <svg className={small ? "w-3.5 h-3.5" : "w-4 h-4"} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const ToolbarButton: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  className: string;
}> = ({ onClick, icon, label, className }) => (
  <button
    onClick={onClick}
    title={label}
    className={`p-1.5 rounded-md transition-colors ${className}`}
  >
    {icon}
  </button>
);
