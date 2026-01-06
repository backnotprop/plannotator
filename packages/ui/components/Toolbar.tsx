import React, { useState, useEffect, useRef } from "react";
import { AnnotationType } from "../types";
import { createPortal } from "react-dom";
import { AttachmentsButton } from "./AttachmentsButton";

interface ToolbarProps {
  highlightElement: HTMLElement | null;
  onAnnotate: (type: AnnotationType, text?: string, imagePaths?: string[]) => void;
  onClose: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  highlightElement,
  onAnnotate,
  onClose,
}) => {
  const [step, setStep] = useState<"menu" | "input">("menu");
  const [activeType, setActiveType] = useState<AnnotationType | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (step === "input") inputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    setStep("menu");
    setActiveType(null);
    setInputValue("");
    setImagePaths([]);
  }, [highlightElement]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!highlightElement) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = highlightElement.getBoundingClientRect();
      const toolbarTop = rect.top - 48;

      // If selection scrolled out of viewport, only close if still in menu step
      // Don't close when user is typing - they can scroll back to continue
      if (
        step === "menu" &&
        (rect.bottom < 0 || rect.top > window.innerHeight)
      ) {
        onClose();
        return;
      }

      setPosition({
        top: toolbarTop,
        left: rect.left + rect.width / 2,
      });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [highlightElement, onClose, step]);

  if (!highlightElement || !position) return null;

  const { top, left } = position;

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
    if (activeType && inputValue.trim()) {
      onAnnotate(activeType, inputValue, imagePaths.length > 0 ? imagePaths : undefined);
    }
  };

  return createPortal(
    <div
      className="annotation-toolbar fixed z-[100] bg-popover border border-border rounded-lg shadow-2xl transform -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 duration-150"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {step === "menu" ? (
        <div className="flex items-center p-1 gap-0.5">
          <ToolbarButton
            onClick={() => handleTypeSelect(AnnotationType.DELETION)}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            }
            label="Delete"
            className="text-destructive hover:bg-destructive/10"
          />
          <ToolbarButton
            onClick={() => handleTypeSelect(AnnotationType.COMMENT)}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                />
              </svg>
            }
            label="Comment"
            className="text-accent hover:bg-accent/10"
          />
          <div className="w-px h-5 bg-border mx-0.5" />
          <ToolbarButton
            onClick={onClose}
            icon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            }
            label="Cancel"
            className="text-muted-foreground hover:bg-muted"
          />
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="flex items-start gap-1.5 p-1.5 pl-3"
        >
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
              // Cmd/Ctrl+Enter to submit
              if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                inputValue.trim()
              ) {
                e.preventDefault();
                onAnnotate(activeType!, inputValue, imagePaths.length > 0 ? imagePaths : undefined);
              }
            }}
          />
          <AttachmentsButton
            paths={imagePaths}
            onAdd={(path) => setImagePaths(prev => [...prev, path])}
            onRemove={(path) => setImagePaths(prev => prev.filter(p => p !== path))}
            variant="inline"
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="px-[15px] py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity self-stretch"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setStep("menu")}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </form>
      )}
    </div>,
    document.body
  );
};

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
